import type { JournalEvent } from './journal';
import { FACT_KIND } from './known';
import type { Column, Ray, Table } from './ray';
import { boundAs, type Projection } from './store';

// Whom and what the agent's life is about, as a graph in the database: people, projects and
// repositories are nodes, the stretches of its life are nodes, and an edge runs from each of the
// first to every stretch that it named them in.
//
//   mentions   seq kind key name episode   one row for each naming: by a memory as it was formed, or by a fact about a person
//   nodes      n kind key name             the ones named and the stretches, numbered from 0 for the graph
//   edges      src dst kind key name       from one named to a stretch, each pair once, with whom it is from
//   stamp      n                           how many times the tables were made: what a reader watches to build its graph anew
//
// The namings are the agent's own (brain/sleep.ts asks for them with a memory; a fact names whom it
// is about). Nothing is read out of what was said by guessing: finding a name in the text of the
// memories is a question put to the database when one is asked about (`aboutFrom`), not a tie.

export const ENTITIES = 'entities';
/** Changed with the step below or with the columns. */
export const ENTITIES_VERSION = 1;
/** Someone or something a stretch was about: `{ kind, name, episode }`, the stretch named by its first event. */
export const ENTITY_KIND = 'memory.entity.v1';
export const ENTITY_KINDS = ['person', 'project', 'repo'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
/** The notes the graph is made from. */
export const ENTITY_NOTES: readonly string[] = [ENTITY_KIND, FACT_KIND];
/** The longest name kept. */
export const NAME_CHARS = 120;

export interface Mention { seq: number; kind: EntityKind; key: string; name: string; episode: string }
/** One that is named, and in how many stretches. */
export interface Entity { kind: EntityKind; name: string; stretches: number }
/** What is tied to one that was asked about. */
export interface About {
  /** Those the name is the name of: a person and a project may share one. */
  named: { kind: EntityKind; name: string }[];
  /** The stretches that named it, each by its first event, oldest first. */
  stretches: string[];
  /** The others named in those same stretches. */
  beside: { kind: EntityKind; name: string }[];
  /** The stretches whose memory has the name in its words though it did not name it, each by its first event. */
  told: string[];
}

/** What a name is known by: its letters, lower-cased, with single spaces. */
export const keyOf = (name: string): string => name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** The naming an event makes, or null. */
export function mentionOf(e: JournalEvent, seq: number): Mention | null {
  if (e.type !== 'note' || typeof e.data !== 'object' || e.data === null) return null;
  const d = e.data as { kind?: unknown; name?: unknown; episode?: unknown; about?: unknown };
  const made = (kind: EntityKind, said: unknown): Mention | null => {
    const name = typeof said === 'string' ? said.replace(/\s+/g, ' ').trim().slice(0, NAME_CHARS) : '';
    return name === '' || typeof d.episode !== 'string' || d.episode === '' ? null : { seq, kind, key: keyOf(name), name, episode: d.episode };
  };
  if (e.kind === ENTITY_KIND) return ENTITY_KINDS.includes(d.kind as EntityKind) ? made(d.kind as EntityKind, d.name) : null;
  // A fact says whom it is about only of people (brain/sleep.ts, and the tool `know`).
  if (e.kind === FACT_KIND) return made('person', d.about);
  return null;
}

const strs = (data: string[]): Column => ({ type: 'str', data });
const syms = (data: string[]): Column => ({ type: 'sym', data });
const nums = (data: number[]): Column => ({ type: 'i64', data: BigInt64Array.from(data, BigInt) });

/** The namings, each (one named, stretch) pair once, the first naming of it kept. */
export function distinct(mentions: Mention[]): Mention[] {
  const seen = new Set<string>();
  return mentions.filter((m) => {
    const pair = `${m.kind}\n${m.key}\n${m.episode}`;
    if (seen.has(pair)) return false;
    seen.add(pair);
    return true;
  });
}

/** The graph, kept in tables. The store drives it (brain/store.ts). */
export function entitiesProjection(): Projection {
  let mentions: Mention[] = [];
  let made = 0;
  let tables: Record<string, Record<string, Column>> | null = null;
  return {
    name: ENTITIES,
    version: ENTITIES_VERSION,
    reset() {
      mentions = [];
      made = 0;
      tables = null;
    },
    step(e: JournalEvent, seq: number): boolean {
      const mention = mentionOf(e, seq);
      if (mention === null) return false;
      mentions.push(mention);
      tables = null;
      return true;
    },
    tables() {
      if (tables !== null) return tables;
      const all = distinct(mentions);
      const numbered = new Map<string, { n: number; kind: string; key: string; name: string }>();
      const node = (kind: string, key: string, name: string): number => {
        const id = `${kind}\n${key}`;
        let found = numbered.get(id);
        if (found === undefined) numbered.set(id, found = { n: numbered.size, kind, key, name });
        return found.n;
      };
      const [src, dst] = [all.map((m) => node(m.kind, m.key, m.name)), all.map((m) => node('stretch', m.episode, ''))];
      const nodes = [...numbered.values()];
      made += 1;
      tables = {
        mentions: { seq: nums(mentions.map((m) => m.seq)), kind: syms(mentions.map((m) => m.kind)), key: strs(mentions.map((m) => m.key)), name: strs(mentions.map((m) => m.name)), episode: strs(mentions.map((m) => m.episode)) },
        nodes: { n: nums(nodes.map((one) => one.n)), kind: syms(nodes.map((one) => one.kind)), key: strs(nodes.map((one) => one.key)), name: strs(nodes.map((one) => one.name)) },
        edges: { src: nums(src), dst: nums(dst), kind: syms(all.map((m) => m.kind)), key: strs(all.map((m) => m.key)), name: strs(all.map((m) => m.name)) },
        stamp: { n: nums([made]) },
      };
      return tables;
    },
    restore(read: Record<string, Table>) {
      const t = read.mentions?.columns ?? {};
      const seq = t.seq as BigInt64Array | undefined ?? new BigInt64Array(0);
      const [kind, key, name, episode] = [t.kind, t.key, t.name, t.episode].map((column) => column as string[] | undefined ?? []) as [string[], string[], string[], string[]];
      mentions = Array.from(seq, (at, i) => ({ seq: Number(at), kind: kind[i] as EntityKind, key: key[i]!, name: name[i]!, episode: episode[i]! })).sort((a, b) => a.seq - b.seq);
      made = Number((read.stamp?.columns.n as BigInt64Array | undefined)?.[0] ?? 0);
      tables = null;
    },
  };
}

const text = (t: Table, column: string): string[] => t.columns[column] as string[] | undefined ?? [];

/** The graph in the database, built anew when the tables were made again. One for each connection. */
export function entityGraph(ray: Ray): { ready(): void } {
  let stamp = -1;
  return {
    ready() {
      const now = Number(((ray.table(`(select {from: ${boundAs(ENTITIES, 'stamp')}})`).columns.n as BigInt64Array | undefined) ?? [])[0] ?? 0);
      if (now === stamp) return;
      if (stamp !== -1) ray.run('(do (.graph.free mem_entity_graph) null)');
      ray.run(`(do (set mem_entity_graph (.graph.build ${boundAs(ENTITIES, 'edges')} 'src 'dst)) null)`);
      stamp = now;
    },
  };
}

/** Everyone and everything named, with the number of stretches each is named in, the most named first: counted by the database. */
export function entitiesFrom(ray: Ray): Entity[] {
  const t = ray.table(`(select {from: (select {from: ${boundAs(ENTITIES, 'edges')} by: {kind: kind key: key} stretches: (count dst) name: (first name)}) desc: stretches})`);
  const counts = t.columns.stretches as ArrayLike<bigint | number> | undefined ?? [];
  return text(t, 'name').map((name, i) => ({ kind: text(t, 'kind')[i] as EntityKind, name, stretches: Number(counts[i] ?? 0) }));
}

/**
 * What is tied to `name`: asked of the graph. The stretches are one step from the node, the others
 * named beside it two steps, there and back; and the memories that have the name in their words
 * are found by the database reading their text (`memories` is the table of them, brain/memory-table.ts).
 */
export function aboutFrom(ray: Ray, graph: { ready(): void }, name: string, memories: string): About {
  graph.ready();
  // What is asked about goes over as a column, never as part of the statement.
  ray.bind('mem_entity_asked', { qk: strs([keyOf(name)]), qn: strs([name.trim()]) });
  const nodes = boundAs(ENTITIES, 'nodes');
  const named = ray.table(`(select {from: ${nodes} where: (and (!= kind 'stretch) (== key (first (at mem_entity_asked 'qk))))})`);
  const ns = [...(named.columns.n as BigInt64Array | undefined ?? [])].map(Number);
  const stretches = new Set<string>();
  const beside = new Map<string, { kind: EntityKind; name: string }>();
  for (const n of ns) {
    for (const id of text(ray.table(`(select {from: ${nodes} where: (in n (at (.graph.expand mem_entity_graph ${n} 0) '_dst))})`), 'key')) stretches.add(id);
    const near = ray.table(`(select {from: ${nodes} where: (and (!= kind 'stretch) (in n (at (.graph.var-expand mem_entity_graph ${n} 2 2 2) '_end)))})`);
    text(near, 'name').forEach((other, i) => { if (!ns.includes(Number((near.columns.n as BigInt64Array)[i]))) beside.set(`${text(near, 'kind')[i]}\n${text(near, 'key')[i]}`, { kind: text(near, 'kind')[i] as EntityKind, name: other }); });
  }
  const told = name.trim() === '' ? [] : text(ray.table(`(select {from: ${memories} where: (>= (str-find data (first (at mem_entity_asked 'qn))) 0)})`), 'from');
  return {
    named: text(named, 'name').map((one, i) => ({ kind: text(named, 'kind')[i] as EntityKind, name: one })),
    stretches: [...stretches],
    beside: [...beside.values()],
    told: told.filter((id) => !stretches.has(id)),
  };
}

/** The same from namings held here, as a journal read through gives them. */
export function entitiesOf(mentions: Mention[]): Entity[] {
  const by = new Map<string, Entity>();
  for (const m of distinct(mentions)) {
    const id = `${m.kind}\n${m.key}`;
    const held = by.get(id);
    if (held === undefined) by.set(id, { kind: m.kind, name: m.name, stretches: 1 });
    else held.stretches += 1;
  }
  return [...by.values()].sort((a, b) => b.stretches - a.stretches);
}

export function aboutOf(mentions: Mention[], name: string, memories: { from: string; text: string }[]): About {
  const all = distinct(mentions);
  const key = keyOf(name);
  const mine = all.filter((m) => m.key === key);
  const stretches = new Set(mine.map((m) => m.episode));
  const names = new Map<string, { kind: EntityKind; name: string }>();
  // Each by the name it was first written with.
  for (const m of all) if (!names.has(`${m.kind}\n${m.key}`)) names.set(`${m.kind}\n${m.key}`, { kind: m.kind, name: m.name });
  const pick = (of: Mention[]): { kind: EntityKind; name: string }[] => [...new Set(of.map((m) => `${m.kind}\n${m.key}`))].map((id) => names.get(id)!);
  return {
    named: pick(mine),
    stretches: [...stretches],
    beside: pick(all.filter((m) => m.key !== key && stretches.has(m.episode))),
    told: name.trim() === '' ? [] : memories.filter((m) => m.text.includes(name.trim()) && !stretches.has(m.from)).map((m) => m.from),
  };
}
