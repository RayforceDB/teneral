import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Backend, Diagnostic, Hit, Language, Op, Sym } from './code';
import { find, run, type Finder, type Runner } from './code-backends';
import { LspSession } from './lsp';

/**
 * clangd as a backend of body/code.ts: the one that resolves names in C, so its answers are exact.
 *
 * It is started for one question and stopped after it. That is cheap because clangd keeps its
 * index on disk: the first question about a project waits while it is built (seconds for a
 * project the size of Rayforce), every later one reads it back in a fraction of a second, and a
 * file changed since is indexed again before the answer. So there is nothing to keep running and
 * nothing to tell about an edit.
 *
 * An answer given before the index is whole would be a part that looks like the whole: clangd
 * then knows only the open file. So nothing is asked until clangd says the indexing has ended,
 * and when it cannot be waited for, or the project has no compile commands to index by, this
 * backend answers null and the question goes to the next one, whose answer says it is less sure.
 */

interface Entry { directory: string; file: string; command: string }

const COMPILER = /^(cc|gcc|clang|c99|c11|c17)(-\d+)?$/;

/** The compile commands in what `make -n` printed: each line that runs a C compiler with `-c` on a `.c` file. */
export function compileCommands(output: string, root: string): Entry[] {
  const entries = new Map<string, Entry>();
  for (const line of output.split('\n')) {
    const words = line.trim().split(/\s+/);
    if (!COMPILER.test(basename(words[0] ?? '')) || !words.includes('-c')) continue;
    const source = words.find((word, at) => /\.c$/.test(word) && words[at - 1] !== '-o');
    if (source === undefined) continue;
    const file = resolve(root, source);
    // The line as make printed it: clangd reads it as a shell would, quotes and all.
    if (!entries.has(file)) entries.set(file, { directory: root, file, command: line.trim() });
  }
  return [...entries.values()];
}

const newer = (path: string, than: string): boolean => !existsSync(than) || statSync(path).mtimeMs > statSync(than).mtimeMs;

/**
 * A directory holding `compile_commands.json` for the project at `root`, or null when there is no
 * way to make one. It is kept under `cache`, outside the project, and clangd keeps its index beside
 * it: nothing is written into the checkout. The commands are the project's own file when it has
 * one, and otherwise what a dry run of its Makefile would compile; they are made again when their
 * source is newer.
 */
export async function compileDatabase(root: string, cache: string, runner: Runner = run, has: Finder = find): Promise<string | null> {
  const dir = join(cache, createHash('sha1').update(root).digest('hex').slice(0, 16));
  const target = join(dir, 'compile_commands.json');
  const own = [join(root, 'compile_commands.json'), join(root, 'build', 'compile_commands.json')].find((path) => existsSync(path));
  if (own !== undefined) {
    if (newer(own, target)) { mkdirSync(dir, { recursive: true }); copyFileSync(own, target); }
    return dir;
  }
  const makefile = ['GNUmakefile', 'makefile', 'Makefile'].map((name) => join(root, name)).find((path) => existsSync(path));
  if (makefile === undefined || !has('make')) return null;
  if (!newer(makefile, target)) return dir;
  // Nothing is built: -n prints what would run, -B as if nothing were up to date, -k past what fails.
  const ran = await runner(['make', '-C', root, '-n', '-B', '-k']);
  const entries = compileCommands(ran.out, root);
  if (entries.length === 0) return null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, JSON.stringify(entries, null, 1));
  return dir;
}

export interface ClangdOptions {
  runner?: Runner;
  has?: Finder;
  /** Where compile commands and indexes are kept. */
  cache?: string;
  /** The server to start in place of clangd, given the directory of the compile commands: a test's stand-in. */
  command?: (database: string) => string[];
  /** How long the first indexing of a project may take before the question is given up. */
  indexMs?: number;
  /** How long to wait for indexing to begin before concluding that there is no index. */
  beginMs?: number;
}

