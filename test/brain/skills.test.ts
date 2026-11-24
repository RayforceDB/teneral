import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendEvent, readEvents, type JournalEvent } from '../../brain/journal';
import {
  SKILL_NOTE, fingerprint, openSkillRegistry, readPackage, recoveryDecision, selectSkill, skillState,
  skillsRoot, storePackage, verifyPackage, type SkillPackage,
} from '../../brain/skills';
import { library, ray } from './rayforce';

const real = test.skipIf(library === null);
const source = join(process.cwd(), 'brain/skill-packages/lost-response-recovery');
let serial = 0;
const journal = (): string => join(mkdtempSync(join(tmpdir(), 'teneral-skills-')), 'journal.jsonl');
function note(path: string, data: Record<string, unknown>): JournalEvent {
  return appendEvent(path, 'gen', { type: 'note', kind: SKILL_NOTE, data });
}
function register(path: string, skill = readPackage(source)): SkillPackage {
  storePackage(path, skill);
  note(path, { op: 'register', id: skill.manifest.id, version: skill.manifest.version, hash: skill.hash });
  return skill;
}
function verified(path: string, skill = register(path), generation = 'gen'): SkillPackage {
  const result = verifyPackage(skill, ['bash'], generation);
  note(path, { op: 'verify', id: skill.manifest.id, ...result });
  note(path, { op: 'enable', id: skill.manifest.id, hash: skill.hash, fingerprint: result.fingerprint });
  return skill;
}

