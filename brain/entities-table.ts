import type { JournalEvent } from './journal';
import { FACT_KIND, WHO, named } from './known';
import type { Column, Ray, Table } from './ray';
import { boundAs, type Projection } from './store';

// Whom and what the agent's life is about, as a graph in the database: people, projects and
// repositories are nodes, the stretches of its life are nodes, and an edge runs from each of the
// first to every stretch that it named them in.
//
//   mentions   seq kind key name who episode   one row for each naming: by a memory as it was formed, or by a fact about a person
//   nodes      n kind key name lname who       the ones named and the stretches, numbered from 0 for the graph
//   edges      src dst                     from one named to a stretch, each pair once
//   same       account root                an account the owner said is someone's other one, and the account that one is kept under
//   stamp      n                           how many times the tables were made: what a reader watches to build its graph anew
//
// A person is never a name: a channel may hold five people called Anton. Nor is a person an
// account: the same one is in Zulip and on GitHub. A person is a contact (body/participants.ts): an
// account, the service and the id it gives them (`zulip:7`, as the agent is shown them when they
// speak), together with every other account its owner said is the same one. Someone named with any
// of their accounts is one node, whatever they are called and wherever they were met. A
// person named by a name alone is a node of its own, apart from every person who is known by an
// id and from nobody else of that name, and is said to be so: it may be several people.
//
// The namings are the agent's own (brain/sleep.ts asks for them with a memory; a fact names whom it
// is about). Nothing is read out of what was said by guessing: finding a name in the text of the
// memories is a question put to the database when one is asked about (`aboutFrom`), not a tie.

