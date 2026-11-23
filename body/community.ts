import type { JournalEvent } from '../brain/journal';
import { toRayNs, type Column, type Ray, type Table } from '../brain/ray';
import { contacts, CONTACT_KIND } from './participants';

// The community the agent lives in, laid out for asking questions of. Every message the chat
// layer hears, on any service, is journaled as one small note: who said it, where, how it
// addressed the agent. From those notes a table is built in the database the agent's memory
// already runs on (brain/ray.ts), and what the agent is told of the people around it is asked of
// that table: how often it heard someone and answered them, who talks with whom, which places
// are alive, who has gone quiet, how each circle of its owner's stands.
//
// Nothing here is the truth. The journal is, and the table is made from its notes every time the
// process starts, so there is nothing on disk to disagree with it. Two things about a message are
// worked out when the table is made, because they depend on what came after or before it: whether
// the agent answered it, and whom it followed. Everything else is a question put to the table.
//
// Without the database the same questions are answered by going through the rows here, which
// gives the same answers and grows slower with every day. Only statements written in this file
// are ever evaluated; whatever arrived from outside goes over as data in a column.

export const HEARD_KIND = 'chat.heard.v1';
/** How a message addressed the agent, as the chat layer judged it (body/chat.ts). */
export type How = 'own' | 'dm' | 'mention' | 'quote' | 'name' | 'follow' | 'none';

export interface Heard {
  service: string;
  /** The service's own id for the message. */
  id: number;
  /** Where it was said, down to the thread, and what people call that place. */
  place: string;
  where: string;
  /** Who said it, by the service's id, and the name it gives them. */
  sender: string;
  name: string;
  how: How;
}

/** A message is answered by the agent's next message in the same place, when that comes within this long. */
const ANSWER_MS = 30 * 60_000;
/** One message follows another when it comes in the same place, from someone else, within this long. */
const FOLLOW_MS = 10 * 60_000;

interface Row { ts: number; who: string; name: string; place: string; where: string; own: boolean; addressed: boolean; answered: boolean; prev: string; how: How }

// Two measures of a person, both counted and neither guessed.
//
// The tie is between that person and the agent. Every message of theirs adds to it by how it
// addressed the agent: most when said to it alone, less for a mention or a quote, very little for
// talk in a room the agent only sat in; and an answer of the agent's adds more than any of them,
// because a tie is what goes both ways. Each message counts for half as much every HALF_LIFE_DAYS
// without being renewed, so a tie that is not kept up fades. It is said as 0 to 100.
//
// Importance is that person's standing among the others, whatever they are to the agent: how many
// different people speak after them, how much they are heard, and in how many places, each
// against whoever is highest in it. It is said as 0 to 100 as well, and 100 is only "the most
// here", not a judgement of anyone.
const WEIGHT: Record<How, number> = { own: 0, dm: 3, mention: 2.5, quote: 2, name: 1.5, follow: 1.5, none: 0.25 };
const ANSWER_WEIGHT = 2;
export const HALF_LIFE_DAYS = 21;
/** The raw weight at which a tie is said as about 63 of 100. */
const TIE_SCALE = 12;
const DAY_MS = 86_400_000;
/** A tie's raw weight as a number from 0 to 100. */
export const tieOf = (raw: number): number => Math.round(100 * (1 - Math.exp(-raw / TIE_SCALE)));
/** How a tie is said in a word. */
export const tieWord = (tie: number): string => (tie >= 60 ? 'strong' : tie >= 25 ? 'steady' : tie > 0 ? 'slight' : 'none');

export interface Indicators { heard: number; first: string | null; last: string | null; answered: number }
export interface Person {
  who: string; name: string; heard: number; addressed: number; answered: number; places: number; first: string; last: string;
  /** The tie between them and the agent, and their standing among the others: each 0 to 100. */
  tie: number;
  importance: number;
  /** How many different others speak after them. */
  reach: number;
}
export interface Place { where: string; messages: number; speakers: number; mine: number; last: string }
export interface Pair { who: string; after: string; times: number }
export interface Circle { circle: string; people: number; heard: number; answered: number }