test('the built-in recovery package has exact content identity and survives a content-addressed copy', () => {
  const skill = readPackage(source);
  expect(skill.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(skill.manifest.id).toBe('lost-response-recovery');
  expect(skill.cases).toHaveLength(6);
  const path = journal();
  const stored = storePackage(path, skill);
  expect(readPackage(stored, skill.hash)).toEqual(skill);
  expect(storePackage(path, skill)).toBe(stored);
});

test('the recovery runner distinguishes completed, not-started and uncertain operations', () => {
  expect(recoveryDecision({ attempt: 'started', receipt: 'matches', state: 'matches' })).toBe('no-op');
  expect(recoveryDecision({ attempt: 'started', receipt: 'matches', state: 'unchanged' })).toBe('no-op');
  expect(recoveryDecision({ attempt: 'not-started', receipt: 'missing', state: 'unchanged' })).toBe('retry-safe');
  expect(recoveryDecision({ attempt: 'interrupted', receipt: 'unknown', state: 'unknown' })).toBe('inconclusive');
  expect(recoveryDecision({ attempt: 'started', receipt: 'different', state: 'different' })).toBe('inconclusive');
  const result = verifyPackage(readPackage(source), ['bash'], 'gen');
  expect(result.status).toBe('pass');
  expect(result.passed).toBe(6);
  expect(result.total).toBe(6);
});

test('verification fails closed when a declared existing-tool dependency is absent', () => {
  const result = verifyPackage(readPackage(source), [], 'gen');
  expect(result.status).toBe('fail');
  expect(result.passed).toBe(0);
  expect(result.cases).toHaveLength(6);
});

test('enablement is exact-hash state and verification does not leak across generations', () => {
  const path = journal();
  const skill = verified(path);
  const events = readEvents(path);
  const current = skillState(events, path);
  expect(current.enabled.get(skill.manifest.id)).toBe(skill.hash);
  expect(selectSkill(current, 'external request timeout uncertain receipt avoid duplicate retry', ['bash'], 'gen').status).toBe('selected');
  expect(selectSkill(current, 'external request timeout uncertain receipt avoid duplicate retry', ['bash'], 'next').status).toBe('none');
  expect(selectSkill(current, 'unrelated database index design', ['bash'], 'gen').status).toBe('none');
});

test('a forged enable note without its own passing verification enables nothing', () => {
  const path = journal();
  const skill = register(path);
  note(path, { op: 'enable', id: skill.manifest.id, hash: skill.hash, fingerprint: fingerprint(['bash'], 'gen') });
  expect(skillState(readEvents(path), path).enabled.size).toBe(0);
});

test('revocation keeps immutable evidence but removes selection, and stale lifecycle notes are ignored', () => {
  const path = journal();
  const skill = verified(path);
  note(path, { op: 'revoke', id: skill.manifest.id, hash: '0'.repeat(64) });
  expect(skillState(readEvents(path), path).enabled.size).toBe(1);
  note(path, { op: 'revoke', id: skill.manifest.id, hash: skill.hash });
  const state = skillState(readEvents(path), path);
  expect(state.enabled.size).toBe(0);
  expect(state.disabled.has(skill.hash)).toBe(true);
  expect(state.packages.has(skill.hash)).toBe(true);
  expect(selectSkill(state, 'lost response timeout', ['bash'], 'gen').status).toBe('none');
});

test('usage evidence ranks otherwise equal versions without combining their instructions', () => {
  const path = journal();
  const one = verified(path);
  note(path, { op: 'outcome', id: one.manifest.id, hash: one.hash, run: 'r1', outcome: 'success', detail: 'receipt found' });
  const result = verifyPackage(one, ['bash'], 'gen');
  note(path, { op: 'verify', id: one.manifest.id, ...result });
  note(path, { op: 'enable', id: one.manifest.id, hash: one.hash, fingerprint: result.fingerprint });
  const selected = selectSkill(skillState(readEvents(path), path), 'lost response recovery', ['bash'], 'gen');
  expect(selected.status).toBe('selected');
  expect(selected.candidates[0]?.successes).toBe(1);
});

test('a later failed verification supersedes an earlier pass and records every failed case', () => {
  const path = journal();
  const skill = verified(path);
  expect(selectSkill(skillState(readEvents(path), path), 'lost response recovery', ['bash'], 'gen').status).toBe('selected');
  const baseline = verifyPackage(skill, ['bash'], 'gen');
  const failed = { ...baseline, status: 'fail' as const, passed: 0, failed: skill.cases.map(c => c.id) };
  expect(failed.status).toBe('fail');
  expect(failed.cases).toHaveLength(6);
  expect(failed.failed).toHaveLength(6);
  note(path, { op: 'verify', id: skill.manifest.id, ...failed });
  expect(selectSkill(skillState(readEvents(path), path), 'lost response recovery', ['bash'], 'gen').status).toBe('none');
  note(path, { op: 'enable', id: skill.manifest.id, hash: skill.hash, fingerprint: failed.fingerprint });
  expect(selectSkill(skillState(readEvents(path), path), 'lost response recovery', ['bash'], 'gen').status).toBe('none');
  note(path, { op: 'verify', id: skill.manifest.id, ...baseline });
  note(path, { op: 'enable', id: skill.manifest.id, hash: skill.hash, fingerprint: baseline.fingerprint });
  expect(selectSkill(skillState(readEvents(path), path), 'lost response recovery', ['bash'], 'gen').status).toBe('selected');
});

test('registration notes reconstruct the exact package after every derived copy is removed', () => {
  const ctxPath = journal();
  const skill = readPackage(source);
  storePackage(ctxPath, skill);
  note(ctxPath, { op: 'register', id: skill.manifest.id, version: skill.manifest.version, hash: skill.hash, package: { files: skill.files } });
  const result = verifyPackage(skill, ['bash'], 'gen');
  note(ctxPath, { op: 'verify', id: skill.manifest.id, ...result });
  note(ctxPath, { op: 'enable', id: skill.manifest.id, hash: skill.hash, fingerprint: result.fingerprint });
  rmSync(skillsRoot(ctxPath), { recursive: true, force: true });
  const state = skillState(readEvents(ctxPath), ctxPath);
  expect(state.packages.get(skill.hash)).toEqual(skill);
  expect(readPackage(join(skillsRoot(ctxPath), skill.hash), skill.hash)).toEqual(skill);
  expect(selectSkill(state, 'lost response recovery', ['bash'], 'gen').status).toBe('selected');
});

test('an unrelated skill with the same relevance and precedence is an explicit conflict', () => {
  const base = readPackage(source);
  const files = { ...base.files, 'skill.json': JSON.stringify({ ...base.manifest, id: 'other-recovery', version: '1.0.0' }) };
  // Identical searchable metadata: only id and exact content identity differ.
  const dir = mkdtempSync(join(tmpdir(), 'teneral-other-skill-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  const other = readPackage(dir);
  const path = journal();
  register(path, base);
  verified(path, base);
  register(path, other);
  verified(path, other);
  const selected = selectSkill(skillState(readEvents(path), path), 'lost response recovery', ['bash'], 'gen');
  expect(selected.status).toBe('conflict');
  expect(selected.skill).toBeUndefined();
  expect(selected.candidates).toHaveLength(2);
});

test('malformed lifecycle notes do not destroy the readable registry', () => {
  const path = journal();
  const skill = verified(path);
  note(path, { op: 'register', hash: 'bad' });
  note(path, { op: 'verify', hash: skill.hash, status: 'pass', passed: 99, total: 1, fingerprint: 'x' });
  const state = skillState(readEvents(path), path);
  expect(state.packages.size).toBe(1);
  expect(state.verifications).toHaveLength(1);
});

real('Rayforce durably holds package bytes and registry rows and reconstructs a missing source copy', () => {
  const path = journal();
  const skill = verified(path);
  const events = () => readEvents(path);
  note(path, { op: 'outcome', hash: skill.hash, run: 'recovery-observation-1', outcome: 'no-op', detail: 'Receipt matched; no duplicate sent.' });
  const first = openSkillRegistry(ray(), path, events, ['bash'], 'gen');
  expect(first.search('external operation lost response').skill?.hash).toBe(skill.hash);
  expect(first.state().outcomes).toHaveLength(1);
  first.persist();
  rmSync(skillsRoot(path), { recursive: true, force: true });
  expect(skillState(events(), path).packages.size).toBe(0);
  // Lifecycle notes in this fixture intentionally omit package bytes. With the copy
  // removed, only the on-disk Rayforce registry can satisfy this fresh process.
  const run = Bun.spawnSync([process.execPath, '-e', `
    import { openRay } from ${JSON.stringify(join(import.meta.dir, '../../brain/ray.ts'))};
    import { readEvents } from ${JSON.stringify(join(import.meta.dir, '../../brain/journal.ts'))};
    import { openSkillRegistry, recoveryDecision } from ${JSON.stringify(join(import.meta.dir, '../../brain/skills.ts'))};
    const library = ${JSON.stringify(library)}, journal = 'journal.jsonl';
    const db = openRay({ library });
    const registry = openSkillRegistry(db, journal, () => readEvents(journal), ['bash'], 'gen');
    const chosen = registry.search('external operation lost response').skill;
    if (!chosen) throw new Error('no enabled exact version after restart');
    console.log(JSON.stringify({ hash: chosen.hash, decisions: chosen.cases.map(recoveryDecision) }));
  `], { cwd: dirname(path), env: { PATH: '' }, stderr: 'pipe', timeout: 20_000 });
  if (!run.success) throw new Error(`fresh skill registry process failed: ${run.stderr.toString()}`);
  expect(JSON.parse(run.stdout.toString())).toEqual({
    hash: skill.hash, decisions: skill.cases.map((c) => c.expected),
  });
  const second = openSkillRegistry(ray(), path, events, ['bash'], 'gen');
  expect(readPackage(join(skillsRoot(path), skill.hash), skill.hash)).toEqual(skill);
  expect(second.search('external operation lost response').status).toBe('selected');
  expect(second.state().outcomes[0]?.run).toBe('recovery-observation-1');
  for (const [name, column] of [['packages', 'hash'], ['lifecycle', 'event'], ['verification', 'event'], ['outcomes', 'event']]) {
    expect(ray().table(`(select {from: skill_registry_${name} ${column}: ${column}})`).rows).toBe(1);
  }
  const verification = ray().table('(select {from: skill_registry_verification failed: failed})');
  expect(JSON.parse(String(verification.columns.failed?.[0] ?? 'null'))).toEqual([]);
  second.persist();
});

// --- skills of any kind: a decision table the package declares, held to its own cases ---

import { existsSync, readFileSync } from 'node:fs';
import { OFFER_TERMS, offerOf, scaffold, tableDecision } from '../../brain/skills';
import { OFFERED_KIND } from '../../brain/reminded';
import { keepVerified, offerFor, skillUse, SKILL_TOOLS } from '../../body/skill-tools';
import type { ToolContext } from '../../body/tools';
import { journalPast, projections, storePast } from '../../brain/past';
import { openStore } from '../../brain/store';

/** A skill written as an agent would write one: when a release may be tagged. */
function releaseSkill(dir: string, change: (files: Record<string, any>) => void = () => {}): string {
  const files: Record<string, any> = {
    manifest: {
      schema: 1, id: 'tag-a-release', version: '1.0.0', capability: 'release.tagging', precedence: 100, runner: 'decision-table.v1',
      summary: 'Decide whether a release may be tagged: only from a clean tree on the main branch with the checks green.',
      triggers: ['tag the release', 'cut a new version', 'publish release tag'], exclusions: ['A hotfix the owner asked for by name.'],
      dependencies: { api: 'skill-runtime.v1', tools: ['bash'] }, assumptions: ['The checks run on the commit to be tagged.'],
      decide: {
        fields: { tree: ['clean', 'dirty'], branch: ['main', 'other'], checks: ['green', 'red', 'running'] },
        rules: [
          { when: { tree: 'dirty' }, then: 'stop' },
          { when: { branch: 'other' }, then: 'stop' },
          { when: { checks: 'running' }, then: 'wait' },
          { when: { checks: 'green' }, then: 'tag' },
        ],
        otherwise: 'stop',
      },
    },
    cases: { schema: 1, cases: [
      { id: 'dirty', tree: 'dirty', branch: 'main', checks: 'green', expected: 'stop' },
      { id: 'elsewhere', tree: 'clean', branch: 'other', checks: 'green', expected: 'stop' },
      { id: 'not-yet', tree: 'clean', branch: 'main', checks: 'running', expected: 'wait' },
      { id: 'ready', tree: 'clean', branch: 'main', checks: 'green', expected: 'tag' },
      { id: 'red', tree: 'clean', branch: 'main', checks: 'red', expected: 'stop' },
    ] },
  };
  change(files);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'skill.json'), JSON.stringify(files.manifest, null, 2));
  writeFileSync(join(dir, 'instructions.md'), '# Tag a release\n\n1. Look at the tree, the branch and the checks.\n2. Decide by the table.\n');
  writeFileSync(join(dir, 'cases.json'), JSON.stringify(files.cases, null, 2));
  return dir;
}
const fresh = (name: string): string => join(mkdtempSync(join(tmpdir(), 'teneral-skill-')), name);

test('a skill of any kind declares what it decides as a table, and is held to its own cases', () => {
  const skill = readPackage(releaseSkill(fresh('ok')));
  expect(tableDecision(skill.manifest.decide!, { tree: 'clean', branch: 'main', checks: 'green' })).toEqual({ rule: 3, decided: 'tag' });
  expect(tableDecision(skill.manifest.decide!, { tree: 'clean', branch: 'main', checks: 'red' })).toEqual({ rule: -1, decided: 'stop' });
  expect(verifyPackage(skill, ['bash'], 'gen')).toMatchObject({ status: 'pass', passed: 5, total: 5, failed: [] });
  // A tool it needs is not there: nothing passes.
  expect(verifyPackage(skill, [], 'gen').status).toBe('fail');
  // A case that expects otherwise than the table decides fails, by its name.
  const wrong = readPackage(releaseSkill(fresh('wrong'), (f) => { f.cases.cases[3].expected = 'wait'; }));
  expect(verifyPackage(wrong, ['bash'], 'gen')).toMatchObject({ status: 'fail', passed: 4, failed: ['ready'] });
  // A rule no case reaches is a claim nothing holds to: the package fails until a case reaches it.
  const unreached = readPackage(releaseSkill(fresh('unreached'), (f) => { f.cases.cases.splice(2, 1); }));
  expect(verifyPackage(unreached, ['bash'], 'gen')).toMatchObject({ status: 'fail', passed: 4, failed: ['rule 3 is reached by no case'] });
  const never = readPackage(releaseSkill(fresh('never'), (f) => { f.cases.cases.pop(); }));
  expect(verifyPackage(never, ['bash'], 'gen').failed).toEqual(['"otherwise" is reached by no case']);
});

test('a table that does not hang together is refused when the package is read', () => {
  const refused = (change: (f: Record<string, any>) => void): string => { try { readPackage(releaseSkill(fresh('bad'), change)); return ''; } catch (e) { return String(e); } };
  expect(refused((f) => { f.manifest.decide.rules[0].when = { tree: 'muddy' }; })).toContain('rule 1 names a field or a value the table does not have');
  expect(refused((f) => { f.manifest.decide.rules[0].when = {}; })).toContain('holds always');
  expect(refused((f) => { f.cases.cases[0].tree = 'muddy'; })).toContain('does not say tree');
  expect(refused((f) => { f.cases.cases[0].expected = 'celebrate'; })).toContain('never decides');
  expect(refused((f) => { delete f.manifest.decide; })).toContain('exactly when its runner is decision-table.v1');
  expect(refused((f) => { f.manifest.runner = 'lost-response-recovery.v1'; })).toContain('exactly when its runner is decision-table.v1');
  // The first skill, with a runner of its own, reads and verifies as before.
  expect(verifyPackage(readPackage(source), ['bash'], 'gen').status).toBe('pass');
});

test('the files a new skill starts from verify as they stand, and say so themselves what is to be filled in', () => {
  const dir = fresh('new');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(scaffold('my-way'))) writeFileSync(join(dir, name), content);
  const skill = readPackage(dir);
  expect(skill.manifest).toMatchObject({ id: 'my-way', version: '0.1.0', runner: 'decision-table.v1' });
  expect(verifyPackage(skill, ['bash'], 'gen').status).toBe('pass');
  expect(() => scaffold('My Way')).toThrow();
});

