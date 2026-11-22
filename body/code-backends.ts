import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { program } from './path';
import { CodeError, type Backend, type Hit, type Language, type Op, type Sym } from './code';

/**
 * The programs that answer for body/code.ts, each wrapped as a backend: ast-grep (a tree-sitter
 * parser for each language, the Rayfall grammar among them) and ripgrep, or grep where there is
 * none. None of them is the image's: ast-grep is a package the body takes (body/package.json),
 * ripgrep and the Rayfall grammar are organs it pins (body/organs.json), and they are found as
 * anything the body starts is (body/path.ts). One that is missing only narrows what can be
 * answered: `code languages` shows what is left.
 */

export interface Ran { code: number; out: string; err: string }
/**
 * Runs a program to its end and returns what it printed. `input` goes to its standard input.
 * With `each`, every line it prints is handed over as it comes and none is kept: ast-grep prints
 * the whole text of every match, which for the functions of a large file is many times the file.
 */
export type Runner = (command: string[], input?: string, each?: (line: string) => void) => Promise<Ran>;
/** Whether a program of this name can be started. */
export type Finder = (program: string) => boolean;

/** No program here prints more than this that is of use when all of it is kept; one that goes on is stopped. */
const OUTPUT_MAX = 8 * 1024 * 1024;
const TIME_MAX_MS = 60_000;

async function gather(stream: ReadableStream<Uint8Array>, stop: () => void, each?: (line: string) => void): Promise<string> {
  const decoder = new TextDecoder(); let text = '';
  const lines = (): void => {
    for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n')) { each!(text.slice(0, end)); text = text.slice(end + 1); }
  };
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    if (each !== undefined) lines();
    else if (text.length > OUTPUT_MAX) { stop(); break; }
  }
  text += decoder.decode();
  if (each === undefined) return text;
  lines();
  if (text !== '') each(text);
  return '';
}

export const run: Runner = async (command, input, each) => {
  // The program is the body's own where it has one: a package's or an organ's, before the image's.
  const child = Bun.spawn([program(command[0]!) ?? command[0]!, ...command.slice(1)], { stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' });
  const stop = (): void => { child.kill('SIGKILL'); };
  const timer = setTimeout(stop, TIME_MAX_MS);
  try {
    const [out, err] = await Promise.all([gather(child.stdout, stop, each), gather(child.stderr, stop)]);
    return { code: await child.exited, out, err };
  } finally { clearTimeout(timer); }
};
export const find: Finder = (name) => program(name) !== null;

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line !== '');
}
function failed(program: string, ran: Ran): CodeError {
  return new CodeError(`${program} failed (exit ${ran.code}): ${ran.err.trim().split('\n').slice(0, 6).join(' | ').slice(0, 600)}`);
}

/** Where a grammar the body compiled is kept, with the configuration that names it to ast-grep. */
const grammarCache = (): string => join(process.env.TENERAL_CODE_CACHE ?? join(homedir(), '.cache', 'teneral-code'), 'grammars');

/**
 * The ast-grep configuration for a language whose grammar is an organ, or null when it cannot be
 * had: no such organ, or no C compiler. The parser is compiled once for each version of the organ
 * (its real directory names the archive's hash) and kept outside every checkout.
 */