export interface Community {
  /** Takes in what the journal has gained. Cheap when nothing was heard meanwhile. */
  refresh(events: JournalEvent[]): void;
  /** `database` when the table answers, `rows` when they are gone through here. */
  by: 'database' | 'rows';
  messages(): number;
  /** What was heard of these accounts together: one contact may have several. */
  indicators(keys: string[]): Indicators;
  /** The tie and the importance of these accounts together, or null when nothing was heard of them. */
  standing(keys: string[]): { tie: number; importance: number } | null;
  /** Everyone heard, the most heard first. */
  people(limit?: number): Person[];
  places(): Place[];
  /** Who speaks after whom, the most frequent first: the nearest thing the journal holds to who talks with whom. */
  pairs(limit?: number): Pair[];
  /** Those heard before and not since `sinceMs`. */
  quiet(sinceMs: number): Person[];
  /** The owner's circles, with those in none last. */
  circles(): Circle[];
}

const iso = (ns: unknown): string => new Date(Number(BigInt(ns as bigint) / 1_000_000n) + Date.UTC(2000, 0, 1)).toISOString();
const num = (cells: unknown, i: number): number => Number((cells as ArrayLike<number | bigint>)[i] ?? 0);
const str = (cells: unknown, i: number): string => String((cells as ArrayLike<unknown>)[i] ?? '');

/** The names the table and what is asked of it are bound to in the database. */
const TABLE = 'com_heard', ASKED = 'com_asked', CIRCLES = 'com_circles';

/** The kinds of notes the community is made from. Asked for, not set down once: this file and the one the contacts are in read each other. */
export const communityReads = (): readonly string[] => [HEARD_KIND, CONTACT_KIND];

