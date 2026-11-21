import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JournalEvent } from '../brain/journal';
import { PAIRED_SOURCE, ownerAccounts, pairedLine } from '../brain/owners';
import type { ChatMessage } from './chat';
import type { Stimulus } from './sensors';

// How an account in a chat service becomes the owner's without anyone looking up an id. The owner
// asks for a code in their terminal (`/owner zulip`, keeper/pairing.ts), which reaches this body as
// a file in the owner's directory and never the model; then they send the code to the agent in a
// direct message from the account. The terminal shows that it is the owner who asks, the message
// that they hold the account, and the service itself says whose message it is. What comes of it is
// one stimulus in the journal (brain/owners.ts), and from then on what that account writes is the
// owner's word. The same for every service: an adapter only hands over its messages (body/chat.ts).

/** What the owner's terminal leaves for a pairing: the service, the code, and until when it holds. */
export interface Pairing { service: string; code: string; until: number }

/** A code as it is compared: its letters and digits alone, so that spaces, a dash, or the service's markup around it do not matter. */
export const bare = (text: string): string => text.replace(/<[^>]*>/g, ' ').replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();

/** What a pairing file holds, or null when it is not one. */
export function readPairing(text: string): Pairing | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (typeof v.service !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(v.service) || typeof v.code !== 'string' || bare(v.code).length < 8 || typeof v.until !== 'number' || !Number.isFinite(v.until)) return null;
    return { service: v.service, code: bare(v.code), until: v.until };
  } catch { return null; }
}

/**
 * The note that a code was used, holding its hash and never the code. A service may hand the same
 * message over again after a restart; by this it is known for the used code it is and not shown as talk.
 */
export const SPENT_KIND = 'owner.pairing.spent.v1';
const hashOf = (service: string, code: string): string => createHash('sha256').update(`${service}\n${code}`).digest('hex');

/** How many wrong codes one pairing bears before it is void. */
const TRIES = 5;

export interface OwnersOptions {
  /** The journal as it stands, read when this starts. */
  events: readonly JournalEvent[];
  emit: (s: Stimulus) => void;
  /** Accounts the installation's settings name, by service: they hold whatever the journal says. */
  settled?: Record<string, readonly string[]>;
  /** Where what is known is written for the owner's terminal to show. Nothing reads it for authority. */
  status?: string;
  /** Sets down that a code was used (a note of SPENT_KIND). Absent, a used code is only remembered while this runs. */
  note?: (data: { service: string; hash: string }) => void;
  now?: () => number;
  log?: (line: string) => void;
}

/** The owner's accounts, and the pairings that wait for their code. */
export class Owners {
  private readonly paired: Map<string, Set<string>>;
  private readonly waiting = new Map<string, Pairing & { tries: number }>();
  private readonly services = new Set<string>();
  private readonly spent = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly o: OwnersOptions) {
    this.paired = ownerAccounts(o.events);
    for (const e of o.events) {
      if (e.type !== 'note' || e.kind !== SPENT_KIND) continue;
      const hash = (e.data as { hash?: unknown } | null)?.hash;
      if (typeof hash === 'string') this.spent.add(hash);
    }
    this.now = o.now ?? Date.now;
  }

  /** A service whose chat is listened to: the owner's terminal lists it though it has no account yet. */
  serves(service: string): void {
    this.services.add(service);
    this.write();
  }

  private settled(service: string): readonly string[] { return this.o.settled?.[service] ?? []; }

  /** Whether this account of this service is the owner's. */
  is(service: string, id: string): boolean {
    return this.settled(service).includes(id) || this.paired.get(service)?.has(id) === true;
  }

  /** Whether any account of this service is the owner's. */
  any(service: string): boolean {
    return this.settled(service).length > 0 || (this.paired.get(service)?.size ?? 0) > 0;
  }

  /** The owner asked, in their terminal, for an account of a service to be paired. */
  offer(p: Pairing): void {
    if (p.until <= this.now()) return;
    this.waiting.set(p.service, { ...p, tries: 0 });
    this.o.log?.(`[owner] waiting for the pairing code in a direct message on ${p.service}`);
  }

  /** A line of the owner's reached the journal: it may name an account, or take the accounts of a service back. */
  heard(events: readonly JournalEvent[]): void {
    const now = ownerAccounts(events);
    this.paired.clear();
    for (const [service, ids] of now) this.paired.set(service, ids);
    this.write();
  }

  /**
   * Whether this message is the code of a pairing that waits. It is then used up, the account is
   * the owner's from here on, and the message is not shown to the agent as talk. Only a direct
   * message from someone else can be one; a wrong code that looks like one counts against the pairing.
   */
  claim(service: string, m: ChatMessage): boolean {
    if (m.own || m.kind !== 'direct' || m.sender === undefined) return false;
    const said = bare(m.text).replace(/^PAIR(?=.{8,}$)/, '');
    // A code already used, handed over once more: still not talk, and it pairs nobody.
    if (said.length >= 8 && said.length <= 64 && this.spent.has(hashOf(service, said))) return true;
    const p = this.waiting.get(service);
    if (p === undefined) return false;
    if (p.until <= this.now()) { this.waiting.delete(service); return false; }
    if (said !== p.code) {
      // Only what could have been meant as a code is counted: ordinary talk is not an attempt.
      if (said.length === p.code.length && ++p.tries >= TRIES) {
        this.waiting.delete(service);
        this.o.log?.(`[owner] ${TRIES} wrong codes on ${service}; that pairing is void, and /owner ${service} gives a new one`);
      }
      return false;
    }
    this.waiting.delete(service);
    this.spent.add(hashOf(service, p.code));
    this.o.note?.({ service, hash: hashOf(service, p.code) });
    this.paired.set(service, (this.paired.get(service) ?? new Set()).add(m.sender.id));
    this.write();
    this.o.log?.(`[owner] the ${service} account ${m.sender.id} is paired as the owner's`);
    this.o.emit({
      source: PAIRED_SOURCE,
      text: `${pairedLine(service, m.sender.id)}\nThis line is not typed: I asked for a pairing code in my terminal and sent it to you from my ${service} account, ${m.sender.name}. `
        + `The service itself says the message was that account's. From now on what it writes to you on ${service} is my word, as a line in my terminal is: you need not ask me to confirm it in the terminal. `
        + `Tell me there, in one line of a direct message, that the account is paired.`,
    });
    return true;
  }

  private write(): void {
    if (this.o.status === undefined) return;
    try {
      const services: Record<string, string[]> = {};
      for (const service of [...new Set([...this.services, ...this.paired.keys(), ...Object.keys(this.o.settled ?? {})])].sort()) {
        services[service] = [...new Set([...this.settled(service), ...(this.paired.get(service) ?? [])])];
      }
      mkdirSync(dirname(this.o.status), { recursive: true });
      writeFileSync(`${this.o.status}.tmp`, JSON.stringify({ services }));
      renameSync(`${this.o.status}.tmp`, this.o.status);
    } catch (err) {
      this.o.log?.(`[owner] could not write ${this.o.status}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
