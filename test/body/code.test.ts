import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Code, LANGUAGES, languageOf, projectRoot, type Backend, type Hit, type Sym } from '../../body/code';
import { astGrep, backends, ctags, find, text, type Ran, type Runner } from '../../body/code-backends';
import { answer, parse } from '../../body/code-cli';
import { runBash, withCommands } from '../../body/tools';

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
  expect(capped.text).not.toContain('src/b.c');
  expect((await new Code(fake(symbols, [])).references('helper', '.', { cwd: root })).status).toBe(1);
});

test('a backend that resolves names answers first, and its answer is called exact', async () => {
  const { root, file, symbols, hits } = sample();
  const asked: string[] = [];
  const code = new Code(fake(symbols, hits, {
    name: 'server',
    async serves(op, language) { return (op === 'definition' || op === 'references') && language?.name === 'c'; },
    async definition(name) { asked.push(`definition ${name}`); return [{ name, kind: 'function', path: file, line: 3, end: 5 }]; },
    async references(name) { asked.push(`references ${name}`); return [{ path: file, line: 7, text: '  return helper(LIMIT);' }]; },
  }));
  expect((await code.definition('helper', '.', { cwd: root, lang: 'c' })).text).toBe('helper: exact (server); 1 of 1 definitions\nsrc/a.c:3-5  function  helper\n');
  const uses = await code.references('helper', '.', { cwd: root, lang: 'c' });
  expect(uses.text.split('\n')[0]).toBe('helper: exact (server); 1 of 1 places in 1 files');
  expect(asked).toEqual(['definition helper', 'references helper']);
});