/** A context over a journal of its own, with the skill tools' names as the tools at hand. */
function context(): { ctx: ToolContext; tool: (name: string, args: Record<string, unknown>) => Promise<string> } {
  const path = journal();
  const workspace = dirname(path);
  const ctx: ToolContext = { workspace, journal: path, gen: 'g1', mutationCommit: null, id: 'me', inbox: '/tmp/unused-inbox', peers: '/tmp/unused-peers.json', soul: '/tmp', toolNames: ['bash'] };
  return { ctx, tool: async (name, args) => String(await SKILL_TOOLS.find((t) => t.spec.name === name)!.run(args, ctx)) };
}

test('an agent sets down a skill of its own: scaffolds it, fills it in, registers, verifies and enables it; it is then offered, opened and counted', async () => {
  const { ctx, tool } = context();
  expect(await tool('skill', { action: 'scaffold', path: 'skills/tag-a-release', id: 'tag-a-release' })).toContain('Wrote skill.json, instructions.md, cases.json');
  await expect(tool('skill', { action: 'scaffold', path: 'skills/tag-a-release', id: 'tag-a-release' })).rejects.toThrow('there already');
  await expect(tool('skill', { action: 'scaffold', path: '../outside', id: 'x' })).rejects.toThrow('inside the workspace');
  // Filled in as the agent would.
  releaseSkill(join(ctx.workspace, 'skills/tag-a-release'));
  const hash = /at ([0-9a-f]{64})/.exec(await tool('skill', { action: 'register', path: 'skills/tag-a-release' }))![1]!;
  expect(JSON.parse(await tool('skill', { action: 'verify', hash })).status).toBe('pass');
  expect(await tool('skill', { action: 'enable', hash })).toContain('Enabled tag-a-release');

  // Something said that shares its words: it is offered, by a line that names it and does not hold the procedure.
  const offer = offerFor(ctx, 'please tag the release once the new version is ready')!;
  expect(offer.hash).toBe(hash);
  expect(offer.text).toContain('tag-a-release 1.0.0');
  expect(offer.text).toContain(`skill_show (hash ${hash})`);
  expect(offer.text).not.toContain('Decide by the table');
  // One shared word is chance; nothing of its own is nothing.
  expect(OFFER_TERMS).toBe(2);
  expect(offerFor(ctx, 'tag')).toBeNull();
  expect(offerFor(ctx, 'what is the weather in Lisbon tomorrow')).toBeNull();
  // Offered, it is not offered again at the next turns.
  appendEvent(ctx.journal, ctx.gen, { type: 'note', kind: OFFERED_KIND, data: offer });
  expect(offerFor(ctx, 'please tag the release once the new version is ready')).toBeNull();

  // Opened and used: counted of each skill.
  appendEvent(ctx.journal, ctx.gen, { type: 'tool.intent', callId: 'c1', name: 'skill_show', args: { hash } });
  expect(await tool('skill_show', { hash })).toContain('Decide by the table');
  await tool('skill_outcome', { hash, run: 'release 1.4.0', outcome: 'success', detail: 'tagged from a clean main with green checks' });
  await tool('skill_outcome', { hash, run: 'release 1.4.1', outcome: 'no-op', detail: 'checks were red: stopped' });
  // And when it was last used: what "not used for a month" is counted from.
  expect(skillUse(ctx)).toEqual([{ id: 'tag-a-release', version: '1.0.0', hash, offered: 1, opened: 1, outcomes: { success: 1, 'no-op': 1 }, last: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) }]);
  expect(JSON.parse(await tool('skill', { action: 'list' })).use).toEqual(skillUse(ctx));

  // A new generation: the verification of the old one does not count, so nothing is offered, until the enabled skills are verified again at the start.
  const next: ToolContext = { ...ctx, gen: 'g2', past: undefined };
  const afresh = 'the release is ready, tag the new version please';
  expect(offerOf(skillState(readEvents(ctx.journal), ctx.journal), afresh, ['bash'], 'g2', new Set())).toBeNull();
  expect(keepVerified(next)).toBe(1);
  expect(keepVerified(next)).toBe(0);
  expect(offerOf(skillState(readEvents(ctx.journal), ctx.journal), afresh, ['bash'], 'g2', new Set())?.hash).toBe(hash);
});

