import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { languageOf, type Sym } from '../../body/code';
import { find } from '../../body/code-backends';
import { clangd, compileCommands, compileDatabase } from '../../body/code-clangd';
import { answer } from '../../body/code-cli';

const C = languageOf('a.c')!;
const dir = (name: string): string => mkdtempSync(join(tmpdir(), `teneral-clangd-${name}-`));

const MAKE = [
  "make: Entering directory '/r'",
  'clang -c -Wall -std=c17 -DNAME=\\"x\\" -Iinclude -Isrc -o build/cow.o src/mem/cow.c',
  '/usr/bin/gcc-14 -c -O2 -o build/heap.o src/mem/heap.c',
  'clang -c -o build/cow.o src/mem/cow.c -DAGAIN',
  'clang -o rayforce build/cow.o build/heap.o -lm',
  'echo clang -c nothing.c',
  'rm -f build/x.c',
].join('\n');

test('compile commands are read out of a dry run of make: one for each C file a compiler is run on', () => {
  expect(compileCommands(MAKE, '/r')).toEqual([
    // The line as make printed it, with its quoting: clangd reads it as a shell would.
    { directory: '/r', file: '/r/src/mem/cow.c', command: 'clang -c -Wall -std=c17 -DNAME=\\"x\\" -Iinclude -Isrc -o build/cow.o src/mem/cow.c' },
    { directory: '/r', file: '/r/src/mem/heap.c', command: '/usr/bin/gcc-14 -c -O2 -o build/heap.o src/mem/heap.c' },
  ]);
  expect(compileCommands('', '/r')).toEqual([]);
});

test('the compile commands are kept outside the project, and made again only when the Makefile is newer', async () => {
  const root = dir('root'), cache = dir('cache'); let runs = 0;
  const runner = async (command: string[]) => { runs += 1; expect(command).toEqual(['make', '-C', root, '-n', '-B', '-k']); return { code: 0, out: MAKE, err: '' }; };
  const all = (): boolean => true;
  // No Makefile and no commands of its own: nothing to index by.
  expect(await compileDatabase(root, cache, runner, all)).toBeNull();
  writeFileSync(join(root, 'Makefile'), 'all:\n');
  const database = (await compileDatabase(root, cache, runner, all))!;
  expect(database.startsWith(cache)).toBe(true);
  expect((JSON.parse(readFileSync(join(database, 'compile_commands.json'), 'utf8')) as unknown[]).length).toBe(2);
  expect(existsSync(join(root, 'compile_commands.json'))).toBe(false);
  expect(await compileDatabase(root, cache, runner, all)).toBe(database);
  expect(runs).toBe(1);
  const later = new Date(Date.now() + 60_000); utimesSync(join(root, 'Makefile'), later, later);
  await compileDatabase(root, cache, runner, all);
  expect(runs).toBe(2);
  // A Makefile that compiles no C gives no database, and no make gives none either.
  const other = dir('other'); writeFileSync(join(other, 'Makefile'), 'all:\n');
  expect(await compileDatabase(other, cache, async () => ({ code: 0, out: 'echo done\n', err: '' }), all)).toBeNull();
  expect(await compileDatabase(other, cache, runner, () => false)).toBeNull();
  // The project's own commands are taken as they are.
  const own = dir('own'); mkdirSync(join(own, 'build')); writeFileSync(join(own, 'build', 'compile_commands.json'), '[]');
  const copied = (await compileDatabase(own, cache, runner, all))!;
  expect(readFileSync(join(copied, 'compile_commands.json'), 'utf8')).toBe('[]');
  expect(runs).toBe(2);
});

/**
 * A stand-in for clangd. Like clangd it knows only the open file until its index is whole: it
 * answers one reference before the indexing has ended and three after. `mode` says how the
 * indexing goes: it ends after `delay` ms, it never begins, or it begins and never ends.
 */
