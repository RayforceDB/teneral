import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { JournalEvent } from './journal';
import { postings, queryTerms } from './recall';
import { MEMORY_MARK } from './wire';
import type { Column, Ray, Table } from './ray';

// Skills are durable know-how, not a second source of authority or executable plugins. A package
// is exact bytes identified by their hash. Its manifest may name existing tools, but can neither
// grant them nor run install hooks. Only the declarative recovery runner in this file interprets
// verification cases; instructions are shown to the model as untrusted procedure text.
//
// The journal is canonical for package registration and lifecycle. `SKILLS_DIR` is a versioned
// content-addressed copy for crash recovery and Rayforce is the durable searchable registry. The
// copy and tables are rebuilt from notes at start; disabling one never rewrites a package. The
// exact selected hash, verification and outcomes remain inspectable after later revisions.

export const SKILL_NOTE = 'skill.v1';
export const SKILLS_DIR = 'skills-v1';
export const SKILL_SCHEMA = 1;
const MAX_FILE = 256_000;
const MAX_PACKAGE = 1_000_000;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const HASH = /^[0-9a-f]{64}$/;
/** The first skill's own runner, and the general one: a table of rules the package itself declares (`Decide`). */
const TABLE_RUNNER = 'decision-table.v1';
const RUNNERS = new Set(['lost-response-recovery.v1', TABLE_RUNNER]);
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const OUTCOMES = new Set(['success', 'no-op', 'inconclusive', 'failure', 'harm']);
const STATUS = new Set(['pass', 'fail']);
export const OUTCOME_NAMES = ['success', 'no-op', 'inconclusive', 'failure', 'harm'] as const;
const FILES = ['skill.json', 'instructions.md', 'cases.json'] as const;

export interface Manifest {
  schema: 1;
  id: string;
  version: string;
  capability: string;
  precedence: number;
  runner: string;
  summary: string;
  triggers: string[];
  exclusions: string[];
  dependencies: { api: string; tools: string[] };
  assumptions: string[];
  /** With the runner `decision-table.v1`: what the skill decides, as rules its cases are held to. */
  decide?: Decide;
}

/**
 * A skill's decision as a table: what is observed (`fields`, each with the values it can take),
 * the rules in the order they are tried (the first whose every `when` holds decides), and what is
 * decided when none does. It is declared, never run as code: the verification only looks up rows.
 */
export interface Decide {
  fields: Record<string, string[]>;
  rules: { when: Record<string, string>; then: string }[];
  otherwise: string;
}

/** A verification case: what was observed, by field, and what the skill should decide. */
export type SkillCase = { id: string; expected: string } & Record<string, string>;

export interface RecoveryCase {
  id: string;
  attempt: 'started' | 'not-started' | 'interrupted';
  receipt: 'matches' | 'different' | 'unknown' | 'missing';
  state: 'matches' | 'different' | 'unchanged' | 'unknown';
  expected: 'no-op' | 'retry-safe' | 'inconclusive';
}

export interface SkillPackage {
  hash: string;
  manifest: Manifest;
  instructions: string;
  cases: SkillCase[];
  files: Record<string, string>;
}

export interface Verification {
  hash: string;
  status: 'pass' | 'fail';
  fingerprint: string;
  passed: number;
  total: number;
  cases: string[];
  failed: string[];
  at: string;
  event: string;
}

export interface Outcome {
  hash: string;
  run: string;
  outcome: 'success' | 'no-op' | 'inconclusive' | 'failure' | 'harm';
  detail: string;
  at: string;
  event: string;
}

export interface SkillState {
  packages: Map<string, SkillPackage>;
  enabled: Map<string, string>;
  disabled: Set<string>;
  verifications: Verification[];
  outcomes: Outcome[];
}

