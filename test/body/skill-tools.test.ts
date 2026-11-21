import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_TOOLS, seedRecoverySkill } from '../../body/skill-tools';
import type { ToolContext } from '../../body/tools';
import { readEvents } from '../../brain/journal';
import { selectSkill, skillState } from '../../brain/skills';

function context(): ToolContext {
  const root = mkdtempSync(join(tmpdir(), 'teneral-skill-tools-'));
  const workspace = join(root, 'workspace'), soul = join(root, 'soul');
  mkdirSync(workspace); mkdirSync(soul);
  mkdirSync(join(workspace, 'brain', 'skill-packages'), { recursive: true });
  cpSync(join(process.cwd(), 'brain/skill-packages/lost-response-recovery'), join(workspace, 'brain/skill-packages/lost-response-recovery'), { recursive: true });
  return { workspace, journal: join(root, 'journal.jsonl'), gen: 'gen', mutationCommit: null,
    id: 'me', inbox: join(root, 'inbox'), peers: join(root, 'peers.json'), soul,
    toolNames: [...SKILL_TOOLS.map(t => t.spec.name), 'bash'] };
}
function tool(name: string) {
  const found = SKILL_TOOLS.find((t) => t.spec.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}
async function register(ctx: ToolContext): Promise<string> {
  const result = await tool('skill').run({ action: 'register', path: 'brain/skill-packages/lost-response-recovery' }, ctx);
  return result.match(/at ([0-9a-f]{64});/)![1]!;
}

test('the management lifecycle exposes only exact enabled verified content', async () => {
  const ctx = context();
  const hash = await register(ctx);
  await expect(tool('skill_show').run({ hash }, ctx)).rejects.toThrow('not enabled');
  await expect(tool('skill').run({ action: 'enable', hash }, ctx)).rejects.toThrow('passing verification');
  const verification = JSON.parse(await tool('skill').run({ action: 'verify', hash }, ctx));
  expect(verification.status).toBe('pass');
  await tool('skill').run({ action: 'enable', hash }, ctx);
  const found = JSON.parse(await tool('skill_search').run({ query: 'external timeout lost response duplicate retry' }, ctx));
  expect(found.status).toBe('selected');
  expect(found.skill.hash).toBe(hash);
  const shown = JSON.parse(await tool('skill_show').run({ hash }, ctx));
  expect(shown.hash).toBe(hash);
  expect(shown.untrustedInstructions).toContain('do not repeat');
  expect(shown.untrustedInstructions).not.toContain('owner authority\n');
  const outcome = await tool('skill_outcome').run({ hash, run: 'case-1', outcome: 'no-op', detail: 'Remote receipt matched exact content.' }, ctx);
  expect(outcome).toContain('Recorded no-op');
  expect(await tool('skill_outcome').run({ hash, run: 'case-1', outcome: 'no-op', detail: 'Remote receipt matched exact content.' }, ctx)).toContain('already recorded');
  await expect(tool('skill_outcome').run({ hash, run: 'case-1', outcome: 'success', detail: 'different' }, ctx)).rejects.toThrow('different outcome');
  const list = JSON.parse(await tool('skill').run({ action: 'list' }, ctx));
  expect(list.packages[0].enabled).toBe(true);
  expect(list.outcomes).toHaveLength(1);
  await tool('skill').run({ action: 'revoke', hash }, ctx);
  expect(JSON.parse(await tool('skill_search').run({ query: 'external timeout lost response' }, ctx)).status).toBe('none');
  await expect(tool('skill').run({ action: 'enable', hash }, ctx)).rejects.toThrow('revoked');
  expect(readEvents(ctx.journal).filter(e => e.type === 'note' && e.kind === 'skill.v1')).toHaveLength(5);
});

test('registration is content-idempotent and unknown runners cannot become packages', async () => {
  const ctx = context();
  const hash = await register(ctx);
  expect(await tool('skill').run({ action: 'register', path: 'brain/skill-packages/lost-response-recovery' }, ctx)).toContain('Already registered');
  expect(readEvents(ctx.journal)).toHaveLength(1);
  const state = skillState(readEvents(ctx.journal), ctx.journal);
  expect(selectSkill(state, 'lost response', ['bash'], 'gen').status).toBe('none');
  await expect(tool('skill').run({ action: 'enable', hash: '0'.repeat(64) }, ctx)).rejects.toThrow('no registered skill');
});

test('the built-in recovery skill is registered once and reverified only for a new runtime', async () => {
  const ctx = context();
  seedRecoverySkill(ctx);
  const first = readEvents(ctx.journal);
  expect(first.map(e => e.type === 'note' ? (e.data as { op?: string }).op : '')).toEqual(['register', 'verify', 'enable']);
  seedRecoverySkill(ctx);
  expect(readEvents(ctx.journal)).toHaveLength(3);
  ctx.gen = 'next';
  seedRecoverySkill(ctx);
  const next = readEvents(ctx.journal);
  expect(next).toHaveLength(5);
  expect(next.slice(3).map(e => e.type === 'note' ? (e.data as { op?: string }).op : '')).toEqual(['verify', 'enable']);
  seedRecoverySkill(ctx);
  expect(readEvents(ctx.journal)).toHaveLength(5);
  const hash = first[0]!.type === 'note' ? (first[0].data as { hash: string }).hash : '';
  const state = skillState(readEvents(ctx.journal), ctx.journal);
  const selection = selectSkill(state, 'external request timeout uncertain receipt avoid duplicate retry', ctx.toolNames!, 'next');
  expect(selection.status).toBe('selected');
  expect(selection.skill?.hash).toBe(hash);
});

test('a failed built-in verification is never enabled by the seed', () => {
  const ctx = context();
  ctx.toolNames = [];
  seedRecoverySkill(ctx);
  const state = skillState(readEvents(ctx.journal), ctx.journal);
  expect(state.verifications).toHaveLength(1);
  expect(state.verifications[0]?.status).toBe('fail');
  expect(state.verifications[0]?.failed).toHaveLength(6);
  expect(state.enabled.size).toBe(0);
  expect(selectSkill(state, 'external request timeout uncertain receipt avoid duplicate retry', [], 'gen').status).toBe('none');
});

test('disable is reversible but a revoked exact hash cannot return through later notes', async () => {
  const ctx = context();
  seedRecoverySkill(ctx);
  const first = readEvents(ctx.journal)[0]!;
  const hash = first.type === 'note' ? (first.data as { hash: string }).hash : '';
  await tool('skill').run({ action: 'disable', hash }, ctx);
  seedRecoverySkill(ctx);
  expect(JSON.parse(await tool('skill_search').run({ query: 'lost response' }, ctx)).status).toBe('none');
  await tool('skill').run({ action: 'enable', hash }, ctx);
  expect(JSON.parse(await tool('skill_search').run({ query: 'lost response' }, ctx)).status).toBe('selected');
  await tool('skill').run({ action: 'revoke', hash }, ctx);
  await expect(tool('skill').run({ action: 'enable', hash }, ctx)).rejects.toThrow('revoked');
  seedRecoverySkill(ctx);
  expect(JSON.parse(await tool('skill_search').run({ query: 'lost response' }, ctx)).status).toBe('none');
});
test('path containment and outcome inputs are enforced', async () => {
  const ctx = context();
  await expect(tool('skill').run({ action: 'register', path: '../outside' }, ctx)).rejects.toThrow('outside the workspace');
  const hash = await register(ctx);
  await expect(tool('skill_outcome').run({ hash, run: 'x', outcome: 'miracle', detail: 'not evidence' }, ctx)).rejects.toThrow();
});