export async function grammarConfig(language: Language, runner: Runner = run, has: Finder = find, organs: string | undefined = process.env.TENERAL_ORGANS, cache: string = grammarCache()): Promise<string | null> {
  if (language.grammar === undefined || organs === undefined || organs === '') return null;
  let source: string;
  try { source = realpathSync(join(organs, language.grammar.organ, language.grammar.source)); } catch { return null; }
  const dir = join(cache, `${language.name}-${createHash('sha256').update(source).digest('hex').slice(0, 16)}`);
  const config = join(dir, 'sgconfig.yml');
  if (existsSync(config)) return config;
  const compiler = ['cc', 'clang', 'gcc'].find((name) => has(name));
  if (compiler === undefined) return null;
  const tmp = `${dir}.${process.pid}.tmp`;
  mkdirSync(tmp, { recursive: true });
  try {
    const built = await runner([compiler, '-shared', '-fPIC', '-O2', '-I', dirname(source), '-o', join(tmp, 'grammar.so'), source]);
    if (built.code !== 0) throw failed(compiler, built);
    writeFileSync(join(tmp, 'sgconfig.yml'), [
      'ruleDirs: []', 'customLanguages:', `  ${language.astGrep}:`, `    libraryPath: ${join(dir, 'grammar.so')}`,
      `    extensions: [${language.extensions.map((extension) => extension.slice(1)).join(', ')}]`, '    expandoChar: _', '',
    ].join('\n'));
    try { renameSync(tmp, dir); } catch { /* another run built it meanwhile; its build is as good */ }
    return existsSync(config) ? config : null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

interface Match { text: string; file: string; ruleId?: string; range: { start: { line: number }; end: { line: number } }; metaVariables?: { single?: Record<string, { text: string }> } }

/** ast-grep: code by its shape, in every language it has a grammar for, and the definitions of the languages that list rules for them. */
export function astGrep(runner: Runner = run, has: Finder = find, grammar: (language: Language) => Promise<string | null> = (language) => grammarConfig(language, runner, has)): Backend {
  const configs = new Map<string, Promise<string | null>>();
  const configOf = (language: Language): Promise<string | null> => {
    if (!configs.has(language.name)) configs.set(language.name, grammar(language).catch(() => null));
    return configs.get(language.name)!;
  };
  const usable = async (language: Language | null): Promise<boolean> => language?.astGrep !== undefined && has('ast-grep') && (language.grammar === undefined || (await configOf(language)) !== null);
  const custom = async (language: Language): Promise<string[]> => language.grammar === undefined ? [] : ['--custom-languages', 'allow', '-c', (await configOf(language))!];
  /** Runs ast-grep and hands each match to `take` as it is printed; what a runner returns whole is read the same way. */
  const matches = async (command: string[], take: (match: Match) => void): Promise<void> => {
    let any = false;
    const line = (text: string): void => {
      if (text === '') return;
      try { take(JSON.parse(text) as Match); any = true; } catch { /* a warning among the results */ }
    };
    const ran = await runner(command, undefined, line);
    for (const text of lines(ran.out)) line(text);
    // It exits with one when nothing matched; anything else with no match, or an error said with none, is a rule or pattern it refused.
    if (!any && ((ran.code !== 0 && ran.code !== 1) || /error/i.test(ran.err))) throw failed('ast-grep', ran);
  };
  return {
    name: 'ast-grep', grade: 'syntactic',
    async serves(op: Op, language: Language | null) {
      if (op === 'search') return usable(language);
      return op === 'outline' && language?.definitions !== undefined && await usable(language);
    },
    async outline(files: string[], language: Language): Promise<Sym[]> {
      const definitions = language.definitions ?? [];
      // JSON is YAML, so each rule is written as a JSON document; its id is its place in the table.
      const rules = definitions.map((definition, at) => JSON.stringify({ id: `d${at}`, language: language.astGrep, rule: definition.rule })).join('\n---\n');
      const symbols: Sym[] = [];
      await matches(['ast-grep', 'scan', ...await custom(language), '--inline-rules', rules, '--json=stream', ...files], (match) => {
        const definition = definitions[Number((match.ruleId ?? '').slice(1))];
        if (definition === undefined) return;
        const read = definition.read?.(match.text) ?? null;
        const name = read?.name ?? match.metaVariables?.single?.NAME?.text;
        if (name === undefined) return;
        const signature = read?.signature ?? match.metaVariables?.single?.PARAMS?.text.replace(/\s+/g, ' ');
        symbols.push({
          name, kind: read?.kind ?? definition.kind, path: match.file, line: match.range.start.line + 1, end: match.range.end.line + 1,
          ...(signature !== undefined ? { signature } : {}),
        });
      });
      return symbols;
    },
    async search(pattern: string, language: Language, paths: string[]): Promise<Hit[]> {
      const ask = async (extra: string[]): Promise<Hit[]> => {
        const hits: Hit[] = [];
        // Only the first line of a match is shown, so only that much of it is kept.
        await matches(['ast-grep', 'run', ...await custom(language), '-l', language.astGrep!, ...extra, '--json=stream', ...paths], (match) => {
          hits.push({ path: match.file, line: match.range.start.line + 1, end: match.range.end.line + 1, text: match.text.split('\n', 1)[0]!.slice(0, 400) });
        });
        return hits;
      };
      const plain = await ask(['-p', pattern]);
      if (plain.length > 0 || language.inFunction === undefined) return plain;
      // Asked again inside a function. What is matched is the pattern's own node there: the first
      // statement of the block, or the expression in it when the statement is only that expression.
      const wrapped = language.inFunction.wrap(pattern);
      const parsed = await runner(['ast-grep', 'run', ...await custom(language), '-l', language.astGrep!, '-p', wrapped, '--debug-query=sexp', '/dev/null']);
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
  return [astGrep(runner, has), text(runner, has)];
}
