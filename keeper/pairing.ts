import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { forgetLine } from '../brain/owners';
import { leavePairing, tell } from './owner';

// `/owner` in the owner's terminal: which of their accounts in the chat services the agent takes as
// theirs, and how one becomes so. `/owner zulip` gives a code; sent to the agent in a direct message
// from the account, it makes that account the owner's (body/pairing.ts). Nobody looks up an id, and
// no message, name or note in the service can do the same: the code is asked for here, where only
// the owner types.

/** How long a code holds. */
export const PAIRING_MS = 10 * 60_000;
// No letter or digit that is read as another: no I, L, O, 0 or 1.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newCode(random: (n: number) => number = randomInt): string {
  const at = (): string => ALPHABET[random(ALPHABET.length)]!;
  return `${at()}${at()}${at()}${at()}-${at()}${at()}${at()}${at()}`;
}

/** What the body last wrote about the services it listens to and the owner's accounts in each, or null when it has written nothing. */
export function knownOwners(root: string): Record<string, string[]> | null {
  try {
    const v = JSON.parse(readFileSync(join(root, '.teneral', 'owners.json'), 'utf8')) as { services?: unknown };
    if (typeof v.services !== 'object' || v.services === null) return null;
    const out: Record<string, string[]> = {};
    for (const [service, ids] of Object.entries(v.services)) if (Array.isArray(ids)) out[service] = ids.filter((id): id is string => typeof id === 'string');
    return out;
  } catch { return null; }
}

const HOW = 'To pair one: /owner <service> gives a code, and you send that code to the agent in a direct message from your account there.';

/** Carries out `/owner`, `/owner <service>` and `/owner forget <service>`, and answers with what to show. */
export function pairingCommand(root: string, arg: string, now: () => number = Date.now, random: (n: number) => number = randomInt): string[] {
  const known = knownOwners(root);
  if (known === null) return ['The agent has not said which chats it listens to: it is not running, or runs a generation from before pairing. Start it, or have it take the species update, and try again.'];
  const services = Object.keys(known).sort();
  const words = arg.trim().toLowerCase().split(/\s+/).filter((w) => w !== '');
  const dir = join(root, '.teneral', 'owner');
  if (words.length === 0) {
    if (services.length === 0) return ['The agent listens to no chat service, so there is no account to pair.'];
    return [
      ...services.map((s) => (known[s]!.length === 0 ? `${s}: no account of yours is known. What you write there is not taken as your word.` : `${s}: ${known[s]!.join(', ')} ${known[s]!.length === 1 ? 'is' : 'are'} yours. What ${known[s]!.length === 1 ? 'it writes' : 'they write'} there is your word.`)),
      HOW, 'To take them back: /owner forget <service>.',
    ];
  }
  const service = words[0] === 'forget' ? words[1] ?? '' : words[0]!;
  if (words.length > (words[0] === 'forget' ? 2 : 1) || !services.includes(service)) {
    return [services.length === 0 ? 'The agent listens to no chat service.' : `${service === '' ? 'Name the service' : `The agent listens to no chat called ${service}`}. It listens to: ${services.join(', ')}.`];
  }
  if (words[0] === 'forget') {
    tell(dir, forgetLine(service));
    return [`Done: the agent is told that no ${service} account you typed or paired is yours. One named in the settings (.env) stays until it is removed there.`];
  }
  const code = newCode(random);
  leavePairing(dir, { service, code, until: now() + PAIRING_MS });
  return [
    `Send this to the agent in a direct message on ${service}, from your own account, within ${PAIRING_MS / 60_000} minutes:`,
    `    ${code}`,
    'The account you send it from becomes yours for the agent: what it writes there is then your word. The agent is not shown the code.',
  ];
}

/** A typed line that is `/owner ...` carried out, or null when it is another line: for a client that asks about every line. */
export function pairingLine(root: string, line: string): string[] | null {
  const text = line.trim();
  if (text !== '/owner' && !text.startsWith('/owner ')) return null;
  try { return pairingCommand(root, text.slice('/owner'.length)); } catch (err) { return [`It could not be done: ${err instanceof Error ? err.message : String(err)}`]; }
}