export interface Selection {
  status: 'selected' | 'none' | 'conflict';
  query: string;
  candidates: { id: string; hash: string; version: string; score: number; successes: number; failures: number }[];
  skill?: SkillPackage;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected a JSON object');
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 4000): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new Error(`${name} must be nonempty text of at most ${max} characters`);
  return value;
}
function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new Error(`${name} must be a nonempty array of at most 32 strings`);
  return value.map((v) => text(v, name, 500));
}
function json(value: string, name: string): unknown {
  try { return JSON.parse(value); } catch { throw new Error(`${name} is not valid JSON`); }
}

export function parseManifest(value: unknown): Manifest {
  const m = object(value);
  if (typeof m.id !== 'string' || typeof m.version !== 'string' || typeof m.runner !== 'string'
    || m.schema !== SKILL_SCHEMA || !ID.test(m.id) || !VERSION.test(m.version)) throw new Error('unsupported skill schema, id or semantic version');
  if (typeof m.precedence !== 'number' || !Number.isInteger(m.precedence) || m.precedence < 0 || m.precedence > 1000) throw new Error('skill precedence must be an integer from 0 to 1000');
  if (!RUNNERS.has(m.runner)) throw new Error('skill names an unsupported verification runner');
  const d = object(m.dependencies);
  if (d.api !== 'skill-runtime.v1') throw new Error('skill requires an incompatible runtime API');
  const tools = Array.isArray(d.tools) ? d.tools.map((v) => text(v, 'dependency tool', 64)) : [];
  if (new Set(tools).size !== tools.length) throw new Error('skill dependency tools must be unique');
  if ((m.runner === TABLE_RUNNER) !== (m.decide !== undefined)) throw new Error(`a skill declares what it decides ("decide") exactly when its runner is ${TABLE_RUNNER}`);
  return {
    schema: 1, id: m.id as string, version: m.version as string,
    capability: text(m.capability, 'capability', 120), precedence: m.precedence,
    runner: m.runner as string, summary: text(m.summary, 'summary', 1000),
    triggers: strings(m.triggers, 'triggers'), exclusions: strings(m.exclusions, 'exclusions'),
    dependencies: { api: 'skill-runtime.v1', tools }, assumptions: strings(m.assumptions, 'assumptions'),
    ...(m.decide === undefined ? {} : { decide: parseDecide(m.decide) }),
  };
}

function parseDecide(value: unknown): Decide {
  const d = object(value);
  const named = (v: unknown, what: string): string => { const name = text(v, what, 40); if (!NAME.test(name)) throw new Error(`${what} must be a short lower-case name: ${name}`); return name; };
  const fields: Record<string, string[]> = Object.create(null);
  const given = Object.entries(object(d.fields));
  if (given.length === 0 || given.length > 12) throw new Error('a decision table observes 1 to 12 fields');
  for (const [name, values] of given) {
    if (name === 'id' || name === 'expected') throw new Error(`a field cannot be named ${name}`);
    if (!Array.isArray(values) || values.length < 2 || values.length > 12) throw new Error(`field ${name} takes 2 to 12 values`);
    fields[named(name, 'field')] = values.map((v) => named(v, `value of ${name}`));
    if (new Set(fields[name]).size !== values.length) throw new Error(`field ${name} names a value twice`);
  }
  if (!Array.isArray(d.rules) || d.rules.length === 0 || d.rules.length > 40) throw new Error('a decision table has 1 to 40 rules');
  const rules = d.rules.map((raw, n) => {
    const r = object(raw);
    const when: Record<string, string> = Object.create(null);
    const conditions = Object.entries(object(r.when));
    if (conditions.length === 0) throw new Error(`rule ${n + 1} holds always: say that as "otherwise"`);
    for (const [name, v] of conditions) {
      if (fields[name] === undefined || typeof v !== 'string' || !fields[name]!.includes(v)) throw new Error(`rule ${n + 1} names a field or a value the table does not have: ${name}`);
      when[name] = v;
    }
    return { when, then: named(r.then, 'what a rule decides') };
  });
  return { fields, rules, otherwise: named(d.otherwise, 'what is decided otherwise') };
}