export function openCommunity(ray: Ray | null, events: JournalEvent[] = [], clock: () => number = Date.now): Community {
  const rows: Row[] = [];
  const seen = new Set<string>();
  /** The rows of each place still waiting for an answer, and its last speaker. */
  const open = new Map<string, { waiting: Row[]; last: Row | null }>();
  let taken = 0, bound = -1, circled = '', boundAt = 0;
  /** A message's weight in its sender's tie with the agent, as of now. */
  const weigh = (r: Row, now: number): number => (r.own ? 0 : (WEIGHT[r.how] + (r.answered ? ANSWER_WEIGHT : 0)) * 0.5 ** (Math.max(0, now - r.ts) / (HALF_LIFE_DAYS * DAY_MS)));
  let circleOf = new Map<string, string>();

  function take(e: JournalEvent): void {
    if (e.type !== 'note' || e.kind !== HEARD_KIND || typeof e.data !== 'object' || e.data === null) return;
    const d = e.data as Partial<Heard>;
    if (typeof d.service !== 'string' || !Number.isSafeInteger(d.id) || typeof d.sender !== 'string' || typeof d.place !== 'string') return;
    // A message taken twice, after a stimulus that could not be journaled, is one message.
    const key = `${d.service}:${d.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const ts = Date.parse(e.ts);
    const place = `${d.service}:${d.place}`;
    const at = open.get(place) ?? { waiting: [], last: null };
    const row: Row = {
      ts, who: `${d.service}:${d.sender}`, name: typeof d.name === 'string' ? d.name.slice(0, 200) : d.sender, place, where: typeof d.where === 'string' ? d.where.slice(0, 200) : d.place,
      own: d.how === 'own', addressed: d.how !== 'own' && d.how !== 'none' && d.how !== undefined, answered: false,
      prev: at.last !== null && at.last.who !== `${d.service}:${d.sender}` && ts - at.last.ts <= FOLLOW_MS ? at.last.who : '',
      how: d.how !== undefined && d.how in WEIGHT ? d.how : 'none',
    };
    if (row.own) {
      // The agent spoke here: what it had heard in this place a little while before is answered.
      for (const waiting of at.waiting) if (ts - waiting.ts <= ANSWER_MS) waiting.answered = true;
      at.waiting = [];
    } else at.waiting.push(row);
    at.last = row;
    open.set(place, at);
    rows.push(row);
  }

  function refresh(given: JournalEvent[]): void {
    // Only what was heard and the contacts are read (`communityReads`), and how far the reading has got is counted in
    // those: so the whole journal and its notes of these kinds alone, handed over in any mixture, come to the same.
    const all = given.filter((e) => e.type === 'note' && communityReads().includes(e.kind));
    for (; taken < all.length; taken++) take(all[taken]!);
    // The circles are the owner's to change at any moment: a few notes, read again each time.
    const held = contacts(all);
    const next = new Map<string, string>();
    for (const [key, c] of held) if (c.circle !== undefined) next.set(key, c.circle);
    const print = [...next].map(([key, circle]) => `${key}=${circle}`).join('\n');
    if (print !== circled) { circled = print; circleOf = next; bound = -1; }
  }

  /** Hands the rows over, when they have changed since the last question. */
  function table(): boolean {
    if (ray === null) return false;
    // The weights fade with time, so the rows are handed over again after an hour even when none was added.
    if (bound === rows.length && clock() - boundAt < 3_600_000) return true;
    const now = clock();
    const flag = (of: (r: Row) => boolean): Column => ({ type: 'bool', data: Uint8Array.from(rows, (r) => (of(r) ? 1 : 0)) });
    try {
      ray.bind(TABLE, {
        ts: { type: 'timestamp', data: BigInt64Array.from(rows, (r) => toRayNs(new Date(r.ts).toISOString())) },
        who: { type: 'sym', data: rows.map((r) => r.who) }, place: { type: 'sym', data: rows.map((r) => r.place) }, prev: { type: 'sym', data: rows.map((r) => r.prev) },
        own: flag((r) => r.own), addressed: flag((r) => r.addressed), answered: flag((r) => r.answered), follows: flag((r) => r.prev !== ''),
        n: { type: 'i64', data: BigInt64Array.from(rows, () => 1n) },
        tw: { type: 'f64', data: Float64Array.from(rows, (r) => weigh(r, now)) },
      });
      boundAt = now;
      const keys = [...circleOf.keys()];
      ray.bind(CIRCLES, { who: { type: 'sym', data: keys }, circle: { type: 'sym', data: keys.map((key) => circleOf.get(key)!) } });
      bound = rows.length;
      return true;
    } catch {
      // A database that will not take the rows is no reason not to answer: they are gone through here instead.
      return false;
    }
  }
  const ask = (source: string): Table | null => {
    if (rows.length === 0 || !table()) return null;
    try { return ray!.table(source); } catch { return null; }
  };

  const nameOf = (): Map<string, string> => { const names = new Map<string, string>(); for (const r of rows) names.set(r.who, r.name); return names; };
  const whereOf = (): Map<string, string> => { const names = new Map<string, string>(); for (const r of rows) names.set(r.place, r.where); return names; };
  const heard = (): Row[] => rows.filter((r) => !r.own);

  /** Everyone heard, from the table or from the rows: the same people with the same counts either way. */
  function everyone(): Person[] {
    const names = nameOf();
    const t = ask(`(select {from: ${TABLE} where: (== own false) by: who heard: (sum n) addressed: (sum (as 'I64 addressed)) answered: (sum (as 'I64 answered)) first: (min ts) last: (max ts) tie: (sum tw)})`);
    // How many different others speak after each: the people who answer them.
    const after = ask(`(select {from: (select {from: ${TABLE} where: follows by: {prev: prev who: who} k: (sum n)}) by: prev reach: (count who)})`);
    const spread = ask(`(select {from: (select {from: ${TABLE} where: (== own false) by: {who: who place: place} k: (sum n)}) by: who places: (count place)})`);
    if (t !== null && spread !== null) {
      const places = new Map<string, number>();
      for (let i = 0; i < spread.rows; i++) places.set(str(spread.columns.who, i), num(spread.columns.places, i));
      const reach = new Map<string, number>();
      if (after !== null) for (let i = 0; i < after.rows; i++) reach.set(str(after.columns.prev, i), num(after.columns.reach, i));
      return ranks(Array.from({ length: t.rows }, (_, i): Person => {
        const who = str(t.columns.who, i);
        return { who, name: names.get(who) ?? who, heard: num(t.columns.heard, i), addressed: num(t.columns.addressed, i), answered: num(t.columns.answered, i), places: places.get(who) ?? 0, first: iso((t.columns.first as BigInt64Array)[i]), last: iso((t.columns.last as BigInt64Array)[i]),
          tie: tieOf(Number((t.columns.tie as Float64Array)[i] ?? 0)), importance: 0, reach: reach.get(who) ?? 0 };
      }));
    }
    const now = clock();
    const followers = new Map<string, Set<string>>();
    for (const r of rows) if (r.prev !== '') followers.set(r.prev, (followers.get(r.prev) ?? new Set()).add(r.who));
    const by = new Map<string, Row[]>();
    for (const r of heard()) by.set(r.who, [...(by.get(r.who) ?? []), r]);
    return ranks([...by].map(([who, of]): Person => ({
      who, name: names.get(who) ?? who, heard: of.length, addressed: of.filter((r) => r.addressed).length, answered: of.filter((r) => r.answered).length,
      places: new Set(of.map((r) => r.place)).size, first: new Date(Math.min(...of.map((r) => r.ts))).toISOString(), last: new Date(Math.max(...of.map((r) => r.ts))).toISOString(),
      tie: tieOf(of.reduce((sum, r) => sum + weigh(r, now), 0)), importance: 0, reach: followers.get(who)?.size ?? 0,
    })));
  }
  /** Importance is said against whoever is highest in each of its three parts, so it is worked out over everyone at once. */
  function ranks(people: Person[]): Person[] {
    const most = (of: (p: Person) => number): number => Math.max(1, ...people.map(of));
    const [reach, heardMost, places] = [most((p) => p.reach), most((p) => p.heard), most((p) => p.places)];
    for (const p of people) p.importance = Math.round(100 * (0.5 * p.reach / reach + 0.3 * p.heard / heardMost + 0.2 * p.places / places));
    return people;
  }
  const ranked = (people: Person[]): Person[] => people.sort((a, b) => b.heard - a.heard || a.who.localeCompare(b.who));

  refresh(events);
  return {
    refresh,
    get by() { return ray !== null && table() ? 'database' as const : 'rows' as const; },
    messages: () => rows.length,
    indicators(keys) {
      if (keys.length === 0 || rows.length === 0) return { heard: 0, first: null, last: null, answered: 0 };
      if (table()) {
        try {
          // The accounts go over as a column, never as part of the statement: they are ids a service gave.
          ray!.bind(ASKED, { keys: { type: 'sym', data: keys } });
          const t = ray!.table(`(select {from: ${TABLE} where: (and (== own false) (in who (at ${ASKED} 'keys))) heard: (sum n) answered: (sum (as 'I64 answered)) first: (min ts) last: (max ts)})`);
          const count = t.rows === 0 ? 0 : num(t.columns.heard, 0);
          return count === 0 ? { heard: 0, first: null, last: null, answered: 0 } : { heard: count, answered: num(t.columns.answered, 0), first: iso((t.columns.first as BigInt64Array)[0]), last: iso((t.columns.last as BigInt64Array)[0]) };
        } catch { /* gone through below */ }
      }
      const of = heard().filter((r) => keys.includes(r.who));
      return of.length === 0 ? { heard: 0, first: null, last: null, answered: 0 }
        : { heard: of.length, answered: of.filter((r) => r.answered).length, first: new Date(Math.min(...of.map((r) => r.ts))).toISOString(), last: new Date(Math.max(...of.map((r) => r.ts))).toISOString() };
    },
    standing(keys) {
      const of = everyone().filter((p) => keys.includes(p.who));
      if (of.length === 0) return null;
      // Several accounts of one contact: their ties add as raw weight, and the contact stands as high as its highest account.
      const raw = of.reduce((sum, p) => sum - TIE_SCALE * Math.log(Math.max(1e-9, 1 - Math.min(99.99, p.tie) / 100)), 0);
      return { tie: tieOf(raw), importance: Math.max(...of.map((p) => p.importance)) };
    },
    people: (limit = 30) => ranked(everyone()).slice(0, limit),
    places() {
      const names = whereOf();
      const t = ask(`(select {from: ${TABLE} by: place messages: (sum n) mine: (sum (as 'I64 own)) last: (max ts)})`);
      const spread = ask(`(select {from: (select {from: ${TABLE} where: (== own false) by: {place: place who: who} k: (sum n)}) by: place speakers: (count who)})`);
      let found: Place[];
      if (t !== null && spread !== null) {
        const speakers = new Map<string, number>();
        for (let i = 0; i < spread.rows; i++) speakers.set(str(spread.columns.place, i), num(spread.columns.speakers, i));
        found = Array.from({ length: t.rows }, (_, i): Place => {
          const place = str(t.columns.place, i);
          return { where: names.get(place) ?? place, messages: num(t.columns.messages, i), mine: num(t.columns.mine, i), speakers: speakers.get(place) ?? 0, last: iso((t.columns.last as BigInt64Array)[i]) };
        });
      } else {
        const by = new Map<string, Row[]>();
        for (const r of rows) by.set(r.place, [...(by.get(r.place) ?? []), r]);
        found = [...by].map(([place, of]): Place => ({ where: names.get(place) ?? place, messages: of.length, mine: of.filter((r) => r.own).length, speakers: new Set(of.filter((r) => !r.own).map((r) => r.who)).size, last: new Date(Math.max(...of.map((r) => r.ts))).toISOString() }));
      }
      return found.sort((a, b) => b.messages - a.messages || a.where.localeCompare(b.where));
    },
    pairs(limit = 20) {
      const names = nameOf();
      const t = ask(`(select {from: ${TABLE} where: follows by: {who: who prev: prev} times: (sum n)})`);
      const found: Pair[] = t !== null
        ? Array.from({ length: t.rows }, (_, i): Pair => ({ who: str(t.columns.who, i), after: str(t.columns.prev, i), times: num(t.columns.times, i) }))
        : [...rows.filter((r) => r.prev !== '').reduce((by, r) => by.set(`${r.who}\n${r.prev}`, (by.get(`${r.who}\n${r.prev}`) ?? 0) + 1), new Map<string, number>())].map(([key, times]): Pair => ({ who: key.split('\n')[0]!, after: key.split('\n')[1]!, times }));
      return found.sort((a, b) => b.times - a.times || a.who.localeCompare(b.who) || a.after.localeCompare(b.after)).slice(0, limit)
        .map((p) => ({ who: names.get(p.who) ?? p.who, after: names.get(p.after) ?? p.after, times: p.times }));
    },
    quiet: (sinceMs) => ranked(everyone().filter((p) => Date.parse(p.last) < sinceMs)),
    circles() {
      const t = ask(`(select {from: (left-join ['who] (select {from: ${TABLE} where: (== own false) by: who heard: (sum n) answered: (sum (as 'I64 answered))}) ${CIRCLES}) by: circle people: (count who) heard: (sum heard) answered: (sum answered)})`);
      const found: Circle[] = t !== null && circleOf.size > 0
        ? Array.from({ length: t.rows }, (_, i): Circle => ({ circle: str(t.columns.circle, i), people: num(t.columns.people, i), heard: num(t.columns.heard, i), answered: num(t.columns.answered, i) }))
        : [...everyone().reduce((by, p) => { const c = circleOf.get(p.who) ?? ''; const at = by.get(c) ?? { circle: c, people: 0, heard: 0, answered: 0 }; at.people += 1; at.heard += p.heard; at.answered += p.answered; return by.set(c, at); }, new Map<string, Circle>()).values()];
      return found.sort((a, b) => (a.circle === '' ? 1 : b.circle === '' ? -1 : b.heard - a.heard || a.circle.localeCompare(b.circle)));
    },
  };
}
