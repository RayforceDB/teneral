import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Code, LANGUAGES, languageOf, projectRoot, type Backend, type Hit, type Sym } from '../../body/code';
import { astGrep, backends, find, grammarConfig, text, type Ran, type Runner } from '../../body/code-backends';
import { answer, parse } from '../../body/code-cli';
import { runBash } from '../../body/tools';
import { commandDirs, program, withCommands } from '../../body/path';

const C = languageOf('a.c')!;
const RAYFALL = languageOf('a.rfl')!;

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'teneral-code-'));
  mkdirSync(join(root, '.git'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** Backends that answer from a table, so the layer is tested without any program. */
function fake(symbols: Sym[], hits: Hit[] = [], extra: Partial<Backend> = {}): Backend[] {
  const outline: Backend = {
    name: 'parser', grade: 'syntactic',
    async serves(op) { return op === 'outline' || op === 'search'; },
    async outline(files) { return symbols.filter((sym) => files.includes(sym.path)); },
    async search(_pattern, _language, paths) { return hits.filter((hit) => paths.some((path) => hit.path.startsWith(path))); },
  };
  const words: Backend = {
    name: 'words', grade: 'textual',
    async serves(op) { return op === 'grep'; },
    async grep(_word, root) { return hits.filter((hit) => hit.path.startsWith(root)); },
  };
  return extra.name === undefined ? [outline, words] : [{ name: 'server', grade: 'exact', async serves() { return false; }, ...extra } as Backend, outline, words];
}

const SOURCE = ['#define LIMIT 4', 'struct box { int size; };', 'static int helper(int a) {', '  return a + 1;', '}', 'int entry(void) {', '  return helper(LIMIT);', '}', ''].join('\n');

function sample(): { root: string; file: string; symbols: Sym[]; hits: Hit[] } {
  const root = project({ 'src/a.c': SOURCE, 'src/b.c': 'int other(void) { return helper(1); }\n', 'notes.txt': 'helper\n' });
  const file = join(root, 'src/a.c');
  const symbols: Sym[] = [
    { name: 'LIMIT', kind: 'macro', path: file, line: 1, end: 1 },
    { name: 'box', kind: 'struct', path: file, line: 2, end: 2 },
    { name: 'size', kind: 'member', path: file, line: 2, end: 2, scope: 'box' },
    { name: 'helper', kind: 'function', path: file, line: 3, end: 5, signature: '(int a)' },
    { name: 'entry', kind: 'function', path: file, line: 6, end: 8, signature: '(void)' },
  ];
  const hits: Hit[] = [
    { path: file, line: 3, text: 'static int helper(int a) {' },
    { path: file, line: 7, text: '  return helper(LIMIT);' },
    { path: join(root, 'src/b.c'), line: 1, text: 'int other(void) { return helper(1); }' },
  ];
  return { root, file, symbols, hits };
}

test('a file is a language by its extension, and an unknown one is none', () => {
  expect(languageOf('src/ops/group.c')?.name).toBe('c');
  expect(languageOf('include/rayforce.h')?.name).toBe('c');
  expect(languageOf('bench/q.RFL')?.name).toBe('rayfall');
  expect(languageOf('a.py')?.name).toBe('python');
  expect(languageOf('run.sh')?.name).toBe('bash');
  expect(languageOf('x.mjs')?.name).toBe('javascript');
  expect(languageOf('body/code.ts')?.name).toBe('typescript');
  expect(languageOf('README.md')).toBeNull();
  // No extension is claimed by two languages: the first would hide the second.
  const all = LANGUAGES.flatMap((language) => language.extensions);
  expect(new Set(all).size).toBe(all.length);
});

test('the root of a project is the nearest checkout above a path', () => {
  const root = project({ 'src/deep/a.c': 'int a;\n' });
  expect(projectRoot(join(root, 'src/deep/a.c'))).toBe(root);
  expect(projectRoot(join(root, 'src'))).toBe(root);
  // A worktree has a file named .git where a checkout has a directory.
  const tree = mkdtempSync(join(tmpdir(), 'teneral-code-tree-'));
  writeFileSync(join(tree, '.git'), 'gitdir: elsewhere\n'); writeFileSync(join(tree, 'a.c'), '');
  expect(projectRoot(join(tree, 'a.c'))).toBe(tree);
});

test('an outline lists what a file defines in its order, says how sure it is, and hides members until asked', async () => {
  const { root, symbols } = sample();
  const code = new Code(fake(symbols));
  const outline = await code.outline('src/a.c', { cwd: root });
  expect(outline.status).toBe(0);
  const lines = outline.text.trimEnd().split('\n');
  expect(lines[0]).toBe('src/a.c: syntactic (parser); 4 of 4 symbols; 1 members and the like hidden, --all shows them');
  expect(lines.slice(1).map((line) => line.trim().replace(/\s+/g, ' '))).toEqual(['1 macro LIMIT', '2 struct box', '3-5 function helper(int a)', '6-8 function entry(void)']);
  expect((await code.outline('src/a.c', { cwd: root, all: true })).text).toContain('member    box::size');
  const functions = await code.outline('src/a.c', { cwd: root, kind: 'function' });
  expect(functions.text.trimEnd().split('\n')).toHaveLength(3);
  const matched = await code.outline('src/a.c', { cwd: root, match: '^ent' });
  expect(matched.text).toContain('entry(void)'); expect(matched.text).not.toContain('helper');
  const capped = await code.outline('src/a.c', { cwd: root, limit: 2 });
  expect(capped.text.split('\n')[0]).toContain('2 of 4 symbols'); expect(capped.text.split('\n')[0]).toContain('narrow with --match');
  expect((await code.outline('src/a.c', { cwd: root, match: 'nothing' })).status).toBe(1);
});

test('an outline of a file in no known language, or of no file, is refused with the reason', async () => {
  const { root, symbols } = sample();
  const code = new Code(fake(symbols));
  await expect(code.outline('notes.txt', { cwd: root })).rejects.toThrow('no known language has this extension');
  await expect(code.outline('src/gone.c', { cwd: root })).rejects.toThrow('no such file');
  await expect(code.outline('src/a.c', { cwd: root, lang: 'cobol' })).rejects.toThrow('unknown language: cobol');
  // With nothing that can list symbols, the answer says so; it does not pretend the file is empty.
  await expect(new Code([]).outline('src/a.c', { cwd: root })).rejects.toThrow('nothing here can list the symbols of c');
});

test('a definition is found across the project from the files that mention the name', async () => {
  const { root, symbols, hits } = sample();
  const code = new Code(fake(symbols, hits));
  const found = await code.definition('helper', '.', { cwd: root });
  expect(found.status).toBe(0);
  expect(found.text).toBe('helper: syntactic (parser); 1 of 1 definitions\nsrc/a.c:3-5  function  helper(int a)\n');
  // b.c mentions the name and defines nothing by it: a use is not a definition.
  expect(found.text).not.toContain('b.c');
  const none = await code.definition('absent', '.', { cwd: root });
  expect(none).toEqual({ status: 1, text: 'no definition of absent found\n' });
});

test('the body of a symbol comes with its line numbers, and a long one is cut with the way to the rest', async () => {
  const { root, symbols, hits } = sample();
  const code = new Code(fake(symbols, hits));
  const body = await code.symbol('helper', '.', { cwd: root });
  expect(body.text).toBe('src/a.c:3-5  function helper(int a)  [syntactic (parser)]\n3  static int helper(int a) {\n4    return a + 1;\n5  }\n');
  // In one file, without a search of the project.
  expect((await code.symbol('entry', 'src/a.c', { cwd: root })).text).toContain('7    return helper(LIMIT);');
  const cut = await code.symbol('helper', '.', { cwd: root, limit: 2 });
  expect(cut.text).toContain("[1 more lines, to 5: sed -n '5,5p' src/a.c]");
  expect(cut.text).not.toContain('5  }');
  expect((await code.symbol('absent', '.', { cwd: root })).status).toBe(1);
});

test('uses of a name are grouped by file, each with the function around it, and say they are only text', async () => {
  const { root, symbols, hits } = sample();
  const code = new Code(fake(symbols, hits));
  const uses = await code.references('helper', '.', { cwd: root });
  expect(uses.status).toBe(0);
  expect(uses.text.split('\n')).toEqual([
    'helper: textual (words): every place the word appears, whatever it names there; 3 of 3 places in 2 files',
    'src/a.c', '      3  [helper] static int helper(int a) {', '      7  [entry] return helper(LIMIT);',
    'src/b.c', '      1  int other(void) { return helper(1); }', '',
  ]);
  const capped = await code.references('helper', '.', { cwd: root, limit: 2 });
  expect(capped.text).toContain('2 of 3 places'); expect(capped.text).toContain('[1 more: give a narrower path');
  expect(capped.text.match(/more:/g)).toHaveLength(1);
  expect(capped.text).not.toContain('src/b.c');
  expect((await new Code(fake(symbols, [])).references('helper', '.', { cwd: root })).status).toBe(1);
});

test('a backend that resolves names is asked from where the name is defined, and its answer is called exact', async () => {
  const { root, file, symbols, hits } = sample();
  const asked: string[] = [];
  const code = new Code(fake(symbols, hits, {
    name: 'server',
    async serves(op, language) { return (op === 'definition' || op === 'references') && language?.name === 'c'; },
    async definitionAt(at, line, name) { asked.push(`definition ${name} ${at.slice(root.length)}:${line}`); return [{ name, kind: 'definition', path: file, line: 3, end: 3 }]; },
    async references(name, from) { asked.push(`references ${name} from ${from.map((sym) => `${sym.kind}@${sym.line}`).join(',')}`); return [{ path: file, line: 7, text: '  return helper(LIMIT);' }]; },
  }));
  // A name alone is listed from the outline; the use of it on one line is resolved.
  expect((await code.definition('helper', '.', { cwd: root })).text).toContain('syntactic (parser)');
  expect((await code.definition('helper', 'src/b.c:1', { cwd: root })).text).toBe('helper as used at src/b.c:1: exact (server)\nsrc/a.c:3\n');
  const uses = await code.references('helper', '.', { cwd: root, lang: 'c' });
  expect(uses.text.split('\n').slice(0, 3)).toEqual(['helper: exact (server); 1 of 1 places in 1 files', 'src/a.c', '      7  [entry] return helper(LIMIT);']);
  // What only matched as text is not mixed into it: b.c is in neither list, the server having answered for C.
  expect(uses.text).not.toContain('textual');
  expect(asked).toEqual(['definition helper /src/b.c:1', 'references helper from function@3']);
});

test('uses in other languages are listed apart from the exact ones, as text', async () => {
  const { root, file, symbols, hits } = sample();
  writeFileSync(join(root, 'tool.py'), 'helper()\n');
  const code = new Code(fake(symbols, [...hits, { path: join(root, 'tool.py'), line: 1, text: 'helper()' }], {
    name: 'server',
    async serves(op, language) { return op === 'references' && language?.name === 'c'; },
    async references() { return [{ path: file, line: 7, text: '  return helper(LIMIT);' }]; },
  }));
  const lines = (await code.references('helper', '.', { cwd: root })).text.split('\n');
  expect(lines[0]).toBe('helper: exact (server); 1 of 1 places in 1 files');
  expect(lines[3]).toStartWith('helper in other languages: textual (words): every place the word appears');
});

test('a backend that resolves names and cannot answer this time leaves the question to the next', async () => {
  const { root, symbols, hits } = sample();
  const code = new Code(fake(symbols, hits, {
    name: 'server',
    async serves(op) { return op === 'definition' || op === 'references'; },
    async definitionAt() { return null; },
    async references() { return null; },
  }));
  expect((await code.definition('helper', 'src/b.c:1', { cwd: root })).text).toBe('helper: syntactic (parser); 1 of 1 definitions\nsrc/a.c:3-5  function  helper(int a)\n');
  // The answer says it is text; it is not passed off as the server's.
  expect((await code.references('helper', '.', { cwd: root, lang: 'c' })).text.split('\n')[0]).toBe('helper: textual (words): every place the word appears, whatever it names there; 3 of 3 places in 2 files');
});

test('what a compiler says about a file is listed, and a file nothing can check is refused', async () => {
  const { root, symbols } = sample();
  const checked = (found: unknown) => new Code(fake(symbols, [], { name: 'server', async serves(op) { return op === 'diagnostics'; }, async diagnostics() { return found as never; } }));
  expect((await checked([{ line: 7, column: 10, severity: 'error', message: "Use of undeclared identifier 'LIMIT'" }]).diagnostics('src/a.c', { cwd: root })).text)
    .toBe("src/a.c: exact (server); 1 of 1 problems\n     7:10  error   Use of undeclared identifier 'LIMIT'\n");
  expect((await checked([]).diagnostics('src/a.c', { cwd: root })).text).toBe('src/a.c: exact (server); no problems\n');
  await expect(checked(null).diagnostics('src/a.c', { cwd: root })).rejects.toThrow('server could not check src/a.c: it has no compile commands');
  await expect(new Code(fake(symbols)).diagnostics('src/a.c', { cwd: root })).rejects.toThrow('nothing here checks c');
});

test('a search by shape needs a language, and reports each match by its first line', async () => {
  const { root, file, symbols } = sample();
  const code = new Code(fake(symbols, [{ path: file, line: 6, end: 8, text: 'int entry(void) {\n  return helper(LIMIT);\n}' }]));
  await expect(code.search('$F($X)', ['src'], { cwd: root })).rejects.toThrow('needs --lang');
  expect((await code.search('$F($X)', ['src'], { cwd: root, lang: 'c' })).text).toBe('syntactic (parser); 1 of 1 matches\nsrc/a.c:6-8  int entry(void) {\n');
  // A file says its own language.
  expect((await code.search('$F($X)', ['src/a.c'], { cwd: root })).status).toBe(0);
  expect((await code.search('$F($X)', ['src/b.c'], { cwd: root })).status).toBe(1);
});

test('what is supported is one line for each language, with a dash where nothing answers', async () => {
  const table = (await new Code(backends(async () => ({ code: 0, out: '', err: '' }), (program) => program === 'grep')).supported()).text.split('\n');
  expect(table[0]!.split(/\s+/)).toEqual(['language', 'files', 'outline', 'search', 'definition', 'references', 'diagnostics']);
  const row = (name: string): string => table.find((line) => line.startsWith(name))!.replace(/\s+/g, ' ');
  expect(row('c ')).toBe('c .c .h .inc - - - grep (textual) -');
  // Without ast-grep Rayfall has nothing that reads it; its uses are still found as text.
  expect(row('rayfall')).toBe('rayfall .rfl - - - grep (textual) -');
});

function canned(replies: Record<string, Ran>): { runner: Runner; ran: { command: string[]; input?: string }[] } {
  const ran: { command: string[]; input?: string }[] = [];
  const runner: Runner = async (command, input) => {
    ran.push({ command, ...(input !== undefined ? { input } : {}) });
    const key = Object.keys(replies).find((one) => command.join(' ').includes(one));
    return key === undefined ? { code: 1, out: '', err: '' } : replies[key]!;
  };
  return { runner, ran };
}
const all = (): boolean => true;

const match = (file: string, text: string, start: number, end: number, more: Record<string, unknown> = {}): string =>
  JSON.stringify({ text, file, range: { start: { line: start }, end: { line: end } }, ...more });

test('ast-grep lists the definitions of a language by its rules, with lines counted from one', async () => {
  const ts = languageOf('a.ts')!;
  const out = [
    match('/s/a.ts', 'function parse() {\n}', 11, 28, { ruleId: 'd0', metaVariables: { single: { NAME: { text: 'parse' } } } }),
    match('/s/a.ts', 'interface Backend {}', 2, 2, { ruleId: `d${ts.definitions!.findIndex((one) => one.kind === 'interface')}`, metaVariables: { single: { NAME: { text: 'Backend' } } } }),
    match('/s/a.ts', 'x', 0, 0, { ruleId: 'd99' }),
  ].join('\n');
  const { runner, ran } = canned({ scan: { code: 0, out, err: '' } });
  expect(await astGrep(runner, all).outline!(['/s/a.ts'], ts)).toEqual([
    { name: 'parse', kind: 'function', path: '/s/a.ts', line: 12, end: 29 },
    { name: 'Backend', kind: 'interface', path: '/s/a.ts', line: 3, end: 3 },
  ]);
  const rules = ran[0]!.command[ran[0]!.command.indexOf('--inline-rules') + 1]!.split('\n---\n').map((rule) => JSON.parse(rule) as { id: string; language: string });
  expect(rules.map((rule) => rule.id)).toEqual(ts.definitions!.map((_, at) => `d${at}`));
  expect(new Set(rules.map((rule) => rule.language))).toEqual(new Set(['typescript']));
});

test('C definitions are listed with their parameters, and a function behind an attribute keeps its own name', async () => {
  const out = [
    match('/r/cow.c', 'void ray_release(ray_t* v) {\n}', 51, 53, { ruleId: 'd0', metaVariables: { single: { NAME: { text: 'ray_release' }, PARAMS: { text: '(ray_t*  v)' } } } }),
    // tree-sitter takes the attribute for the function; the name is read from the text.
    match('/r/cow.c', 'static __attribute__((noinline, section("x"))) ray_t* slow_path(ray_t* v,\n    int n) {\n}', 60, 63, { ruleId: 'd0', metaVariables: { single: { NAME: { text: '__attribute__' }, PARAMS: { text: '((noinline))' } } } }),
    match('/r/cow.c', '#define LIMIT 4', 3, 3, { ruleId: `d${C.definitions!.findIndex((one) => one.kind === 'macro')}`, metaVariables: { single: { NAME: { text: 'LIMIT' } } } }),
  ].join('\n');
  const { runner, ran } = canned({ scan: { code: 0, out, err: '' } });
  expect(await astGrep(runner, all).outline!(['/r/cow.c'], C)).toEqual([
    { name: 'ray_release', kind: 'function', path: '/r/cow.c', line: 52, end: 54, signature: '(ray_t* v)' },
    { name: 'slow_path', kind: 'function', path: '/r/cow.c', line: 61, end: 64, signature: '(ray_t* v, int n)' },
    { name: 'LIMIT', kind: 'macro', path: '/r/cow.c', line: 4, end: 4 },
  ]);
  expect(ran[0]!.command.slice(0, 3)).toEqual(['ast-grep', 'scan', '--inline-rules']);
  expect(C.definitions!.map((one) => one.kind)).toEqual(['function', 'macro', 'struct', 'union', 'enum', 'typedef', 'variable']);
  expect(languageOf('a.py')!.definitions!.map((one) => one.kind)).toEqual(['function', 'class']);
});

test('what ast-grep prints is read match by match, so the functions of a large file are all there', async () => {
  // A runner that hands lines over as they come and keeps none, as the real one does.
  const streaming: Runner = async (_command, _input, each) => {
    for (let n = 0; n < 500; n++) each!(match('/r/big.c', `void f${n}(void) {\n${'  x();\n'.repeat(2000)}}`, n * 10, n * 10 + 5, { ruleId: 'd0', metaVariables: { single: { NAME: { text: `f${n}` } } } }));
    return { code: 0, out: '', err: '' };
  };
  const symbols = await astGrep(streaming, all).outline!(['/r/big.c'], C);
  expect(symbols).toHaveLength(500);
  expect(symbols.at(-1)).toMatchObject({ name: 'f499', line: 4991 });
  // Of a match by shape only its first line is kept.
  const hits = await astGrep(streaming, all).search!('$F()', languageOf('a.py')!, ['/r']);
  expect(hits).toHaveLength(500); expect(hits[0]!.text).toBe('void f0(void) {');
});

test('a Rayfall name is read out of its `set`, and the grammar the body built is named to ast-grep', async () => {
  const config = join(mkdtempSync(join(tmpdir(), 'teneral-code-sg-')), 'sgconfig.yml'); writeFileSync(config, 'ruleDirs: []\n');
  const out = [
    match('/r/q.rfl', '(set n 100)', 1, 1, { ruleId: 'd0' }),
    match('/r/q.rfl', '(set total (fn [x  y]\n  (+ x y)))', 3, 4, { ruleId: 'd0' }),
    match('/r/q.rfl', '(set)', 6, 6, { ruleId: 'd0' }),
  ].join('\n');
  const { runner, ran } = canned({ scan: { code: 0, out, err: '' } });
  const backend = astGrep(runner, all, async () => config);
  expect(await backend.serves('outline', RAYFALL)).toBe(true);
  expect(await backend.outline!(['/r/q.rfl'], RAYFALL)).toEqual([
    { name: 'n', kind: 'variable', path: '/r/q.rfl', line: 2, end: 2 },
    { name: 'total', kind: 'function', path: '/r/q.rfl', line: 4, end: 5, signature: ' [x y]' },
  ]);
  expect(ran[0]!.command.slice(0, 6)).toEqual(['ast-grep', 'scan', '--custom-languages', 'allow', '-c', config]);
  // Without the grammar, Rayfall is not served; a language ast-grep carries still is.
  const bare = astGrep(runner, all, async () => null);
  expect(await bare.serves('outline', RAYFALL)).toBe(false);
  expect(await bare.serves('search', RAYFALL)).toBe(false);
  expect(await bare.serves('search', C)).toBe(true);
  expect(await bare.serves('outline', C)).toBe(true);
  expect(await astGrep(runner, () => false).serves('outline', C)).toBe(false);
});

test('a grammar that is an organ is compiled once, outside every checkout, and named in a configuration of its own', async () => {
  const organs = mkdtempSync(join(tmpdir(), 'teneral-code-organs-')), cache = mkdtempSync(join(tmpdir(), 'teneral-code-grammars-'));
  mkdirSync(join(organs, 'tree-sitter-rayfall', 'src'), { recursive: true });
  writeFileSync(join(organs, 'tree-sitter-rayfall', 'src', 'parser.c'), '/* a parser */\n');
  const built: string[][] = [];
  const compiler: Runner = async (command) => { built.push(command); writeFileSync(command[command.indexOf('-o') + 1]!, 'so'); return { code: 0, out: '', err: '' }; };
  const config = (await grammarConfig(RAYFALL, compiler, (name) => name === 'cc', organs, cache))!;
  expect(config.startsWith(join(cache, 'rayfall-'))).toBe(true);
  expect(readFileSync(config, 'utf8')).toBe(`ruleDirs: []\ncustomLanguages:\n  rayfall:\n    libraryPath: ${join(config, '..', 'grammar.so')}\n    extensions: [rfl]\n    expandoChar: _\n`);
  expect(built).toHaveLength(1);
  expect(built[0]!.slice(0, 4)).toEqual(['cc', '-shared', '-fPIC', '-O2']);
  expect(built[0]!.at(-1)).toBe(join(organs, 'tree-sitter-rayfall', 'src', 'parser.c'));
  // Asked again, it is found; nothing is compiled twice.
  expect(await grammarConfig(RAYFALL, compiler, () => true, organs, cache)).toBe(config);
  expect(built).toHaveLength(1);
  // Without the organ, without a compiler, or with a compiler that fails, there is no grammar, and nothing half built is left.
  expect(await grammarConfig(RAYFALL, compiler, () => true, '', cache)).toBeNull();
  expect(await grammarConfig(RAYFALL, compiler, () => true, join(organs, 'none'), cache)).toBeNull();
  const fresh = mkdtempSync(join(tmpdir(), 'teneral-code-grammars-'));
  expect(await grammarConfig(RAYFALL, compiler, () => false, organs, fresh)).toBeNull();
  await expect(grammarConfig(RAYFALL, async () => ({ code: 1, out: '', err: 'parser.c:1: error' }), () => true, organs, fresh)).rejects.toThrow('cc failed (exit 1)');
  expect(readdirSync(fresh)).toEqual([]);
  // A language ast-grep carries has no grammar to build.
  expect(await grammarConfig(C, compiler, () => true, organs, cache)).toBeNull();
});

test('a C pattern that matches nothing as written is asked again inside a function', async () => {
  const hit = match('/r/heap.c', 'ray_release(v)', 1200, 1200);
  const { runner, ran } = canned({
    '--debug-query=sexp': { code: 0, out: '', err: 'Debug Sexp:\n(translation_unit (function_definition type: (primitive_type) body: (compound_statement (expression_statement (call_expression function: (identifier))))))' },
    '--selector call_expression': { code: 0, out: hit, err: '' },
  });
  expect(await astGrep(runner, all).search!('ray_release($X)', C, ['/r'])).toEqual([{ path: '/r/heap.c', line: 1201, end: 1201, text: 'ray_release(v)' }]);
  expect(ran.map((one) => one.command[one.command.indexOf('-p') + 1])).toEqual(['ray_release($X)', 'void f__() { ray_release($X); }', 'void f__() { ray_release($X); }']);
  // A statement that is not an expression is matched as that statement.
  const statement = canned({
    '--debug-query=sexp': { code: 0, out: '(translation_unit (function_definition body: (compound_statement (if_statement condition: (parenthesized_expression)))))', err: '' },
    '--selector if_statement': { code: 0, out: hit, err: '' },
  });
  expect(await astGrep(statement.runner, all).search!('if ($C) ray_release($X)', C, ['/r'])).toHaveLength(1);
  // A language whose expressions stand alone is asked once.
  const once = canned({});
  expect(await astGrep(once.runner, all).search!('f($X)', languageOf('a.py')!, ['/r'])).toEqual([]);
  expect(once.ran).toHaveLength(1);
});

test('a pattern ast-grep refuses is an error, not an empty answer', async () => {
  const refused = astGrep(async () => ({ code: 8, out: '', err: 'Error: Cannot parse rule\nKind `x` is invalid.' }), all);
  await expect(refused.search!('(', languageOf('a.py')!, ['/r'])).rejects.toThrow('ast-grep failed (exit 8): Error: Cannot parse rule | Kind `x` is invalid.');
});

test('text is searched with ripgrep, or with grep where there is none, and both are read the same way', async () => {
  const out = '/r/src/a.c\x003:static int helper(int a) {\n/r/src/b c.c\x0012:  x = helper(1); /* a:b */\nnoise\n';
  const rg = canned({ rg: { code: 0, out, err: '' } });
  const withRg = text(rg.runner, all);
  expect(withRg.name).toBe('rg');
  expect(await withRg.grep!('helper', '/r', ['.c', '.h'])).toEqual([
    { path: '/r/src/a.c', line: 3, text: 'static int helper(int a) {' },
    { path: '/r/src/b c.c', line: 12, text: '  x = helper(1); /* a:b */' },
  ]);
  expect(rg.ran[0]!.command.slice(-7)).toEqual(['-g', '*.c', '-g', '*.h', '--', 'helper', '/r']);
  const grep = canned({ grep: { code: 0, out, err: '' } });
  const withGrep = text(grep.runner, (program) => program === 'grep');
  expect(withGrep.name).toBe('grep');
  expect(await withGrep.grep!('helper', '/r', ['.c'])).toHaveLength(2);
  expect(grep.ran[0]!.command).toContain('--include=*.c'); expect(grep.ran[0]!.command).toContain('--exclude-dir=.git');
  // Exit one is "nowhere"; more than one with nothing printed is a failure.
  expect(await text(async () => ({ code: 1, out: '', err: '' }), all).grep!('x', '/r', [])).toEqual([]);
  await expect(text(async () => ({ code: 2, out: '', err: 'rg: /r: No such file' }), all).grep!('x', '/r', [])).rejects.toThrow('rg failed (exit 2)');
  expect(await text(async () => ({ code: 0, out: '', err: '' }), () => false).serves('grep', null)).toBe(false);
});

test('the command line: words, options, and a pattern that begins with a dollar', () => {
  expect(parse(['search', '$F($X)', 'src', '--lang', 'c', '--limit=5', '--all'])).toEqual({ words: ['search', '$F($X)', 'src'], flags: { '--lang': 'c', '--limit': '5', '--all': true } });
  expect(parse(['search', '--', '--x', '-y'])).toEqual({ words: ['search', '--x', '-y'], flags: {} });
  expect(parse(['outline', '-h']).flags).toEqual({ '--help': true });
  expect(() => parse(['outline', '--lang'])).toThrow('--lang needs a value');
  expect(() => parse(['outline', '--colour'])).toThrow('unknown option: --colour');
});

test('the command answers with a status: found, nothing found, or a question that could not be asked', async () => {
  const { root, symbols, hits } = sample();
  const code = new Code(fake(symbols, hits));
  expect((await answer(['outline', 'src/a.c'], root, code)).status).toBe(0);
  expect((await answer(['def', 'helper'], root, code)).text).toContain('src/a.c:3-5');
  expect((await answer(['refs', 'helper', 'src'], root, code)).text).toContain('3 of 3 places');
  expect(await answer(['definition', 'absent'], root, code)).toEqual({ status: 1, text: 'no definition of absent found\n' });
  expect(await answer(['outline'], root, code)).toEqual({ status: 2, text: 'code: code outline needs a file; `code --help` shows the forms\n' });
  expect((await answer(['explain', 'x'], root, code)).text).toBe('code: unknown question: explain; `code --help` shows what can be asked\n');
  expect((await answer(['outline', 'notes.txt'], root, code)).status).toBe(2);
  // A regular expression that is not one is the asker's mistake, said plainly.
  expect((await answer(['outline', 'src/a.c', '--match', '('], root, code)).status).toBe(2);
  const help = await answer(['--help'], root, code);
  expect(help.status).toBe(0); expect(help.text).toContain('code outline <file>');
  expect((await answer([], root, code)).status).toBe(2);
});

test('bash finds the command: the body puts its own directory of commands first on the PATH', async () => {
  expect(withCommands({ PATH: '/usr/bin', HOME: '/h' }, ['/body/bin', '/pkg/.bin'])).toEqual({ PATH: '/body/bin:/pkg/.bin:/usr/bin', HOME: '/h' });
  expect(withCommands({}, ['/body/bin'])).toEqual({ PATH: '/body/bin' });
  expect(withCommands({ HOME: '/h' }, [])).toEqual({ HOME: '/h' });
  // After its own commands come the programs of its packages, then those of its organs: an organ's `bin`, then its root.
  const body = mkdtempSync(join(tmpdir(), 'teneral-code-body-')), organs = mkdtempSync(join(tmpdir(), 'teneral-code-organs-'));
  for (const made of [join(body, 'bin'), join(body, 'node_modules', '.bin'), join(organs, 'clangd', 'bin'), join(organs, 'rg')]) mkdirSync(made, { recursive: true });
  expect(commandDirs({ TENERAL_ORGANS: organs }, body)).toEqual([join(body, 'bin'), join(body, 'node_modules', '.bin'), join(organs, 'clangd', 'bin'), join(organs, 'clangd'), join(organs, 'rg')]);
  // A native program lies in the package made for this machine, which comes before the launchers that would need an install script.
  for (const made of [join(body, 'node_modules', '@ast-grep', 'cli'), join(body, 'node_modules', '@ast-grep', 'cli-linux-x64-gnu')]) mkdirSync(made, { recursive: true });
  expect(commandDirs({}, body)).toEqual([join(body, 'bin'), join(body, 'node_modules', '@ast-grep', 'cli-linux-x64-gnu'), join(body, 'node_modules', '.bin')]);
  rmSync(join(body, 'node_modules', '@ast-grep'), { recursive: true });
  expect(commandDirs({}, body)).toEqual([join(body, 'bin'), join(body, 'node_modules', '.bin')]);
  expect(commandDirs({ TENERAL_ORGANS: join(organs, 'gone') }, join(body, 'gone'))).toEqual([]);
  // A program of the body's own is found before one of the same name in the image.
  writeFileSync(join(organs, 'rg', 'grep'), '#!/bin/sh\n', { mode: 0o755 });
  expect(program('grep', { PATH: process.env.PATH, TENERAL_ORGANS: organs })).toBe(join(organs, 'rg', 'grep'));
  expect(program('no-such-program-anywhere', { PATH: process.env.PATH })).toBeNull();
  const launcher = join(import.meta.dir, '..', '..', 'body', 'bin', 'code');
  expect(statSync(launcher).mode & 0o111).not.toBe(0);
  const out = await runBash('command -v code && code --help', mkdtempSync(join(tmpdir(), 'teneral-code-bash-')));
  expect(out).toContain(`exit 0\n${launcher}\n`);
  expect(out).toContain('code outline <file>');
});

// With the body's package and organs at hand, as in the gates the stem runs, these run the programs for real; a bare `bun test` without them skips them.
const real = find('ast-grep') && find('rg');
test.skipIf(!real)('with the real programs: outline, body, definition, uses and a search by shape in C, TypeScript and shell', async () => {
  const root = project({
    'src/a.c': SOURCE,
    'src/b.c': 'int helper(int);\nint other(void) { return helper(1); }\n',
    'lib/tool.ts': 'export interface Shape { side: number }\nexport function area(shape: Shape): number {\n  return shape.side * shape.side;\n}\nexport const double = (n: number): number => n * 2;\n',
    'run.sh': 'start() {\n  echo started\n}\nstart\n',
  });
  const run = (...argv: string[]) => answer(argv, root);
  const outline = await run('outline', 'src/a.c');
  expect(outline.text).toContain('syntactic (ast-grep)');
  expect(outline.text).toMatch(/3-5\s+function\s+helper\(int a\)/);
  expect((await run('symbol', 'entry')).text).toContain('7    return helper(LIMIT);');
  expect((await run('definition', 'helper')).text).toContain('src/a.c:3-5  function  helper(int a)');
  const uses = await run('references', 'helper');
  expect(uses.text).toContain('[entry] return helper(LIMIT);'); expect(uses.text).toContain('src/b.c');
  // A bare call is found although C does not parse it alone.
  const calls = await run('search', 'helper($X)', 'src', '--lang', 'c');
  expect(calls.text).toContain('2 of 2 matches'); expect(calls.text).toContain('src/a.c:7  helper(LIMIT)');
  const ts = await run('outline', 'lib/tool.ts');
  expect(ts.text).toMatch(/1\s+interface\s+Shape/); expect(ts.text).toMatch(/2-4\s+function\s+area/); expect(ts.text).toMatch(/5\s+function\s+double/);
  expect((await run('symbol', 'start', 'run.sh')).text).toContain('2    echo started');
});

test.skipIf(!real || !find('cc') || !existsSync(join(process.env.TENERAL_ORGANS ?? '/nowhere', 'tree-sitter-rayfall')))('with the grammar the body pins and builds: a Rayfall file is outlined and searched', async () => {
  const root = project({ 'q.rfl': ';; totals\n(set n 100)\n(set total (fn [x y]\n  (+ x y)))\n(println (total n 2))\n(select {from: t where: (> price n)})\n' });
  const outline = await answer(['outline', 'q.rfl'], root);
  expect(outline.text).toMatch(/2\s+variable\s+n\n/); expect(outline.text).toMatch(/3-4\s+function\s+total \[x y\]/);
  expect((await answer(['symbol', 'total'], root)).text).toContain('4    (+ x y)))');
  expect((await answer(['search', '(select $$$A)', '.', '--lang', 'rayfall'], root)).text).toContain('q.rfl:6  (select {from: t where: (> price n)})');
});