/** What the table decides of what was observed: the first rule that holds, by its place; -1 and `otherwise` when none does. */
export function tableDecision(decide: Decide, observed: Record<string, string>): { rule: number; decided: string } {
  const rule = decide.rules.findIndex((r) => Object.entries(r.when).every(([name, v]) => observed[name] === v));
  return { rule, decided: rule === -1 ? decide.otherwise : decide.rules[rule]!.then };
}

export function parseCases(value: unknown, decide?: Decide): SkillCase[] {
  const root = object(value);
  if (root.schema !== 1 || !Array.isArray(root.cases) || root.cases.length === 0 || root.cases.length > 100) throw new Error('cases.json must hold 1 to 100 schema-1 cases');
  const ids = new Set<string>();
  return root.cases.map((raw) => {
    const c = object(raw);
    const id = text(c.id, 'case id', 100);
    if (ids.has(id)) throw new Error(`duplicate verification case: ${id}`);
    ids.add(id);
    if (decide !== undefined) {
      // A case of a decision table says what was observed in every field, and what should be decided.
      const outcomes = new Set([decide.otherwise, ...decide.rules.map((r) => r.then)]);
      const expected = text(c.expected, 'expected', 40);
      if (!outcomes.has(expected)) throw new Error(`case ${id} expects what the table never decides: ${expected}`);
      const observed: Record<string, string> = Object.create(null);
      for (const [name, values] of Object.entries(decide.fields)) {
        if (typeof c[name] !== 'string' || !values.includes(c[name] as string)) throw new Error(`case ${id} does not say ${name} as one of: ${values.join(', ')}`);
        observed[name] = c[name] as string;
      }
      return { ...observed, id, expected } as SkillCase;
    }
    const attempt = text(c.attempt, 'attempt', 20) as RecoveryCase['attempt'];
    const receipt = text(c.receipt, 'receipt', 20) as RecoveryCase['receipt'];
    const state = text(c.state, 'state', 20) as RecoveryCase['state'];
    const expected = text(c.expected, 'expected', 20) as RecoveryCase['expected'];
    if (!['started', 'not-started', 'interrupted'].includes(attempt) || !['matches', 'different', 'unknown', 'missing'].includes(receipt)
      || !['matches', 'different', 'unchanged', 'unknown'].includes(state) || !['no-op', 'retry-safe', 'inconclusive'].includes(expected)) throw new Error(`invalid recovery case: ${id}`);
    return { id, attempt, receipt, state, expected } as SkillCase;
  });
}

/** Parse and hash a complete package. Unknown files are part of the hash but never executed. */
export function readPackage(root: string, expected?: string): SkillPackage {
  const entries = readdirSync(root, { withFileTypes: true });
  const files: Record<string, string> = Object.create(null);
  let total = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || entry.name === '.' || entry.name === '..' || entry.name.includes('\\') || entry.name !== entry.name.toWellFormed()) throw new Error('skill packages contain plain files only, in one directory');
    const bytes = readFileSync(join(root, entry.name));
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes)) throw new Error(`skill package file is not UTF-8: ${entry.name}`);
    if (bytes.length > MAX_FILE || (total += bytes.length) > MAX_PACKAGE) throw new Error('skill package exceeds its size limit');
    files[entry.name] = content;
  }
  for (const required of FILES) if (files[required] === undefined) throw new Error(`skill package lacks ${required}`);
  const manifest = parseManifest(json(files['skill.json']!, 'skill.json'));
  const instructions = text(files['instructions.md'], 'instructions.md', MAX_FILE);
  const cases = parseCases(json(files['cases.json']!, 'cases.json'), manifest.decide);
  const hash = createHash('sha256').update(canonicalFiles(files)).digest('hex');
  if (expected !== undefined && hash !== expected) throw new Error(`skill package hash mismatch: expected ${expected}, got ${hash}`);
  return { hash, manifest, instructions, cases, files };
}

function canonicalFiles(files: Record<string, string>): string {
  return Object.keys(files).sort().map((name) => `${name.length}:${name}${Buffer.byteLength(files[name]!)}:${files[name]}`).join('');
}