export const ENTITIES = 'entities';
/** Changed with the step below or with the columns. */
export const ENTITIES_VERSION = 2; // people by contact, not by name or by account
/** Someone or something a stretch was about: `{ kind, name, episode }`, the stretch named by its first event. */
export const ENTITY_KIND = 'memory.entity.v1';
export const ENTITY_KINDS = ['person', 'project', 'repo'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
/** The notes the graph is made from. */
/** The note that says of a contact, among other things, that another account is the same one (`CONTACT_KIND` in body/participants.ts; a test holds the two equal). */
export const CONTACT_NOTE = 'chat.contact.v1';
export const ENTITY_NOTES: readonly string[] = [ENTITY_KIND, FACT_KIND, CONTACT_NOTE];

/** Which accounts are one person: every account the owner joined to another, with the one both are kept under. As `contacts` in body/participants.ts reads it. */
export function joined(alias: Map<string, string>, e: JournalEvent): boolean {
  if (e.type !== 'note' || e.kind !== CONTACT_NOTE || typeof e.data !== 'object' || e.data === null) return false;
  const d = e.data as { key?: unknown; same?: unknown };
  if (typeof d.key !== 'string' || typeof d.same !== 'string') return false;
  const root = alias.get(d.key) ?? d.key;
  if (d.same === root || alias.get(d.same) === root) return false;
  // Whatever answered as the other account answers as this one now.
  for (const [account, to] of alias) if (to === d.same) alias.set(account, root);
  alias.set(d.same, root);
  return true;
}
/** The longest name kept. */
export const NAME_CHARS = 120;

export interface Mention {
  seq: number; kind: EntityKind;
  /** What makes it one node: for a person known by an id, the service and the id; for anything else its name, lower-cased. */
  key: string;
  name: string;
  /** Of a person: the service and the id it gives them, `zulip:7`; '' when only a name was given. */
  who: string;
  episode: string;
}
/** One node: what it is called, and for a person who it is, or '' when it is known by a name alone. */
export interface Named { kind: EntityKind; name: string; who: string; /** Of a person: their other accounts, by the owner's word. */ also: string[] }
/** One that is named, and in how many stretches. */
export interface Entity extends Named { stretches: number }
/** What is tied to one that was asked about. */
export interface About {
  /** Everyone and everything the name, or the id, is of, each apart: several people may share a name. */
  found: (Named & {
    /** The stretches that named this one, each by its first event. */
    stretches: string[];
    /** The others named in those same stretches. */
    beside: Named[];
  })[];
  /** The stretches whose memory has the name in its words though it did not name it, each by its first event. */
  told: string[];
}

/** A name as it is compared: its letters, lower-cased, with single spaces. */
export const keyOf = (name: string): string => name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export { WHO, named };

/** The naming an event makes, or null. */
export function mentionOf(e: JournalEvent, seq: number): Mention | null {
  if (e.type !== 'note' || typeof e.data !== 'object' || e.data === null) return null;
  const d = e.data as { kind?: unknown; name?: unknown; who?: unknown; episode?: unknown; about?: unknown };
  const made = (kind: EntityKind, said: unknown, id: unknown): Mention | null => {
    const read = named(typeof said === 'string' ? said.replace(/\s+/g, ' ') : '');
    // Only a person is someone to a service.
    const who = kind !== 'person' ? '' : typeof id === 'string' && WHO.test(id) ? id : read.who;
    const name = (kind === 'person' ? read.name : typeof said === 'string' ? said.replace(/\s+/g, ' ').trim() : '').slice(0, NAME_CHARS);
    if ((name === '' && who === '') || typeof d.episode !== 'string' || d.episode === '') return null;
    return { seq, kind, key: who !== '' ? who : keyOf(name), name: name !== '' ? name : who, who, episode: d.episode };
  };
  if (e.kind === ENTITY_KIND) return ENTITY_KINDS.includes(d.kind as EntityKind) ? made(d.kind as EntityKind, d.name, d.who) : null;
  // A fact says whom it is about only of people (brain/sleep.ts, and the tool `know`): by who they are when it was given, by a name alone when not.
  if (e.kind === FACT_KIND) return made('person', d.about, d.who);
  return null;
}

const strs = (data: string[]): Column => ({ type: 'str', data });
const syms = (data: string[]): Column => ({ type: 'sym', data });
const nums = (data: number[]): Column => ({ type: 'i64', data: BigInt64Array.from(data, BigInt) });

/** What makes two namings one node: the kind, whether it is known by an account, and the key; an account its owner joined to another is that other. */
export const nodeOf = (m: Pick<Mention, 'kind' | 'key' | 'who'>, alias?: Map<string, string>): string => `${m.kind}\n${m.who === '' ? 'name' : 'id'}\n${m.who === '' ? m.key : alias?.get(m.who) ?? m.who}`;

/** The namings, each (one named, stretch) pair once, the first naming of it kept. */
export function distinct(mentions: Mention[], alias?: Map<string, string>): Mention[] {
  const seen = new Set<string>();
  return mentions.filter((m) => {
    const pair = `${nodeOf(m, alias)}\n${m.episode}`;
    if (seen.has(pair)) return false;
    seen.add(pair);
    return true;
  });
}

/** The graph, kept in tables. The store drives it (brain/store.ts). */
export function entitiesProjection(): Projection {
  let mentions: Mention[] = [];
  let alias = new Map<string, string>();
  let made = 0;
  let tables: Record<string, Record<string, Column>> | null = null;
  return {
    name: ENTITIES,
    version: ENTITIES_VERSION,
    reset() {
      mentions = [];
      alias = new Map();
      made = 0;
      tables = null;
    },
    step(e: JournalEvent, seq: number): boolean {
      if (joined(alias, e)) { tables = null; return true; }
      const mention = mentionOf(e, seq);
      if (mention === null) return false;
      mentions.push(mention);
      tables = null;
      return true;
    },
    tables() {
      if (tables !== null) return tables;
      const all = distinct(mentions, alias);
      const root = (who: string): string => (who === '' ? '' : alias.get(who) ?? who);
      const numbered = new Map<string, { n: number; kind: string; key: string; name: string; who: string }>();
      const node = (id: string, kind: string, key: string, name: string, who: string): number => {
        let found = numbered.get(id);
        if (found === undefined) numbered.set(id, found = { n: numbered.size, kind, key, name, who });
        // Someone known by an id is called what they were last called: people change their names, and stay who they are.
        else if (who !== '' && name !== who) found.name = name;
        return found.n;
      };
      const [src, dst] = [all.map((m) => node(nodeOf(m, alias), m.kind, m.who === '' ? m.key : root(m.who), m.name, root(m.who))), all.map((m) => node(`stretch\n${m.episode}`, 'stretch', m.episode, '', ''))];
      const nodes = [...numbered.values()];
      made += 1;
      tables = {
        mentions: { seq: nums(mentions.map((m) => m.seq)), kind: syms(mentions.map((m) => m.kind)), key: strs(mentions.map((m) => m.key)), name: strs(mentions.map((m) => m.name)), who: strs(mentions.map((m) => m.who)), episode: strs(mentions.map((m) => m.episode)) },
        nodes: { n: nums(nodes.map((one) => one.n)), kind: syms(nodes.map((one) => one.kind)), key: strs(nodes.map((one) => one.key)), name: strs(nodes.map((one) => one.name)), lname: strs(nodes.map((one) => keyOf(one.name))), who: strs(nodes.map((one) => one.who)),
          also: strs(nodes.map((one) => (one.who === '' ? '' : [...alias].filter(([, to]) => to === one.who).map(([account]) => account).join(' ')))),
        },
        edges: { src: nums(src), dst: nums(dst) },
        same: { account: strs([...alias.keys()]), root: strs([...alias.values()]) },
        stamp: { n: nums([made]) },
      };
      return tables;
    },
    restore(read: Record<string, Table>) {
      const t = read.mentions?.columns ?? {};
      const seq = t.seq as BigInt64Array | undefined ?? new BigInt64Array(0);
      const [kind, key, name, who, episode] = [t.kind, t.key, t.name, t.who, t.episode].map((column) => column as string[] | undefined ?? []) as [string[], string[], string[], string[], string[]];
      mentions = Array.from(seq, (at, i) => ({ seq: Number(at), kind: kind[i] as EntityKind, key: key[i]!, name: name[i]!, who: who[i] ?? '', episode: episode[i]! })).sort((a, b) => a.seq - b.seq);
      const accounts = read.same?.columns.account as string[] | undefined ?? [];
      alias = new Map(accounts.map((account, i) => [account, (read.same?.columns.root as string[])[i]!]));
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

const namedOf = (t: Table): Named[] => text(t, 'name').map((name, i) => ({ kind: text(t, 'kind')[i] as EntityKind, name, who: text(t, 'who')[i] ?? '', also: (text(t, 'also')[i] ?? '').split(' ').filter((account) => account !== '') }));

/** Everyone and everything named, with the number of stretches each is named in, the most named first: counted by the database. */
export function entitiesFrom(ray: Ray): Entity[] {
  const counted = ray.table(`(select {from: ${boundAs(ENTITIES, 'edges')} by: src stretches: (count dst)})`);
  const t = ray.table(`(select {from: ${boundAs(ENTITIES, 'nodes')} where: (!= kind 'stretch)})`);
  // The count is the database's; the two answers are put side by side here, by the node's number.
  const of = new Map([...(counted.columns.src as BigInt64Array | undefined ?? [])].map((src, i) => [Number(src), Number((counted.columns.stretches as ArrayLike<bigint | number>)[i])]));
  const ns = [...(t.columns.n as BigInt64Array | undefined ?? [])].map(Number);
  return namedOf(t).map((one, i) => ({ ...one, stretches: of.get(ns[i]!) ?? 0 })).sort((a, b) => b.stretches - a.stretches);
}

/**
 * What is tied to what was asked about: asked of the graph. `asked` is a name, or who a person is
 * (`zulip:7`). Each node it fits is answered apart, since a name may be of several: its stretches are
 * one step from the node, the others named beside it two steps, there and back; and the memories
 * that have the name in their words are found by the database reading their text (`memories` is the
 * table of them, brain/memory-table.ts).
 */
export function aboutFrom(ray: Ray, graph: { ready(): void }, asked: string, memories: string): About {
  graph.ready();
  // What is asked about goes over as a column, never as part of the statement.
  ray.bind('mem_entity_asked', { qk: strs([asked.trim()]), ql: strs([keyOf(asked)]), qn: strs([asked.trim()]) });
  const nodes = boundAs(ENTITIES, 'nodes');
  // Asked by an account that is someone's other one: it is the account they are kept under that is looked for.
  const kept = text(ray.table(`(select {from: ${boundAs(ENTITIES, 'same')} where: (== account (first (at mem_entity_asked 'qk)))})`), 'root')[0];
  if (kept !== undefined) ray.bind('mem_entity_asked', { qk: strs([kept]), ql: strs([keyOf(asked)]), qn: strs([asked.trim()]) });
  const fit = ray.table(`(select {from: ${nodes} where: (and (!= kind 'stretch) (or (== who (first (at mem_entity_asked 'qk))) (== lname (first (at mem_entity_asked 'ql)))))})`);
  const ns = [...(fit.columns.n as BigInt64Array | undefined ?? [])].map(Number);
  const every = new Set<string>();
  const found = namedOf(fit).map((one, i) => {
    const n = ns[i]!;
    const stretches = text(ray.table(`(select {from: ${nodes} where: (in n (at (.graph.expand mem_entity_graph ${n} 0) '_dst))})`), 'key');
    for (const id of stretches) every.add(id);
    const near = ray.table(`(select {from: ${nodes} where: (and (!= kind 'stretch) (!= n ${n}) (in n (at (.graph.var-expand mem_entity_graph ${n} 2 2 2) '_end)))})`);
    return { ...one, stretches, beside: namedOf(near) };
  });
  const told = asked.trim() === '' || WHO.test(asked.trim()) ? [] : text(ray.table(`(select {from: ${memories} where: (>= (str-find data (first (at mem_entity_asked 'qn))) 0)})`), 'from');
  return { found, told: told.filter((id) => !every.has(id)) };
}

/** The nodes of namings held here, as a journal read through gives them: each with its stretches. */
function nodesOf(mentions: Mention[], alias: Map<string, string>): Map<string, Named & { stretches: string[] }> {
  const by = new Map<string, Named & { stretches: string[] }>();
  for (const m of distinct(mentions, alias)) {
    const id = nodeOf(m, alias);
    const who = m.who === '' ? '' : alias.get(m.who) ?? m.who;
    const held = by.get(id);
    if (held === undefined) by.set(id, { kind: m.kind, name: m.name, who, also: who === '' ? [] : [...alias].filter(([, to]) => to === who).map(([account]) => account), stretches: [m.episode] });
    else {
      held.stretches.push(m.episode);
      if (m.who !== '' && m.name !== m.who) held.name = m.name;
    }
  }
  return by;
}

/** The namings and the joinings of accounts in `events`. */
export function read(events: JournalEvent[]): { mentions: Mention[]; alias: Map<string, string> } {
  const alias = new Map<string, string>();
  const mentions: Mention[] = [];
  events.forEach((e, seq) => {
    if (joined(alias, e)) return;
    const m = mentionOf(e, seq);
    if (m !== null) mentions.push(m);
  });
  return { mentions, alias };
}

/** The same from namings held here. */
export function entitiesOf({ mentions, alias }: ReturnType<typeof read>): Entity[] {
  return [...nodesOf(mentions, alias).values()].map(({ stretches, ...one }) => ({ ...one, stretches: stretches.length })).sort((a, b) => b.stretches - a.stretches);
}

export function aboutOf({ mentions, alias }: ReturnType<typeof read>, asked: string, memories: { from: string; text: string }[]): About {
  const all = [...nodesOf(mentions, alias).entries()];
  const account = alias.get(asked.trim()) ?? asked.trim();
  const fit = all.filter(([, one]) => (one.who !== '' && one.who === account) || keyOf(one.name) === keyOf(asked));
  const every = new Set(fit.flatMap(([, one]) => one.stretches));
  const found = fit.map(([id, one]) => ({
    ...one,
    beside: all.filter(([other, o]) => other !== id && o.stretches.some((st) => one.stretches.includes(st))).map(([, { stretches: _, ...o }]) => o),
  }));
  const told = asked.trim() === '' || WHO.test(asked.trim()) ? [] : memories.filter((m) => m.text.includes(asked.trim()) && !every.has(m.from)).map((m) => m.from);
  return { found, told };
}