type Location = { uri?: string; targetUri?: string; range?: { start: { line: number } }; targetSelectionRange?: { start: { line: number } } };

/** Where a whole word begins in a line, in the units of a JavaScript string, which are the protocol's own (UTF-16). */
function column(line: string, word: string): number {
  for (let at = line.indexOf(word); at !== -1; at = line.indexOf(word, at + 1)) {
    const before = line[at - 1] ?? ' ', after = line[at + word.length] ?? ' ';
    if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) return at;
  }
  return -1;
}

export function clangd(options: ClangdOptions = {}): Backend {
  const runner = options.runner ?? run, has = options.has ?? find;
  const cache = options.cache ?? process.env.TENERAL_CODE_CACHE ?? join(homedir(), '.cache', 'teneral-code');
  const indexMs = options.indexMs ?? 90_000, beginMs = options.beginMs ?? 3_000;
  const command = options.command ?? ((database: string) => [
    Bun.which('clangd') ?? 'clangd', `--compile-commands-dir=${database}`, '--background-index',
    // Its usual limits (a thousand references, a hundred results) would cut an answer without saying so.
    '--limit-references=0', '--limit-results=0', '--log=error', `-j=${Math.max(1, Math.min(4, cpus().length))}`,
  ]);

  const lines = new Map<string, string[]>();
  const linesOf = (path: string): string[] => {
    let known = lines.get(path);
    if (known === undefined) { try { known = readFileSync(path, 'utf8').split('\n'); } catch { known = []; } lines.set(path, known); }
    return known;
  };

  /** Starts clangd on the project, waits until its index is whole, and asks; null when that cannot be had. */
  async function ask<T>(root: string, question: (session: LspSession, open: (file: string) => string) => Promise<T | null>): Promise<T | null> {
    const database = await compileDatabase(root, cache, runner, has);
    if (database === null) return null;
    const [program, ...args] = command(database);
    let session: LspSession;
    try {
      session = new LspSession({ command: program!, args, cwd: root, language: 'c', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? homedir() } }, indexMs + 30_000);
    } catch { return null; }
    try {
      let begun = 0, ended = 0; let wake: (() => void) | null = null;
      session.onNotify((message) => {
        if (message.method !== '$/progress') return;
        const params = message.params as { token?: unknown; value?: { kind?: unknown } } | undefined;
        if (params?.token !== 'backgroundIndexProgress') return;
        if (params.value?.kind === 'begin') begun += 1;
        if (params.value?.kind === 'end') ended += 1;
        wake?.();
      });
      const until = async (done: () => boolean, ms: number): Promise<boolean> => {
        const deadline = Date.now() + ms;
        while (!done()) {
          const left = deadline - Date.now();
          if (left <= 0) return false;
          await new Promise<void>((resolveWait) => { wake = resolveWait; setTimeout(resolveWait, Math.min(left, 200)); });
        }
        return true;
      };
      const init = await session.request('initialize', {
        processId: null, rootUri: pathToFileURL(root).href,
        capabilities: { window: { workDoneProgress: true }, textDocument: { publishDiagnostics: {}, definition: {}, references: {} } },
      });
      if (init.error) return null;
      session.notify('initialized', {});
      const opened = new Set<string>();
      const open = (file: string): string => {
        const uri = pathToFileURL(file).href;
        if (!opened.has(uri)) {
          opened.add(uri);
          session.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'c', version: 1, text: linesOf(file).join('\n') } });
        }
        return uri;
      };
      const answer = question(session, open);
      // The indexing begins when the first file is opened. One that never begins means clangd has nothing to index by.
      if (!(await until(() => begun > 0, beginMs))) return null;
      // It may begin again for what the first pass found; the index is whole when every beginning has its end, and stays so for a moment.
      for (;;) {
        if (!(await until(() => ended >= begun, indexMs))) return null;
        const settled = begun;
        await new Promise((resolveWait) => setTimeout(resolveWait, 60));
        if (begun === settled) break;
      }
      indexed?.();
      return await answer;
    } catch { return null; } finally { session.close(); indexed = null; }
  }
  // `question` is started at once, so that it opens its file and the indexing begins; what it asks waits here for the index.
  let indexed: (() => void) | null = null;
  const whenIndexed = (): Promise<void> => new Promise<void>((resolveWait) => { indexed = resolveWait; });

  const place = (location: Location): { path: string; line: number } | null => {
    const uri = location.uri ?? location.targetUri; const start = (location.targetSelectionRange ?? location.range)?.start;
    if (typeof uri !== 'string' || start === undefined || !uri.startsWith('file:')) return null;
    return { path: fileURLToPath(uri), line: start.line + 1 };
  };

  return {
    name: 'clangd', grade: 'exact',
    async serves(op: Op, language: Language | null) {
      return (op === 'definition' || op === 'references' || op === 'diagnostics') && language?.server === 'clangd' && (options.command !== undefined || has('clangd'));
    },
    async definitionAt(file: string, line: number, name: string, root: string): Promise<Sym[] | null> {
      const at = column(linesOf(file)[line - 1] ?? '', name);
      if (at === -1) return null;
      return ask(root, async (session, open) => {
        const uri = open(file);
        await whenIndexed();
        const reply = await session.request('textDocument/definition', { textDocument: { uri }, position: { line: line - 1, character: at } });
        if (reply.error) return null;
        const found = (Array.isArray(reply.result) ? reply.result : reply.result ? [reply.result] : []) as Location[];
        return found.map(place).filter((one) => one !== null).map((one) => ({ name, kind: 'definition', path: one.path, line: one.line, end: one.line }));
      });
    },
    async references(name: string, at: Sym[], root: string): Promise<Hit[] | null> {
      // Asked from where the name is defined. More than a few definitions of one name is a name clangd cannot be asked about as one thing.
      const asked = at.filter((sym) => column(linesOf(sym.path)[sym.line - 1] ?? '', name) !== -1).slice(0, 4);
      if (asked.length === 0 || asked.length < at.length) return null;
      return ask(root, async (session, open) => {
        const uris = asked.map((sym) => open(sym.path));
        await whenIndexed();
        const hits = new Map<string, Hit>();
        for (const [index, sym] of asked.entries()) {
          const reply = await session.request('textDocument/references', {
            textDocument: { uri: uris[index] }, position: { line: sym.line - 1, character: column(linesOf(sym.path)[sym.line - 1]!, name) }, context: { includeDeclaration: true },
          });
          if (reply.error || !Array.isArray(reply.result)) return null;
          for (const location of reply.result as Location[]) {
            const one = place(location);
            if (one !== null) hits.set(`${one.path}:${one.line}`, { path: one.path, line: one.line, text: linesOf(one.path)[one.line - 1] ?? '' });
          }
        }
        return [...hits.values()].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
      });
    },
    async diagnostics(file: string, root: string): Promise<Diagnostic[] | null> {
      return ask(root, async (session, open) => {
        const uri = open(file);
        await whenIndexed();
        // clangd publishes for a file when it has compiled it: after the open, and that may be after the index.
        for (let waited = 0; waited < 30_000; waited += 100) {
          const published = session.diagnostics().filter((message) => (message.params as { uri?: unknown }).uri === uri);
          if (published.length > 0) {
            const last = published[published.length - 1]!.params as { diagnostics?: { range: { start: { line: number; character: number } }; severity?: number; message: string }[] };
            return (last.diagnostics ?? []).map((one) => ({
              line: one.range.start.line + 1, column: one.range.start.character + 1,
              severity: (['error', 'warning', 'note', 'hint'] as const)[(one.severity ?? 1) - 1] ?? 'error', message: one.message.split('\n')[0]!,
            }));
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        return null;
      });
    },
  };
}
