import { existsSync } from 'node:fs';
import { program } from './path';
import { CodeError, type Backend, type Hit, type Language, type Op, type Sym } from './code';

/**
 * The programs that answer for body/code.ts, each wrapped as a backend: ast-grep (a tree-sitter
 * parser for each language, the Rayfall grammar among them), universal-ctags, and ripgrep or grep.
 * All come with the image (Dockerfile). One that is missing only narrows what can be answered:
 * `code languages` shows what is left.
 */

export interface Ran { code: number; out: string; err: string }
/** Runs a program to its end and returns what it printed. `input` goes to its standard input. */
export type Runner = (command: string[], input?: string) => Promise<Ran>;
/** Whether a program of this name can be started. */
export type Finder = (program: string) => boolean;

/** No program here prints more than this that is of use; one that goes on is stopped. */
const OUTPUT_MAX = 8 * 1024 * 1024;
const TIME_MAX_MS = 60_000;

async function gather(stream: ReadableStream<Uint8Array>, stop: () => void): Promise<string> {
  const decoder = new TextDecoder(); let text = '';
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length > OUTPUT_MAX) { stop(); break; }
  }
  return text + decoder.decode();
}

export const run: Runner = async (command, input) => {
  // The program is the body's own where it has one: a package's or an organ's, before the image's.
  const child = Bun.spawn([program(command[0]!) ?? command[0]!, ...command.slice(1)], { stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' });
  const stop = (): void => { child.kill('SIGKILL'); };
  const timer = setTimeout(stop, TIME_MAX_MS);
  try {
    const [out, err] = await Promise.all([gather(child.stdout, stop), gather(child.stderr, stop)]);
    return { code: await child.exited, out, err };
  } finally { clearTimeout(timer); }
};
export const find: Finder = (name) => program(name) !== null;

/** Where the image keeps the ast-grep configuration that names the grammars it built (the Dockerfile writes it). */
export const SGCONFIG = '/usr/local/lib/teneral/sgconfig.yml';

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line !== '');
}
function failed(program: string, ran: Ran): CodeError {
  return new CodeError(`${program} failed (exit ${ran.code}): ${ran.err.trim().split('\n').slice(0, 6).join(' | ').slice(0, 600)}`);
}