test('a backend that resolves names and cannot answer this time leaves the question to the next', async () => {
  const { root, symbols, hits } = sample();
  const code = new Code(fake(symbols, hits, {
    name: 'server',
    async serves(op) { return op === 'definition'; },
    async definition() { return null; },
  }));
  expect((await code.definition('helper', '.', { cwd: root, lang: 'c' })).text).toContain('syntactic (parser)');
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
  const table = (await new Code(backends(async () => ({ code: 0, out: '', err: '' }), (program) => program === 'ctags' || program === 'grep')).supported()).text.split('\n');
  expect(table[0]!.split(/\s+/)).toEqual(['language', 'files', 'outline', 'search', 'definition', 'references']);
  const row = (name: string): string => table.find((line) => line.startsWith(name))!.replace(/\s+/g, ' ');
  expect(row('c ')).toBe('c .c .h .inc ctags (syntactic) - ctags (syntactic) grep (textual)');
  // Without ast-grep Rayfall has nothing that reads it; its uses are still found as text.
  expect(row('rayfall')).toBe('rayfall .rfl - - - grep (textual)');
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

test('ctags is given the files on its input and its tags are read as symbols', async () => {
  const tags = [
    { _type: 'tag', name: 'ray_release', path: '/r/cow.c', line: 52, kind: 'function', signature: '(ray_t * v)', end: 54 },
    { _type: 'tag', name: 'size', path: '/r/cow.c', line: 9, kind: 'member', scope: 'box', scopeKind: 'struct' },
    { _type: 'tag', name: 'run', path: '/r/a.py', line: 3, kind: 'member', signature: '(self)', scope: 'Job', end: 4 },
    { _type: 'ptag', name: 'JSON_OUTPUT_VERSION' },
  ].map((tag) => JSON.stringify(tag)).join('\n') + '\nnot json\n';
  const { runner, ran } = canned({ ctags: { code: 0, out: tags, err: '' } });
  const backend = ctags(runner, all);
  expect(await backend.serves('outline', C)).toBe(true);
  expect(await backend.serves('outline', RAYFALL)).toBe(false);
  expect(await backend.serves('search', C)).toBe(false);
  expect(await ctags(runner, () => false).serves('outline', C)).toBe(false);
  expect(await backend.outline!(['/r/cow.c', '/r/a.py'], C)).toEqual([
    { name: 'ray_release', kind: 'function', path: '/r/cow.c', line: 52, end: 54, signature: '(ray_t * v)' },
    { name: 'size', kind: 'member', path: '/r/cow.c', line: 9, end: 9, scope: 'box' },
    // A member that takes arguments is a method, not a field.
    { name: 'run', kind: 'method', path: '/r/a.py', line: 3, end: 4, signature: '(self)', scope: 'Job' },
  ]);
  expect(ran[0]!.input).toBe('/r/cow.c\n/r/a.py\n');
  expect(ran[0]!.command).toContain('--language-force=C');
  // The owner's own ctags configuration is not read.
  expect(ran[0]!.command).toContain('--options=NONE');
  await expect(ctags(async () => ({ code: 1, out: '', err: 'ctags: unknown option' }), all).outline!(['/r/a.c'], C)).rejects.toThrow('ctags failed (exit 1): ctags: unknown option');
});

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

test('a Rayfall name is read out of its `set`, and the grammar the image built is named to ast-grep', async () => {
  const config = join(mkdtempSync(join(tmpdir(), 'teneral-code-sg-')), 'sgconfig.yml'); writeFileSync(config, 'ruleDirs: []\n');
  const out = [
    match('/r/q.rfl', '(set n 100)', 1, 1, { ruleId: 'd0' }),
    match('/r/q.rfl', '(set total (fn [x  y]\n  (+ x y)))', 3, 4, { ruleId: 'd0' }),
    match('/r/q.rfl', '(set)', 6, 6, { ruleId: 'd0' }),
  ].join('\n');
  const { runner, ran } = canned({ scan: { code: 0, out, err: '' } });
  const backend = astGrep(runner, all, config);
  expect(await backend.serves('outline', RAYFALL)).toBe(true);
  expect(await backend.outline!(['/r/q.rfl'], RAYFALL)).toEqual([
    { name: 'n', kind: 'variable', path: '/r/q.rfl', line: 2, end: 2 },
    { name: 'total', kind: 'function', path: '/r/q.rfl', line: 4, end: 5, signature: ' [x y]' },
  ]);
  expect(ran[0]!.command.slice(0, 6)).toEqual(['ast-grep', 'scan', '--custom-languages', 'allow', '-c', config]);
  // Without the grammar, Rayfall is not served; a language ast-grep carries still is.
  const bare = astGrep(runner, all, join(config, 'missing'));
  expect(await bare.serves('outline', RAYFALL)).toBe(false);
  expect(await bare.serves('search', RAYFALL)).toBe(false);
  expect(await bare.serves('search', C)).toBe(true);
  // C has no rules for definitions here: ctags lists them, with where each ends.
  expect(await bare.serves('outline', C)).toBe(false);
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
  expect(withCommands({ PATH: '/usr/bin', HOME: '/h' }, '/body/bin')).toEqual({ PATH: '/body/bin:/usr/bin', HOME: '/h' });
  expect(withCommands({}, '/body/bin')).toEqual({ PATH: '/body/bin' });
  const launcher = join(import.meta.dir, '..', '..', 'body', 'bin', 'code');
  expect(statSync(launcher).mode & 0o111).not.toBe(0);
  const out = await runBash('command -v code && code --help', mkdtempSync(join(tmpdir(), 'teneral-code-bash-')));
  expect(out).toContain(`exit 0\n${launcher}\n`);
  expect(out).toContain('code outline <file>');
});

// With the programs of the image present these run them for real; a checkout without them (the CI of the species) skips them.
const real = find('ctags') && find('ast-grep') && find('rg');
test.skipIf(!real)('with the real programs: outline, body, definition, uses and a search by shape in C, TypeScript and shell', async () => {
  const root = project({
    'src/a.c': SOURCE,
    'src/b.c': 'int helper(int);\nint other(void) { return helper(1); }\n',
    'lib/tool.ts': 'export interface Shape { side: number }\nexport function area(shape: Shape): number {\n  return shape.side * shape.side;\n}\nexport const double = (n: number): number => n * 2;\n',
    'run.sh': 'start() {\n  echo started\n}\nstart\n',
  });
  const run = (...argv: string[]) => answer(argv, root);
  const outline = await run('outline', 'src/a.c');
  expect(outline.text).toContain('syntactic (ctags)');
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

test.skipIf(!real || !find('ast-grep') || !Bun.file('/usr/local/lib/teneral/sgconfig.yml').size)('with the grammar of the image: a Rayfall file is outlined and searched', async () => {
  const root = project({ 'q.rfl': ';; totals\n(set n 100)\n(set total (fn [x y]\n  (+ x y)))\n(println (total n 2))\n(select {from: t where: (> price n)})\n' });
  const outline = await answer(['outline', 'q.rfl'], root);
  expect(outline.text).toMatch(/2\s+variable\s+n\n/); expect(outline.text).toMatch(/3-4\s+function\s+total \[x y\]/);
  expect((await answer(['symbol', 'total'], root)).text).toContain('4    (+ x y)))');
  expect((await answer(['search', '(select $$$A)', '.', '--lang', 'rayfall'], root)).text).toContain('q.rfl:6  (select {from: t where: (> price n)})');
});
