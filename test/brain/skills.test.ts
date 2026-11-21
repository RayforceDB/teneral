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