/** universal-ctags: the symbols of C and Python with the line each body ends on; of other languages without it. */
export function ctags(runner: Runner = run, has: Finder = find): Backend {
  return {
    name: 'ctags', grade: 'syntactic',
    async serves(op: Op, language: Language | null) { return op === 'outline' && language?.ctags !== undefined && has('ctags'); },
    async outline(files: string[], language: Language): Promise<Sym[]> {
      const ran = await runner(['ctags', '--options=NONE', '--output-format=json', '--fields=+neKS', '--sort=no', `--language-force=${language.ctags}`, '-f', '-', '-L', '-'], files.join('\n') + '\n');
      if (ran.code !== 0 && ran.out === '') throw failed('ctags', ran);
      const symbols: Sym[] = [];
      for (const line of lines(ran.out)) {
        let tag: Record<string, unknown>;
        try { tag = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (tag._type !== 'tag' || typeof tag.name !== 'string' || typeof tag.path !== 'string' || typeof tag.line !== 'number') continue;
        const signature = typeof tag.signature === 'string' ? tag.signature : undefined;
        // ctags calls a Python method a member, as it does a field of a C struct; one that takes arguments is a method.
        const kind = tag.kind === 'member' && signature !== undefined ? 'method' : typeof tag.kind === 'string' ? tag.kind : 'symbol';
        symbols.push({
          name: tag.name, kind, path: tag.path, line: tag.line, end: typeof tag.end === 'number' && tag.end >= tag.line ? tag.end : tag.line,
          ...(signature !== undefined ? { signature } : {}), ...(typeof tag.scope === 'string' ? { scope: tag.scope } : {}),
        });
      }
      return symbols;
    },
  };
}

interface Match { text: string; file: string; ruleId?: string; range: { start: { line: number }; end: { line: number } }; metaVariables?: { single?: Record<string, { text: string }> } }

/** ast-grep: code by its shape, in every language it has a grammar for, and the definitions of the languages that list rules for them. */
export function astGrep(runner: Runner = run, has: Finder = find, config: string = process.env.TENERAL_CODE_SGCONFIG ?? SGCONFIG): Backend {
  const usable = (language: Language | null): boolean => language?.astGrep !== undefined && has('ast-grep') && (language.custom !== true || existsSync(config));
  const custom = (language: Language): string[] => language.custom === true ? ['--custom-languages', 'allow', '-c', config] : [];
  const matches = (ran: Ran): Match[] => {
    // It exits with one when nothing matched; anything it printed to stderr with no output is a rule or pattern it refused.
    if (ran.out.trim() === '' && ran.code !== 0 && ran.code !== 1) throw failed('ast-grep', ran);
    if (ran.out.trim() === '' && /error/i.test(ran.err)) throw failed('ast-grep', ran);
    const found: Match[] = [];
    for (const line of lines(ran.out)) { try { found.push(JSON.parse(line) as Match); } catch { /* a warning among the results */ } }
    return found;
  };
  return {
    name: 'ast-grep', grade: 'syntactic',
    async serves(op: Op, language: Language | null) {
      if (op === 'search') return usable(language);
      return op === 'outline' && language?.definitions !== undefined && usable(language);
    },
    async outline(files: string[], language: Language): Promise<Sym[]> {
      const definitions = language.definitions ?? [];
      // JSON is YAML, so each rule is written as a JSON document; its id is its place in the table.
      const rules = definitions.map((definition, at) => JSON.stringify({ id: `d${at}`, language: language.astGrep, rule: definition.rule })).join('\n---\n');
      const ran = await runner(['ast-grep', 'scan', ...custom(language), '--inline-rules', rules, '--json=stream', ...files]);
      const symbols: Sym[] = [];
      for (const match of matches(ran)) {
        const definition = definitions[Number((match.ruleId ?? '').slice(1))];
        if (definition === undefined) continue;
        const read = definition.read?.(match.text) ?? null;
        const name = read?.name ?? match.metaVariables?.single?.NAME?.text;
        if (name === undefined) continue;
        symbols.push({
          name, kind: read?.kind ?? definition.kind, path: match.file, line: match.range.start.line + 1, end: match.range.end.line + 1,
          ...(read?.signature !== undefined ? { signature: read.signature } : {}),
        });
      }
      return symbols;
    },
    async search(pattern: string, language: Language, paths: string[]): Promise<Hit[]> {
      const ask = async (extra: string[]): Promise<Hit[]> => {
        const ran = await runner(['ast-grep', 'run', ...custom(language), '-l', language.astGrep!, ...extra, '--json=stream', ...paths]);
        return matches(ran).map((match) => ({ path: match.file, line: match.range.start.line + 1, end: match.range.end.line + 1, text: match.text }));
      };
      const plain = await ask(['-p', pattern]);
      if (plain.length > 0 || language.inFunction === undefined) return plain;
      // Asked again inside a function. What is matched is the pattern's own node there: the first
      // statement of the block, or the expression in it when the statement is only that expression.
      const wrapped = language.inFunction.wrap(pattern);
      const parsed = await runner(['ast-grep', 'run', ...custom(language), '-l', language.astGrep!, '-p', wrapped, '--debug-query=sexp', '/dev/null']);
      const shape = new RegExp(`\\(${language.inFunction.block} \\((\\w+)(?: (?:\\w+: )?\\((\\w+))?`).exec(parsed.out + parsed.err);
      if (shape === null || shape[1] === 'ERROR') return plain;
      const selector = shape[1] === 'expression_statement' && shape[2] !== undefined ? shape[2] : shape[1]!;
      return ask(['-p', wrapped, '--selector', selector]);
    },
  };
}

/** A whole word, as text: ripgrep, which leaves out what the checkout ignores, or grep where there is no ripgrep. */
export function text(runner: Runner = run, has: Finder = find): Backend {
  const program = (): 'rg' | 'grep' | null => has('rg') ? 'rg' : has('grep') ? 'grep' : null;
  return {
    get name() { return program() ?? 'grep'; },
    grade: 'textual',
    async serves(op: Op) { return op === 'grep' && program() !== null; },
    async grep(word: string, root: string, extensions: string[]): Promise<Hit[]> {
      const command = program() === 'rg'
        ? ['rg', '-n', '-H', '--no-heading', '--null', '-w', '-F', '--color', 'never', '--max-count', '200', ...extensions.flatMap((extension) => ['-g', `*${extension}`]), '--', word, root]
        : ['grep', '-r', '-n', '-H', '-w', '-F', '--null', '--max-count=200', '--exclude-dir=.git', '--exclude-dir=node_modules', ...extensions.map((extension) => `--include=*${extension}`), '--', word, root];
      const ran = await runner(command);
      // Both exit with one when the word is nowhere.
      if (ran.code > 1 && ran.out === '') throw failed(command[0]!, ran);
      const hits: Hit[] = [];
      for (const line of lines(ran.out)) {
        const nul = line.indexOf('\0'); const colon = line.indexOf(':', nul + 1);
        if (nul < 1 || colon === -1) continue;
        const number = Number(line.slice(nul + 1, colon));
        if (Number.isSafeInteger(number)) hits.push({ path: line.slice(0, nul), line: number, text: line.slice(colon + 1) });
      }
      return hits;
    },
  };
}

/** In the order they are asked: the first that serves a question answers it. A language server, when one is added, goes first. */
export function backends(runner: Runner = run, has: Finder = find): Backend[] {
  return [astGrep(runner, has), ctags(runner, has), text(runner, has)];
}