real('how each skill is used is counted by the database as from the journal', async () => {
  const { ctx, tool } = context();
  releaseSkill(join(ctx.workspace, 'skills/tag-a-release'));
  const hash = /at ([0-9a-f]{64})/.exec(await tool('skill', { action: 'register', path: 'skills/tag-a-release' }))![1]!;
  await tool('skill', { action: 'verify', hash });
  await tool('skill', { action: 'enable', hash });
  for (let i = 0; i < 3; i++) appendEvent(ctx.journal, ctx.gen, { type: 'note', kind: OFFERED_KIND, data: { hash, id: 'tag-a-release', text: 'x' } });
  for (const outcome of ['success', 'success', 'failure']) await tool('skill_outcome', { hash, run: `r${Math.random()}`, outcome, detail: 'd' });
  appendEvent(ctx.journal, ctx.gen, { type: 'tool.intent', callId: 'c', name: 'skill_show', args: { hash } });
  const read = skillUse({ ...ctx, past: journalPast(ctx.journal) });
  const asked = skillUse({ ...ctx, past: storePast(ctx.journal, ray(), openStore(ray(), ctx.journal, undefined, projections()), false) });
  expect(asked).toEqual(read);
  expect(asked[0]).toMatchObject({ offered: 3, opened: 1, outcomes: { success: 2, failure: 1 } });
  expect(existsSync(join(ctx.workspace, 'skills/tag-a-release/skill.json')) && readFileSync(join(ctx.workspace, 'skills/tag-a-release/skill.json'), 'utf8').includes('decision-table.v1')).toBe(true);
}, 60_000);

