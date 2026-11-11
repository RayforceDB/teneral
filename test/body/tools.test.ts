import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashEnv, runBash, TOOLS, type ToolContext } from '../../body/tools';
import { MAX_HOPS, archive, collect, deliver } from '../../kernel/envelope';
import { git } from '../../kernel/gates';
import { readEvents } from '../../kernel/journal';
import { makeRepo, writeFiles } from '../kernel/helpers';

function tool(name: string) {
  const found = TOOLS.find((t) => t.spec.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function context(workspace: string, gen = 'gen'): ToolContext {
  const data = mkdtempSync(join(tmpdir(), 'teneral-tools-'));
  return {
    workspace, journal: join(data, 'journal.jsonl'), gen, moltCommit: null,
    id: 'me', inbox: join(data, 'inbox'), peers: join(data, 'peers.json'),
  };
}

test('the six seed tools exist', () => {
  expect(TOOLS.map((t) => t.spec.name).sort()).toEqual(['bash', 'edit', 'molt', 'read', 'send', 'write']);
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
  await tool('write').run({ path: 'big.txt', content: `HEAD${'x'.repeat(30_000)}TAIL` }, ctx);
  const out = await tool('read').run({ path: 'big.txt' }, ctx);
  expect(out.length).toBeLessThan(21_000);
  expect(out).toContain('[10008 characters dropped here]');
  expect(out.startsWith('HEADxxx')).toBe(true);
  expect(out.endsWith('xxxTAIL')).toBe(true);
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

test('a command that outlives the limit is killed and reported as timed out, with what it printed', async () => {
  const out = await runBash('echo before; sleep 5; echo late', mkdtempSync(join(tmpdir(), 'teneral-ws-')), 300);
  expect(out).toContain('timed out');
  expect(out).toContain('before');
  expect(out).not.toContain('late');
  expect(out).not.toContain('null');
});

test('text at the limit is returned whole', async () => {
  const ctx = context(mkdtempSync(join(tmpdir(), 'teneral-ws-')));
  await tool('write').run({ path: 'fits.txt', content: 'y'.repeat(20_000) }, ctx);
  expect(await tool('read').run({ path: 'fits.txt' }, ctx)).toBe('y'.repeat(20_000));
});

test('the process keeps running while a command runs', async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 20);
  try {
    expect(await runBash('sleep 0.4; echo slept', mkdtempSync(join(tmpdir(), 'teneral-ws-')))).toBe('exit 0\nslept\n');
  } finally {
    clearInterval(timer);
  }
  expect(ticks).toBeGreaterThan(5);
});

test('on timeout everything the command started is killed, not only bash', async () => {
  // The marker makes this run's sleep findable among every process on the machine.
  const marker = `30.${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const survivors = () => Bun.spawnSync(['pgrep', '-f', `sleep ${marker}`]).stdout.toString().trim();
  const running = runBash(`sleep ${marker} & wait`, mkdtempSync(join(tmpdir(), 'teneral-ws-')), 300);
  await Bun.sleep(150);
  expect(survivors()).not.toBe('');

  expect(await running).toContain('timed out');

  for (let i = 0; i < 50 && survivors() !== ''; i++) await Bun.sleep(20);
  expect(survivors()).toBe('');
});

test('endless output is bounded, keeps both ends and still reports the exit', async () => {
  const out = await runBash('echo first; yes | head -c 5000000; echo last; exit 7', mkdtempSync(join(tmpdir(), 'teneral-ws-')));
  expect(out.length).toBeLessThan(21_000);
  expect(out.startsWith('exit 7\nfirst\ny\n')).toBe(true);
  expect(out.endsWith('y\nlast\n')).toBe(true);
  expect(out).toMatch(/\[49\d{5} characters dropped here\]/);
});

test('molt does not depend on the hooks or signing of the repo it runs in', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  writeFiles(dir, { '.git/hooks/pre-commit': '#!/bin/sh\necho hook says no >&2\nexit 1\n' });
  chmodSync(join(dir, '.git/hooks/pre-commit'), 0o755);
  git(dir, 'config', 'commit.gpgsign', 'true');
  git(dir, 'config', 'gpg.program', '/bin/false');
  const ctx = context(dir, seed);
  writeFiles(dir, { 'body/a.ts': 'b\n' });

  await tool('molt').run({ motive: 'hooked' }, ctx);

  expect(ctx.moltCommit).toBe(git(dir, 'rev-parse', 'HEAD'));
  expect(ctx.moltCommit).not.toBe(seed);
});

function withPeer(ctx: ToolContext): string {
  const peerInbox = join(mkdtempSync(join(tmpdir(), 'teneral-peer-')), 'inbox');
  writeFileSync(ctx.peers, JSON.stringify({ bob: peerInbox }));
  return peerInbox;
}

test('send delivers an envelope from this agent to the named peer', async () => {
  const ctx = context('/tmp');
  const peerInbox = withPeer(ctx);
  const out = await tool('send').run({ to: 'bob', text: 'hello bob' }, ctx);
  const [arrival] = collect(peerInbox);
  expect(arrival!.envelope).toMatchObject({ from: 'me', to: 'bob', text: 'hello bob', replyTo: null, hops: 0 });
  expect(out).toContain(arrival!.envelope!.id);
});

test('a reply carries one more hop than the message it answers', async () => {
  const ctx = context('/tmp');
  const peerInbox = withPeer(ctx);
  const file = deliver(ctx.inbox, { v: 1, id: 'q1', from: 'bob', to: 'me', replyTo: null, ts: 't', hops: 2, text: '?' });
  archive(ctx.inbox, file, 'seen');
  await tool('send').run({ to: 'bob', text: 'answer', replyTo: 'q1' }, ctx);
  expect(collect(peerInbox)[0]!.envelope).toMatchObject({ replyTo: 'q1', hops: 3 });
});

test('a reply past the hop limit is refused', async () => {
  const ctx = context('/tmp');
  const peerInbox = withPeer(ctx);
  const file = deliver(ctx.inbox, { v: 1, id: 'q2', from: 'bob', to: 'me', replyTo: null, ts: 't', hops: MAX_HOPS, text: '?' });
  archive(ctx.inbox, file, 'seen');
  await expect(tool('send').run({ to: 'bob', text: 'again', replyTo: 'q2' }, ctx)).rejects.toThrow(/ask your owner/);
  expect(collect(peerInbox)).toEqual([]);
});

test('an unknown peer or an unknown message to reply to is refused', async () => {
  const ctx = context('/tmp');
  withPeer(ctx);
  await expect(tool('send').run({ to: 'carol', text: 'hi' }, ctx)).rejects.toThrow(/unknown peer "carol".*bob/);
  await expect(tool('send').run({ to: 'bob', text: 'hi', replyTo: 'never-seen' }, ctx)).rejects.toThrow(/no received message/);
});

const ws = () => mkdtempSync(join(tmpdir(), 'teneral-ws-'));
const isWellFormed = (s: string) => s === s.toWellFormed();

test('the cut never falls inside a character: an emoji at either edge is kept whole or dropped whole', async () => {
  const ctx = context(ws());
  for (const lead of ['', 'a']) {
    // 10,000 is where the head ends and where the tail begins; the lead shifts the pairs across both cuts.
    await tool('write').run({ path: 'emoji.txt', content: lead + '😀'.repeat(20_000) }, ctx);
    const out = await tool('read').run({ path: 'emoji.txt' }, ctx);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toContain('characters dropped here');
    expect(out.length).toBeLessThan(21_000);
  }
});

test('a background job that keeps the output open does not hold the call: bash exited, so its exit is reported', async () => {
  const marker = `30.${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const started = Date.now();
  const out = await runBash(`sleep ${marker} & echo hi`, ws());
  try {
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out.startsWith('exit 0\nhi\n')).toBe(true);
    expect(out).not.toContain('timed out');
    expect(out).toContain('still running');
    // It is left running: only a timeout kills.
    expect(Bun.spawnSync(['pgrep', '-f', `sleep ${marker}`]).stdout.toString().trim()).not.toBe('');
  } finally {
    Bun.spawnSync(['pkill', '-f', `sleep ${marker}`]);
  }
});

test('a job that left the process group cannot hold the call either', async () => {
  const marker = `30.${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const started = Date.now();
  const out = await runBash(`setsid sleep ${marker} & echo hi`, ws());
  Bun.spawnSync(['pkill', '-f', `sleep ${marker}`]);
  expect(Date.now() - started).toBeLessThan(3000);
  expect(out.startsWith('exit 0\nhi\n')).toBe(true);
});

test('a timeout does not wait for a job that escaped the kill and still holds the output', async () => {
  const marker = `30.${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const started = Date.now();
  const out = await runBash(`setsid sleep ${marker} & sleep 20`, ws(), 300);
  Bun.spawnSync(['pkill', '-f', `sleep ${marker}`]);
  expect(Date.now() - started).toBeLessThan(3000);
  expect(out).toContain('timed out');
});

test('a command with no output, and one that exits before the limit, report the plain exit', async () => {
  expect(await runBash('true', ws())).toBe('exit 0\n');
  expect(await runBash('exit 4', ws(), 5000)).toBe('exit 4\n');
});

test('bytes that are not UTF-8 come back as well-formed text', async () => {
  const out = await runBash("printf 'a\\377b\\355\\240\\200c'", ws());
  expect(out.startsWith('exit 0\na')).toBe(true);
  expect(out.endsWith('c')).toBe(true);
  expect(isWellFormed(out)).toBe(true);
});

test('bash does not see the API key; the rest of the environment is passed on', async () => {
  expect(bashEnv({ HOME: '/h', TENERAL_API_KEY: 'secret', TENERAL_MODEL: 'm' })).toEqual({ HOME: '/h', TENERAL_MODEL: 'm' });
  const before = process.env.TENERAL_API_KEY;
  process.env.TENERAL_API_KEY = 'secret-key';
  process.env.TENERAL_TEST_PASSED_ON = 'yes';
  try {
    const out = await runBash('echo "key=${TENERAL_API_KEY:-unset} other=$TENERAL_TEST_PASSED_ON home=$HOME"', ws());
    expect(out).toBe(`exit 0\nkey=unset other=yes home=${process.env.HOME}\n`);
  } finally {
    delete process.env.TENERAL_TEST_PASSED_ON;
    if (before === undefined) delete process.env.TENERAL_API_KEY; else process.env.TENERAL_API_KEY = before;
  }
});

test('edit counts overlapping matches as ambiguous', async () => {
  const ctx = context(ws());
  await tool('write').run({ path: 'f.txt', content: 'aaa' }, ctx);
  await expect(tool('edit').run({ path: 'f.txt', old: 'aa', new: 'b' }, ctx)).rejects.toThrow(/2 times/);
  expect(readFileSync(join(ctx.workspace, 'f.txt'), 'utf8')).toBe('aaa');
});

test('edit refuses a file that is not UTF-8 and leaves every byte as it was', async () => {
  const ctx = context(ws());
  const bytes = Buffer.from([0x6f, 0x6e, 0x65, 0xff, 0x74, 0x77, 0x6f]);
  writeFileSync(join(ctx.workspace, 'bin.dat'), bytes);
  await expect(tool('edit').run({ path: 'bin.dat', old: 'one', new: 'ONE' }, ctx)).rejects.toThrow(/UTF-8/);
  expect(readFileSync(join(ctx.workspace, 'bin.dat')).equals(bytes)).toBe(true);
});

test('molt refuses a workspace that does not descend from the running generation, before committing anything', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n' });
  git(dir, 'checkout', '-q', '--orphan', 'elsewhere');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'unrelated');
  const unrelated = git(dir, 'rev-parse', 'HEAD');
  writeFiles(dir, { 'body/a.ts': 'b\n' });
  const ctx = context(dir, seed);

  await expect(tool('molt').run({ motive: 'astray' }, ctx)).rejects.toThrow(/different line of history.*git log/s);

  expect(ctx.moltCommit).toBeNull();
  expect(git(dir, 'rev-parse', 'HEAD')).toBe(unrelated);
  expect(readEvents(ctx.journal)).toEqual([]);
});

test('a molt says which files it changes from the running generation', async () => {
  const { dir, seed } = makeRepo({ 'body/a.ts': 'a\n', 'body/gone.ts': 'x\n' });
  const ctx = context(dir, seed);
  writeFiles(dir, { 'body/a.ts': 'b\n', 'stray.log': 'oops\n' });
  git(dir, 'rm', '-q', 'body/gone.ts');

  const out = await tool('molt').run({ motive: 'list' }, ctx);

  expect(out).toContain('M\tbody/a.ts');
  expect(out).toContain('D\tbody/gone.ts');
  expect(out).toContain('A\tstray.log');
});

test('the molt description says untracked files are committed too', () => {
  expect(tool('molt').spec.description).toMatch(/untracked/);
});

test('send names the peers file when it is malformed', async () => {
  const ctx = context(ws());
  writeFileSync(ctx.peers, '{ not json');
  await expect(tool('send').run({ to: 'bob', text: 'hi' }, ctx)).rejects.toThrow(ctx.peers);
  writeFileSync(ctx.peers, '["bob"]');
  await expect(tool('send').run({ to: 'bob', text: 'hi' }, ctx)).rejects.toThrow(ctx.peers);
});