function server(mode: 'indexes' | 'never-begins' | 'never-ends', delay = 150): string {
  const path = join(dir('server'), 'server.ts');
  writeFileSync(path, `
let buf=Buffer.alloc(0), done=false, uri='';
const send=(msg)=>{const b=Buffer.from(JSON.stringify({jsonrpc:'2.0',...msg}));process.stdout.write(Buffer.concat([Buffer.from('Content-Length: '+b.length+'\\r\\n\\r\\n'),b]));};
const at=(line)=>({uri,range:{start:{line,character:0},end:{line,character:1}}});
process.stdin.on('data',(chunk)=>{buf=Buffer.concat([buf,chunk]);for(;;){const e=buf.indexOf('\\r\\n\\r\\n');if(e<0)return;const n=Number(/Content-Length: (\\d+)/i.exec(buf.subarray(0,e).toString())[1]);if(buf.length<e+4+n)return;const x=JSON.parse(buf.subarray(e+4,e+4+n).toString());buf=buf.subarray(e+4+n);
if(x.method==='initialize')send({id:x.id,result:{capabilities:{definitionProvider:true,referencesProvider:true}}});
if(x.method==='textDocument/didOpen'&&uri===''){uri=x.params.textDocument.uri;
  send({id:900,method:'window/workDoneProgress/create',params:{token:'backgroundIndexProgress'}});
  send({method:'$/progress',params:{token:'other',value:{kind:'begin'}}});send({method:'$/progress',params:{token:'other',value:{kind:'end'}}});
  if('${mode}'!=='never-begins'){send({method:'$/progress',params:{token:'backgroundIndexProgress',value:{kind:'begin'}}});
    if('${mode}'==='indexes')setTimeout(()=>{done=true;send({method:'$/progress',params:{token:'backgroundIndexProgress',value:{kind:'end'}}});send({method:'textDocument/publishDiagnostics',params:{uri,diagnostics:[{range:{start:{line:1,character:4},end:{line:1,character:9}},severity:2,message:'unused variable\\nnote'}]}});},${delay});}}
if(x.method==='textDocument/references')send({id:x.id,result:done?[at(0),at(1),at(1),{uri:'untitled:x',range:{start:{line:0}}}]:[at(0)]});
if(x.method==='textDocument/definition')send({id:x.id,result:done?[{targetUri:uri,targetSelectionRange:{start:{line:0,character:4}}}]:[]});
}});`);
  return path;
}

function fixture(mode: 'indexes' | 'never-begins' | 'never-ends', makefile = true) {
  const root = dir('project'); mkdirSync(join(root, '.git'));
  const file = join(root, 'a.c'); writeFileSync(file, 'int helper(int a) { return a; }\nint entry(void) { return helper(1); }\n');
  if (makefile) writeFileSync(join(root, 'Makefile'), 'a.o: a.c\n\tcc -c -o a.o a.c\n');
  const backend = clangd({
    cache: dir('cache'), has: () => true, runner: async () => ({ code: 0, out: 'cc -c -o a.o a.c\n', err: '' }),
    command: () => [process.execPath, server(mode)], indexMs: 1500, beginMs: 400,
  });
  const helper: Sym = { name: 'helper', kind: 'function', path: file, line: 1, end: 1 };
  return { root, file, backend, helper };
}

test('clangd is asked only when its index is whole: the answer is the whole one, not the one it had at the start', async () => {
  const f = fixture('indexes');
  expect(await f.backend.serves('references', C)).toBe(true);
  expect(await f.backend.serves('references', languageOf('a.py'))).toBe(false);
  expect(await f.backend.serves('outline', C)).toBe(false);
  // Three places after the index, two of them one line; a place that is not a file is left out.
  expect(await f.backend.references!('helper', [f.helper], f.root, C)).toEqual([
    { path: f.file, line: 1, text: 'int helper(int a) { return a; }' },
    { path: f.file, line: 2, text: 'int entry(void) { return helper(1); }' },
  ]);
  expect(await f.backend.definitionAt!(f.file, 2, 'helper', f.root, C)).toEqual([{ name: 'helper', kind: 'definition', path: f.file, line: 1, end: 1 }]);
  expect(await f.backend.diagnostics!(f.file, f.root, C)).toEqual([{ line: 2, column: 5, severity: 'warning', message: 'unused variable' }]);
});