export function skillsRoot(journal: string): string {
  return join(dirname(journal), SKILLS_DIR, 'packages');
}

/** Write exact package bytes into the content-addressed recovery copy. Never overwrite a hash. */
export function storePackage(journal: string, skill: SkillPackage): string {
  const root = skillsRoot(journal);
  const dir = join(root, skill.hash);
  if (existsSync(dir)) {
    readPackage(dir, skill.hash);
    return dir;
  }
  mkdirSync(root, { recursive: true });
  const temporary = join(root, `.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(temporary);
  try {
    for (const [name, content] of Object.entries(skill.files)) writeFileSync(join(temporary, name), content, { flag: 'wx' });
    readPackage(temporary, skill.hash);
    renameSync(temporary, dir);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return dir;
}

/** Rebuild the content-addressed source copy from journal notes, then project lifecycle. */
export function skillState(events: JournalEvent[], journal?: string): SkillState {
  const packages = new Map<string, SkillPackage>();
  const enabled = new Map<string, string>();
  const disabled = new Set<string>();
  const revoked = new Set<string>();
  const verifications: Verification[] = [];
  const outcomes: Outcome[] = [];
  for (const event of events) {
    if (event.type !== 'note' || event.kind !== SKILL_NOTE || typeof event.data !== 'object' || event.data === null) continue;
    const d = event.data as Record<string, unknown>;
    try {
      if (d.op === 'register') {
        const hash = text(d.hash, 'hash', 64);
        if (!HASH.test(hash)) continue;
        let skill: SkillPackage;
        const embedded = typeof d.package === 'object' && d.package !== null ? object((d.package as Record<string, unknown>).files) : null;
        if (embedded !== null) {
          skill = readVirtualPackage(embedded, hash);
          if (journal !== undefined && !existsSync(join(skillsRoot(journal), hash))) storePackage(journal, skill);
        } else if (journal !== undefined) {
          const dir = join(skillsRoot(journal), hash);
          if (!existsSync(dir)) continue;
          skill = readPackage(dir, hash);
        } else {
          continue;
        }
        if (skill.manifest.id !== d.id || skill.manifest.version !== d.version) continue;
        const collision = [...packages.values()].some((prior) => prior.manifest.id === skill.manifest.id
          && prior.manifest.version === skill.manifest.version && prior.hash !== hash);
        if (collision) continue;
        packages.set(hash, skill);
      } else if (d.op === 'enable' || d.op === 'disable' || d.op === 'revoke') {
        const id = String(d.id), hash = String(d.hash);
        if (!ID.test(id) || !HASH.test(hash) || !packages.has(hash) || packages.get(hash)!.manifest.id !== id) continue;
        if (d.op === 'enable') {
          const verified = verifications.findLast((v) => v.hash === hash && v.fingerprint === d.fingerprint)?.status === 'pass';
          if (!verified) continue;
          // Revocation is permanent for this exact content. A revision must change its hash.
          if (revoked.has(hash)) continue;
          enabled.set(id, hash);
          disabled.delete(hash);
        } else if (d.op === 'disable') {
          if (enabled.get(id) === hash) enabled.delete(id);
        } else {
          revoked.add(hash);
          disabled.add(hash);
          if (enabled.get(id) === hash) enabled.delete(id);
        }
      } else if (d.op === 'verify') {
        const hash = String(d.hash), status = String(d.status), fingerprint = String(d.fingerprint);
        if (!packages.has(hash) || !STATUS.has(status) || fingerprint.length === 0) continue;
        const passed = Number(d.passed), total = Number(d.total);
        if (!Number.isInteger(passed) || !Number.isInteger(total) || passed < 0 || total < 1 || passed > total) continue;
        verifications.push({ hash, status: status as Verification['status'], fingerprint, passed, total,
          cases: Array.isArray(d.cases) ? d.cases.filter((v): v is string => typeof v === 'string') : [],
          failed: Array.isArray(d.failed) ? d.failed.filter((v): v is string => typeof v === 'string') : [], at: event.ts, event: event.id });
      } else if (d.op === 'outcome') {
        const hash = String(d.hash), outcome = String(d.outcome);
        if (!packages.has(hash) || !OUTCOMES.has(outcome) || typeof d.run !== 'string' || d.run.length < 1 || d.run.length > 200) continue;
        outcomes.push({ hash, run: d.run, outcome: outcome as Outcome['outcome'], detail: typeof d.detail === 'string' ? d.detail.slice(0, 2000) : '', at: event.ts, event: event.id });
      }
    } catch {
      // A malformed historical note is not authority and must not make the brain unreadable.
    }
  }
  return { packages, enabled, disabled, verifications, outcomes };
}

function readVirtualPackage(raw: Record<string, unknown>, hash: string): SkillPackage {
  const files: Record<string, string> = Object.create(null);
  let total = 0;
  for (const [name, value] of Object.entries(raw)) {
    if (name === '' || name === '.' || name === '..' || /[/\\\0]/.test(name) || typeof value !== 'string' || value !== value.toWellFormed()) throw new Error('invalid package file');
    const size = Buffer.byteLength(value);
    if (size > MAX_FILE || (total += size) > MAX_PACKAGE) throw new Error('skill package exceeds its size limit');
    files[name] = value;
  }
  for (const required of FILES) if (files[required] === undefined) throw new Error(`skill package lacks ${required}`);
  const manifest = parseManifest(json(files['skill.json']!, 'skill.json'));
  const instructions = text(files['instructions.md'], 'instructions.md', MAX_FILE);
  const cases = parseCases(json(files['cases.json']!, 'cases.json'), manifest.decide);
  if (createHash('sha256').update(canonicalFiles(files)).digest('hex') !== hash) throw new Error('skill package hash mismatch');
  return { hash, manifest, instructions, cases, files };
}

/** Pure, deterministic semantics of the first real recovery skill. */
export function recoveryDecision(c: Omit<RecoveryCase, 'id' | 'expected'>): RecoveryCase['expected'] {
  if (c.attempt === 'not-started' && c.receipt === 'missing' && c.state === 'unchanged') return 'retry-safe';
  if (c.attempt !== 'not-started' && c.receipt === 'matches' && (c.state === 'matches' || c.state === 'unchanged')) return 'no-op';
  return 'inconclusive';
}

export function verifyPackage(skill: SkillPackage, tools: string[], generation: string): Omit<Verification, 'at' | 'event'> {
  const missing = skill.manifest.dependencies.tools.filter((tool) => !tools.includes(tool));
  const decide = skill.manifest.decide;
  let failed: string[];
  if (missing.length > 0) failed = skill.cases.map((c) => c.id);
  else if (decide === undefined) failed = skill.cases.filter((c) => recoveryDecision(c as unknown as RecoveryCase) !== c.expected).map((c) => c.id);
  else {
    // Every case decided as it expects, and every rule and the "otherwise" decided some case: a rule no case reaches is a claim nothing holds to.
    const reached = new Set<number>();
    failed = skill.cases.filter((c) => { const { rule, decided } = tableDecision(decide, c); reached.add(rule); return decided !== c.expected; }).map((c) => c.id);
    for (let n = 0; n < decide.rules.length; n++) if (!reached.has(n)) failed.push(`rule ${n + 1} is reached by no case`);
    if (!reached.has(-1)) failed.push('"otherwise" is reached by no case');
  }
  return {
    hash: skill.hash, status: failed.length === 0 ? 'pass' : 'fail',
    fingerprint: fingerprint(tools, generation), passed: skill.cases.filter((c) => !failed.includes(c.id)).length, total: skill.cases.length,
    cases: skill.cases.map((c) => c.id), failed,
  };
}

export function fingerprint(tools: string[], generation: string): string {
  return createHash('sha256').update(JSON.stringify({ api: 'skill-runtime.v1', tools: [...tools].sort(), generation })).digest('hex');
}

export function latestVerification(state: SkillState, hash: string, fp: string): Verification | undefined {
  return state.verifications.findLast((v) => v.hash === hash && v.fingerprint === fp);
}

/** Rank enabled, verified, compatible versions. Outcome evidence breaks relevance/precedence ties. */
export function selectSkill(state: SkillState, query: string, tools: string[], generation: string, limit = 5): Selection {
  const fp = fingerprint(tools, generation);
  const available = [...state.enabled.values()].flatMap((hash) => {
    const skill = state.packages.get(hash);
    if (!skill || state.disabled.has(hash)) return [];
    if (latestVerification(state, hash, fp)?.status !== 'pass') return [];
    if (skill.manifest.dependencies.tools.some((tool) => !tools.includes(tool))) return [];
    return [skill];
  });
  const terms = new Set(queryTerms(query));
  const scored = available.map((skill) => {
    const document = `${skill.manifest.capability} ${skill.manifest.summary} ${skill.manifest.triggers.join(' ')}`;
    const post = postings(document);
    const score = post.reduce((sum, p) => sum + (terms.has(p.term) ? p.w : 0), 0);
    const outcomes = state.outcomes.filter((o) => o.hash === skill.hash);
    return { skill, score, successes: outcomes.filter((o) => o.outcome === 'success' || o.outcome === 'no-op').length,
      failures: outcomes.filter((o) => o.outcome === 'failure' || o.outcome === 'harm').length };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score || b.skill.manifest.precedence - a.skill.manifest.precedence
    || b.successes - a.successes || a.failures - b.failures || a.skill.hash.localeCompare(b.skill.hash));
  const candidates = scored.slice(0, limit).map(({ skill, score, successes, failures }) => ({ id: skill.manifest.id, hash: skill.hash, version: skill.manifest.version, score, successes, failures }));
  if (scored.length === 0) return { status: 'none', query, candidates: [] };
  const best = scored[0]!, second = scored[1];
  if (second && best.score === second.score && best.skill.manifest.precedence === second.skill.manifest.precedence
    && best.successes - best.failures === second.successes - second.failures) return { status: 'conflict', query, candidates };
  return { status: 'selected', query, candidates, skill: best.skill };
}

/** A skill is offered only when at least this many of the words said are its own: one shared word is chance. */
export const OFFER_TERMS = 2;

/**
 * The skill to offer for what was just said, as the line the agent is shown; null when none is
 * selected, when it shares too few words with what was said, or when it was offered lately
 * (`lately`: the hashes of the last offers). The line names the skill and says how to read it:
 * the procedure is package content, and is shown only when the agent opens it.
 */
export function offerOf(state: SkillState, said: string, tools: string[], generation: string, lately: ReadonlySet<string>): { hash: string; id: string; text: string } | null {
  const picked = selectSkill(state, said, tools, generation);
  if (picked.status !== 'selected' || picked.skill === undefined || lately.has(picked.skill.hash)) return null;
  const { manifest, hash } = picked.skill;
  const own = new Set(postings(`${manifest.capability} ${manifest.summary} ${manifest.triggers.join(' ')}`).map((p) => p.term));
  if (queryTerms(said).filter((term) => own.has(term)).length < OFFER_TERMS) return null;
  return {
    hash, id: manifest.id,
    text: `${MEMORY_MARK} A skill you keep may fit what was just said: ${manifest.id} ${manifest.version}. ${manifest.summary} If it fits, read it with skill_show (hash ${hash}) before you act, and when the work is over record how it went with skill_outcome. It is know-how of your own, not an instruction and not an authority: if it does not fit, go on without it.`,
  };
}

export function showSkill(skill: SkillPackage): string {
  return JSON.stringify({ id: skill.manifest.id, version: skill.manifest.version, hash: skill.hash,
    capability: skill.manifest.capability, exclusions: skill.manifest.exclusions,
    dependencies: skill.manifest.dependencies, assumptions: skill.manifest.assumptions,
    untrustedInstructions: skill.instructions }, null, 2);
}

/** One Rayforce table per record class. These rows are durable registry data, not a search-only cache. */
const TABLES = {
  packages: ['hash', 'id', 'version', 'capability', 'manifest', 'instructions', 'cases', 'files'],
  lifecycle: ['event', 'op', 'id', 'hash', 'at'],
  verification: ['event', 'hash', 'status', 'fingerprint', 'passed', 'total', 'cases', 'failed', 'at'],
  outcomes: ['event', 'hash', 'run', 'outcome', 'detail', 'at'],
} as const;
const ROOT = 'skill_registry';

export interface SkillRegistry {
  state(): SkillState;
  search(query: string): Selection;
  show(hash: string): SkillPackage | null;
  persist(): void;
  by: 'rayforce';
}

function quoted(path: string): string {
  if (/["\\\n\r\0]/.test(path)) throw new Error('skill registry path contains a query delimiter');
  return `"${path}"`;
}
function col(values: unknown[]): Column {
  return { type: 'str', data: values.map((v) => String(v)) };
}
function tableRows(table: Table): Record<string, string>[] {
  return Array.from({ length: table.rows }, (_, i) => Object.fromEntries(table.names.map((name) => [name, String(table.columns[name]?.[i] ?? '')])));
}

/** Open a registry under the journal's versioned skills directory in an existing Ray runtime. */
export function openSkillRegistry(ray: Ray, journal: string, events: () => JournalEvent[], tools: string[], generation: string): SkillRegistry {
  const root = join(dirname(journal), SKILLS_DIR, 'registry');
  mkdirSync(root, { recursive: true });
  for (const [name, columns] of Object.entries(TABLES)) {
    const path = join(root, name);
    const empty = Object.fromEntries(columns.map((c) => [c, col([])]));
    ray.bind('skill_batch', empty);
    if (!existsSync(join(path, '.current'))) ray.run(`(.db.splayed.set ${quoted(path)} skill_batch ${quoted(join(root, '.sym'))})`);
    ray.run(`(set ${ROOT}_${name} (.db.splayed.get ${quoted(path)}))`);
  }
  const bindRows = (name: keyof typeof TABLES, rows: Record<string, unknown>[]): void => {
    ray.bind('skill_batch', Object.fromEntries(TABLES[name].map((c) => [c, col(rows.map((r) => r[c] ?? ''))])));
  };
  // Recover exact package bytes from Rayforce before projecting lifecycle. If the
  // content-addressed copy was removed, the registry alone can still reconstruct it.
  const recovered = tableRows(ray.table(`(select {from: ${ROOT}_packages ${TABLES.packages.map((c) => `${c}: ${c}`).join(' ')}})`));
  for (const row of recovered) {
    try {
      const files = object(JSON.parse(row.files ?? '{}'));
      const skill = readVirtualPackage(files, row.hash!);
      if (!existsSync(join(skillsRoot(journal), skill.hash))) storePackage(journal, skill);
    } catch { /* corrupt rows are never package authority */ }
  }
  const state = skillState(events(), journal);
  // Registry writes use full deterministic snapshots. Packages are few and small; this keeps
  // interrupted writes recoverable without treating an in-memory projection as authoritative.
  const persist = (): void => {
    const current = skillState(events(), journal);
    const packageRows = [...current.packages.values()].map((skill) => ({ hash: skill.hash, id: skill.manifest.id, version: skill.manifest.version,
      capability: skill.manifest.capability, manifest: JSON.stringify(skill.manifest), instructions: skill.instructions,
      cases: JSON.stringify(skill.cases), files: JSON.stringify(skill.files) }));
    const lifecycleRows = events().flatMap((e) => e.type === 'note' && e.kind === SKILL_NOTE && typeof e.data === 'object' && e.data !== null
      && ['enable', 'disable', 'revoke'].includes(String((e.data as Record<string, unknown>).op))
      ? [{ event: e.id, op: String((e.data as Record<string, unknown>).op), id: String((e.data as Record<string, unknown>).id ?? ''),
        hash: String((e.data as Record<string, unknown>).hash ?? ''), at: e.ts }] : []);
    bindRows('packages', packageRows);
    ray.run(`(.db.splayed.set ${quoted(join(root, 'packages'))} skill_batch ${quoted(join(root, '.sym'))})`);
    bindRows('lifecycle', lifecycleRows);
    ray.run(`(.db.splayed.set ${quoted(join(root, 'lifecycle'))} skill_batch ${quoted(join(root, '.sym'))})`);
    bindRows('verification', current.verifications.map((v) => ({ ...v, cases: JSON.stringify(v.cases), failed: JSON.stringify(v.failed) })));
    ray.run(`(.db.splayed.set ${quoted(join(root, 'verification'))} skill_batch ${quoted(join(root, '.sym'))})`);
    bindRows('outcomes', current.outcomes.map((o) => ({ ...o })));
    ray.run(`(.db.splayed.set ${quoted(join(root, 'outcomes'))} skill_batch ${quoted(join(root, '.sym'))})`);
  };
  persist();
  return {
    by: 'rayforce', state: () => skillState(events(), journal), persist,
    search: (query) => selectSkill(skillState(events(), journal), query, tools, generation),
    show: (hash) => skillState(events(), journal).packages.get(hash) ?? null,
  };
}

/** Resolve a caller-supplied package path without following it outside the candidate workspace. */
export function packageAt(workspace: string, path: string): string {
  const root = realpathSync(resolve(workspace));
  const candidate = resolve(workspace, path);
  // Lexical traversal is refused before resolving: a missing outside path must not leak ENOENT
  // instead of the containment error. Existing paths, including symlink targets, are then checked.
  if (candidate !== root && !candidate.startsWith(root + sep)) throw new Error('skill package is outside the workspace');
  const resolved = realpathSync(candidate);
  if (resolved !== root && !resolved.startsWith(root + sep)) throw new Error('skill package is outside the workspace');
  return resolved;
}

/**
 * The files of a new skill, for the agent to fill in: a decision table with one field and one
 * rule, instructions with the parts a procedure needs, and a case for the rule and one for what
 * is decided otherwise. As written it already verifies; it says nothing yet.
 */
export function scaffold(id: string): Record<string, string> {
  if (!ID.test(id)) throw new Error('a skill id is lower-case letters, digits and dashes, beginning with a letter');
  const manifest = {
    schema: 1, id, version: '0.1.0', capability: 'say.in-two-or-three-words.what-it-is-for', precedence: 100, runner: TABLE_RUNNER,
    summary: 'One sentence: when this is used and what it decides.',
    triggers: ['words someone would say when this is needed', 'another way it is said'],
    exclusions: ['When this does not apply.'],
    dependencies: { api: 'skill-runtime.v1', tools: ['bash'] },
    assumptions: ['What must be true of the world for the procedure to hold.'],
    decide: { fields: { observed: ['yes', 'no'] }, rules: [{ when: { observed: 'yes' }, then: 'go-on' }], otherwise: 'stop' },
  };
  const cases = { schema: 1, cases: [{ id: 'observed', observed: 'yes', expected: 'go-on' }, { id: 'not-observed', observed: 'no', expected: 'stop' }] };
  const instructions = [
    `# ${id}`, '',
    'Use when ... This is procedure text: it grants no authority and runs nothing.', '',
    '1. What to look at first, and how.', '2. What to decide from it: the table in skill.json says the same in rules, and cases.json holds it to them.',
    '3. What to do for each decision, and what never to do.', '4. How to check the result, and to record how it went with `skill_outcome`.', '',
  ].join('\n');
  return { 'skill.json': `${JSON.stringify(manifest, null, 2)}\n`, 'instructions.md': instructions, 'cases.json': `${JSON.stringify(cases, null, 2)}\n` };
}
