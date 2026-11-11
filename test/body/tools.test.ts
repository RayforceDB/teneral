import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBash, TOOLS, type ToolContext } from '../../body/tools';
import { git } from '../../kernel/gates';
import { readEvents } from '../../kernel/journal';
import { makeRepo, writeFiles } from '../kernel/helpers';

function tool(name: string) {
  const found = TOOLS.find((t) => t.spec.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function context(workspace: string, gen = 'gen'): ToolContext {
  return { workspace, journal: join(mkdtempSync(join(tmpdir(), 'teneral-tools-')), 'journal.jsonl'), gen, moltCommit: null };
}

test('the five seed tools exist', () => {
  expect(TOOLS.map((t) => t.spec.name).sort()).toEqual(['bash', 'edit', 'molt', 'read', 'write']);
});

test('write creates parent directories and read returns the content', async () => {
  const ctx = context(mkdtempSync(join(tmpdir(), 'teneral-ws-')));
  await tool('write').run({ path: 'a/b.txt', content: 'hello' }, ctx);
  expect(await tool('read').run({ path: 'a/b.txt' }, ctx)).toBe('hello');
});

test('edit replaces one occurrence and refuses none or several', async () => {
  const ctx = context(mkdtempSync(join(tmpdir(), 'teneral-ws-')));
  await tool('write').run({ path: 'f.txt', content: 'one two two' }, ctx);
  await tool('edit').run({ path: 'f.txt', old: 'one', new: 'ONE' }, ctx);
  expect(readFileSync(join(ctx.workspace, 'f.txt'), 'utf8')).toBe('ONE two two');
  await expect(tool('edit').run({ path: 'f.txt', old: 'two', new: 'x' }, ctx)).rejects.toThrow(/2 times/);
  await expect(tool('edit').run({ path: 'f.txt', old: 'absent', new: 'x' }, ctx)).rejects.toThrow(/not found/);
});

test('bash runs in the workspace and reports the exit code and output', async () => {
  const ctx = context(mkdtempSync(join(tmpdir(), 'teneral-ws-')));
  const out = await tool('bash').run({ command: 'pwd; echo err >&2; exit 3' }, ctx);
  expect(out).toContain('exit 3');
  expect(out).toContain(ctx.workspace);
  expect(out).toContain('err');
});

test('a missing argument is refused by name', async () => {
  const ctx = context(mkdtempSync(join(tmpdir(), 'teneral-ws-')));
  await expect(tool('read').run({}, ctx)).rejects.toThrow(/path/);
  await expect(tool('read').run('{oops', ctx)).rejects.toThrow(/path/);
});

test('long output is cut with a note saying how much is missing', async () => {
  const ctx = context(mkdtempSync(join(tmpdir(), 'teneral-ws-')));
  await tool('write').run({ path: 'big.txt', content: 'x'.repeat(30_000) }, ctx);
  const out = await tool('read').run({ path: 'big.txt' }, ctx);
  expect(out.length).toBeLessThan(21_000);
  expect(out).toContain('10000 more characters');
});

test('molt commits the workspace, journals the request and marks the context', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  const ctx = context(dir, seed);
  writeFiles(dir, { 'body/a.ts': 'b\n' });

  const out = await tool('molt').run({ motive: 'try b' }, ctx);

  const head = git(dir, 'rev-parse', 'HEAD');
  expect(head).not.toBe(seed);
  expect(git(dir, 'status', '--porcelain')).toBe('');
  expect(git(dir, 'log', '-1', '--format=%an %s')).toBe('teneral molt: try b');
  expect(ctx.moltCommit).toBe(head);
  expect(out).toContain(head);
  const events = readEvents(ctx.journal);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'molt.requested', commit: head, motive: 'try b', gen: seed });
});

test('molt with nothing changed is refused', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  const ctx = context(dir, seed);
  await expect(tool('molt').run({ motive: 'nothing' }, ctx)).rejects.toThrow(/nothing to molt/);
  expect(ctx.moltCommit).toBeNull();
});

test('edit writes the new text literally, replacement patterns included', async () => {
  const ctx = context(mkdtempSync(join(tmpdir(), 'teneral-ws-')));
  await tool('write').run({ path: 'f.txt', content: 'a OLD b' }, ctx);
  await tool('edit').run({ path: 'f.txt', old: 'OLD', new: "$& $1 $$ $` $'" }, ctx);
  expect(readFileSync(join(ctx.workspace, 'f.txt'), 'utf8')).toBe("a $& $1 $$ $` $' b");
});

test('edit refuses an empty old instead of prepending', async () => {
  const ctx = context(mkdtempSync(join(tmpdir(), 'teneral-ws-')));
  for (const content of ['', 'ab', 'abc']) {
    await tool('write').run({ path: 'f.txt', content }, ctx);
    await expect(tool('edit').run({ path: 'f.txt', old: '', new: 'x' }, ctx)).rejects.toThrow(/empty/);
    expect(readFileSync(join(ctx.workspace, 'f.txt'), 'utf8')).toBe(content);
  }
});

test('edit with no new text is refused before the file is touched', async () => {
  const ctx = context(mkdtempSync(join(tmpdir(), 'teneral-ws-')));
  await tool('write').run({ path: 'f.txt', content: 'one' }, ctx);
  await expect(tool('edit').run({ path: 'f.txt', old: 'one' }, ctx)).rejects.toThrow(/new/);
  expect(readFileSync(join(ctx.workspace, 'f.txt'), 'utf8')).toBe('one');
});

test('a command that outlives the limit is killed and reported as timed out, with what it printed', () => {
  const out = runBash('echo before; sleep 5; echo late', mkdtempSync(join(tmpdir(), 'teneral-ws-')), 300);
  expect(out).toContain('timed out');
  expect(out).toContain('before');
  expect(out).not.toContain('late');
  expect(out).not.toContain('null');
});