test('clangd answers nothing, and so leaves the question to the next, when it has no index to answer from', async () => {
  // It never begins to index: there is nothing to index by.
  const none = fixture('never-begins');
  expect(await none.backend.references!('helper', [none.helper], none.root, C)).toBeNull();
  // It begins and does not finish in the time given.
  const slow = fixture('never-ends');
  expect(await slow.backend.references!('helper', [slow.helper], slow.root, C)).toBeNull();
  expect(await slow.backend.diagnostics!(slow.file, slow.root, C)).toBeNull();
  // The project has no compile commands: clangd is not started at all.
  const bare = fixture('indexes', false);
  expect(await bare.backend.references!('helper', [bare.helper], bare.root, C)).toBeNull();
  // The name is not on the line it is said to be defined on, or on the line it is said to be used on.
  const f = fixture('indexes');
  expect(await f.backend.references!('helper', [{ ...f.helper, line: 3 }], f.root, C)).toBeNull();
  expect(await f.backend.references!('absent', [f.helper], f.root, C)).toBeNull();
  expect(await f.backend.definitionAt!(f.file, 1, 'entry', f.root, C)).toBeNull();
}, 20_000);

test('clangd is offered only where there is a clangd', async () => {
  expect(await clangd({ has: () => false }).serves('references', C)).toBe(false);
  expect(await clangd({ has: (program) => program === 'clangd' }).serves('diagnostics', C)).toBe(true);
});

const real = find('clangd') && find('ast-grep') && find('rg') && find('make');
test.skipIf(!real)('with the real clangd: uses across files are exact, a use is resolved, and an error is reported', async () => {
  const root = dir('real'); mkdirSync(join(root, '.git')); mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'Makefile'), 'all: a.o b.o\na.o: src/a.c\n\tcc -c -Isrc -o a.o src/a.c\nb.o: src/b.c\n\tcc -c -Isrc -o b.o src/b.c\n');
  writeFileSync(join(root, 'src/a.h'), 'int helper(int a);\n');
  writeFileSync(join(root, 'src/a.c'), '#include "a.h"\n/* helper is only mentioned here */\nint helper(int a) {\n  return a + 1;\n}\n');
  writeFileSync(join(root, 'src/b.c'), '#include "a.h"\nstatic int local(void) { int helper = 2; return helper; }\nint other(void) { return helper(1) + local(); }\n');
  process.env.TENERAL_CODE_CACHE = dir('real-cache');
  try {
    const uses = await answer(['references', 'helper'], root);
    expect(uses.text.split('\n')[0]).toBe('helper: exact (clangd); 3 of 3 places in 3 files');
    // The comment that mentions the name and the local variable of the same name are not uses of the function.
    expect(uses.text).not.toContain('only mentioned'); expect(uses.text).not.toContain('int helper = 2');
    expect(uses.text).toContain('      3  int other(void) { return helper(1) + local(); }');
    expect((await answer(['definition', 'helper', 'src/b.c:3'], root)).text).toBe('helper as used at src/b.c:3: exact (clangd)\nsrc/a.c:3\n');
    expect((await answer(['diagnostics', 'src/a.c'], root)).text).toBe('src/a.c: exact (clangd); no problems\n');
    writeFileSync(join(root, 'src/a.c'), '#include "a.h"\nint helper(int a) {\n  return a + missing;\n}\n');
    expect((await answer(['diagnostics', 'src/a.c'], root)).text).toContain("3:14  error   Use of undeclared identifier 'missing'");
    expect(await answer(['status'], root)).toMatchObject({ status: 2 });
  } finally { delete process.env.TENERAL_CODE_CACHE; }
}, 60_000);
