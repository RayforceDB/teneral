import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOLS } from '../../body/tools';
import { endedJobs, jobHistory, stopPreviousJobs } from '../../body/jobs';
import { readEvents } from '../../brain/journal';

function tool(name: string) {
  const found = TOOLS.find((t) => t.spec.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'teneral-jobs-'));
  return { dir, ctx: { workspace: dir, journal: join(dir, 'journal.jsonl'), gen: 'g1', mutationCommit: null, id: 'mica', inbox: join(dir, 'inbox'), peers: join(dir, 'peers.json'), soul: dir } };
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (!alive(pid)) return true;
    await Bun.sleep(10);
  }
  return false;
}

test('a surviving bash group is named, listed and stopped by identity after restart', async () => {
  const { dir, ctx } = setup();
  const marker = `job-${Date.now()}-${Math.random()}`;
  const out = await tool('bash').run({ name: 'fixture', command: `echo ${marker}; sleep 300 >/dev/null 2>&1 & echo $! > pid` }, ctx);
  expect(out).toContain('background job fixture');
  const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
  const listed = await tool('jobs').run({ action: 'list' }, { ...ctx, gen: 'g2' });
  expect(listed).toContain('fixture: running');
  expect(await tool('jobs').run({ action: 'stop', name: 'fixture' }, { ...ctx, gen: 'g2' })).toBe('fixture: stopped');
  expect(await gone(pid)).toBe(true);
  expect(jobHistory(readEvents(ctx.journal)).get('fixture')?.state).toBe('stopped');
});

test('a previous generation group is stopped before the next generation works', async () => {
  const { ctx } = setup();
  await tool('bash').run({ name: 'old-generation', command: 'sleep 300 >/dev/null 2>&1 & echo $! > pid' }, ctx);
  const pid = Number(readFileSync(join(ctx.workspace, 'pid'), 'utf8'));
  expect(stopPreviousJobs(ctx.journal, 'g2')).toEqual(['old-generation']);
  expect(await gone(pid)).toBe(true);
  expect(jobHistory(readEvents(ctx.journal)).get('old-generation')?.reason).toBe('generation-exit');
});

test('same-generation restart lists rather than silently killing its jobs', async () => {
  const { ctx } = setup();
  try {
    await tool('bash').run({ name: 'same-generation', command: 'sleep 300 >/dev/null 2>&1 & echo $! > pid' }, ctx);
    const pid = Number(readFileSync(join(ctx.workspace, 'pid'), 'utf8'));
    expect(stopPreviousJobs(ctx.journal, ctx.gen)).toEqual([]);
    expect(alive(pid)).toBe(true);
    expect(await tool('jobs').run({ action: 'list' }, ctx)).toContain('same-generation: running');
    await tool('jobs').run({ action: 'stop', name: 'same-generation' }, ctx);
  } finally {
    await tool('jobs').run({ action: 'stop', name: 'same-generation' }, ctx).catch(() => {});
  }
});

test('an active name cannot be overwritten and a missing name cannot stop anything', async () => {
  const { ctx } = setup();
  try {
    await tool('bash').run({ name: 'unique', command: 'sleep 300 >/dev/null 2>&1 &' }, ctx);
    await expect(tool('bash').run({ name: 'unique', command: 'touch should-not-exist' }, ctx)).rejects.toThrow(/already running/);
    expect(existsSync(join(ctx.workspace, 'should-not-exist'))).toBe(false);
    await expect(tool('jobs').run({ action: 'stop', name: 'absent' }, ctx)).rejects.toThrow(/unknown background job/);
  } finally {
    await tool('jobs').run({ action: 'stop', name: 'unique' }, ctx);
  }
});

test('a reused PGID is not killed when none of the recorded member identities survives', async () => {
  const { ctx } = setup();
  const bash = Bun.spawn(['bash', '-c', 'sleep 300'], { detached: true, stdout: 'ignore', stderr: 'ignore' });
  const other = Bun.spawn(['bash', '-c', `kill -STOP ${bash.pid}; kill -CONT ${bash.pid}; sleep 300`], { detached: true, stdout: 'ignore', stderr: 'ignore' });
  try {
    // Construct a stale registry through a real job-shaped note rather than trusting a bare PID.
    const { appendEvent } = await import('../../brain/journal');
    const members = (await import('../../body/jobs')).groupMembers(bash.pid);
    expect(members.length).toBeGreaterThan(0);
    appendEvent(ctx.journal, ctx.gen, { type: 'note', kind: 'body.job.v1', data: {
      name: 'stale', gen: ctx.gen, pgid: other.pid, cwd: ctx.workspace, command: 'unrelated', members, state: 'running',
    } });
    const status = await tool('jobs').run({ action: 'list' }, ctx);
    expect(status).toContain('stale: unverified');
    expect(alive(other.pid)).toBe(true);
    await expect(tool('jobs').run({ action: 'stop', name: 'stale' }, ctx)).resolves.toBe('stale: unverified');
    expect(alive(other.pid)).toBe(true);
  } finally {
    try { process.kill(-bash.pid, 'SIGKILL'); } catch {}
    try { process.kill(-other.pid, 'SIGKILL'); } catch {}
  }
});

test('a job left running wakes the agent once when it ends, and not while a turn runs', async () => {
  const { ctx } = setup();
  const out = await tool('bash').run({ name: 'suite', command: 'sleep 0.3 >/dev/null 2>&1 &' }, ctx);
  expect(out).toContain('background job suite; you are woken when it ends');
  const told: { source: string; text: string }[] = [];
  let busy = true;
  const stop = endedJobs(ctx.journal, 'g1', () => busy, 20)((s) => told.push(s));
  try {
    await Bun.sleep(600);
    // It has ended, but a turn is running: the agent may be waiting for it there.
    expect(told).toEqual([]);
    expect(jobHistory(readEvents(ctx.journal)).get('suite')?.state).toBe('running');
    busy = false;
    await Bun.sleep(150);
    expect(told).toHaveLength(1);
    expect(told[0]!.source).toBe('work');
    expect(told[0]!.text).toStartWith('The background job suite that you left running has ended. It ran: sleep 0.3');
    expect(jobHistory(readEvents(ctx.journal)).get('suite')).toMatchObject({ state: 'stopped', reason: 'ended' });
    await Bun.sleep(100);
    expect(told).toHaveLength(1);
  } finally { stop(); }
});

test('a job of another generation, one still running and one the agent stopped wake nobody', async () => {
  const { dir, ctx } = setup();
  await tool('bash').run({ name: 'old', command: 'sleep 0.2 >/dev/null 2>&1 &' }, { ...ctx, gen: 'g0' });
  await tool('bash').run({ name: 'long', command: 'sleep 300 >/dev/null 2>&1 & echo $! > pid' }, ctx);
  await tool('bash').run({ name: 'halted', command: 'sleep 300 >/dev/null 2>&1 &' }, ctx);
  await tool('jobs').run({ action: 'stop', name: 'halted' }, ctx);
  const told: unknown[] = [];
  const stop = endedJobs(ctx.journal, 'g1', () => false, 20)((s) => told.push(s));
  try {
    await Bun.sleep(500);
    expect(told).toEqual([]);
  } finally {
    stop();
    await tool('jobs').run({ action: 'stop', name: 'long' }, ctx);
    expect(await gone(Number(readFileSync(join(dir, 'pid'), 'utf8')))).toBe(true);
  }
});