import { runTurn } from '../../brain/loop';
import { buildMessages } from '../../brain/memory';
import type { ChatMessage, Provider } from '../../brain/provider';

test('a turn offers a fitting skill once, before its first request, and the line stays in the conversation where it was journaled', async () => {
  const path = journal();
  appendEvent(path, 'g1', { type: 'stimulus', source: 'terminal', text: 'please tag the release once the new version is ready' });
  const ctx: ToolContext = { workspace: dirname(path), journal: path, gen: 'g1', mutationCommit: null, id: 'me', inbox: '/tmp/unused-inbox', peers: '/tmp/unused-peers.json', soul: '/tmp' };
  const seen: ChatMessage[][] = [];
  const replies = [{ text: '', toolCalls: [{ id: 'c1', name: 'echo', args: {} }] }, { text: 'done', toolCalls: [] }];
  const provider: Provider = async (messages) => { seen.push(structuredClone(messages)); return replies.shift()!; };
  let asked = 0;
  const offer = (question: string) => { asked += 1; return { hash: 'h'.repeat(64), id: 'tag-a-release', text: `[memory] A skill you keep may fit what was just said: tag-a-release 1.0.0. (${question.slice(0, 10)})` }; };
  const echo = { spec: { name: 'echo', description: '', parameters: {} }, async run() { return 'ok'; } };
  expect(await runTurn({ journal: path, gen: 'g1', provider, tools: [echo], system: () => 'SYS', ctx, offer })).toBe('done');
  // Asked once, for the turn; shown in both rounds, after what was said.
  expect(asked).toBe(1);
  expect(readEvents(path).filter((e) => e.type === 'note' && e.kind === OFFERED_KIND)).toHaveLength(1);
  for (const request of seen) expect(request.filter((m) => m.role === 'user').map((m) => m.content).join('\n')).toContain('A skill you keep may fit what was just said: tag-a-release 1.0.0. (please tag');
  // And it is part of the conversation from then on, as any request made from the journal shows it.
  expect(buildMessages(readEvents(path), 'SYS').some((m) => m.content?.includes('tag-a-release 1.0.0'))).toBe(true);
  // A tick of the clock is offered nothing: there is nothing said to fit.
  appendEvent(path, 'g1', { type: 'stimulus', source: 'clock', text: 'tick: tag the release new version' });
  replies.push({ text: 'nothing to do', toolCalls: [] });
  await runTurn({ journal: path, gen: 'g1', provider, tools: [echo], system: () => 'SYS', ctx, offer });
  expect(asked).toBe(1);
});
