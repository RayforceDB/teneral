import type { ChatMessage, Provider, Reply } from './provider';
type Usage = NonNullable<Reply['usage']>;
import { words } from './recall';

// Whether something newly set down is something already held.
//
// The request that forms a memory reads a stretch and writes what it found: facts, and the
// projects and repositories the stretch was about. It is the wrong place to decide whether a fact
// is one already held in other words: it is shown only the newest of what is known, and it is
// busy with the stretch. So that is decided apart, by a second and much smaller request that never
// sees the stretch: it is given each new thing with the few held things nearest to it in their
// words, picked here by counting, and says of each only whether it is the same, takes the place of
// one, or is new. It joins nothing else and writes nothing itself.
//
// What comes of it: a fact said again is not set down twice, the one held is marked as seen to
// hold; a fact that changed names the one it replaces, though the forming request did not; and a
// project called by a slightly different name is the node it already is. People are not decided
// here: a person is a contact, by the owner's word (body/participants.ts).

/** What the judge came to for one stretch: `{ episode, asked, same, replaced, usage? }`. Kept so that what it costs and what it does can be counted. */
export const IDENTITY_KIND = 'memory.identity.v1';

/** Something held, as it is put before the judge: the mark it is named by and what it says. */
export interface Held { mark: string; text: string }
/** Something new, with the held things nearest to it. */
export interface Asked { text: string; near: Held[] }
export type Verdict = { is: 'new' } | { is: 'same'; mark: string } | { is: 'replaces'; mark: string };

/** How many held things are put beside one new thing, and the least a held thing must share with it to be one of them. */
export const NEAR_MAX = 5;
const SHARED_MIN = 2;
export const SHARE_MIN = 0.4;
/** Words too common to tell two things apart. */
const COMMON = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were', 'has', 'have', 'had', 'not', 'but', 'its', 'his', 'her', 'their', 'you', 'your', 'when', 'what', 'which', 'who', 'will', 'can', 'into', 'than', 'then', 'they', 'them', 'does', 'did', 'она', 'его', 'это', 'как', 'что', 'для', 'при', 'или', 'они', 'the']);

const telling = (text: string): string[] => [...new Set(words(text).filter((word) => word.length >= 3 && !COMMON.has(word)))];

/**
 * The held things nearest to `text` in their words: those that share at least two telling words
 * with it, and with them half of what the lighter of the two weighs, a word counting for more the
 * fewer held things have it; the nearest first. No model is asked, and words are all it knows: two things
 * said with no word in common are not found here.
 */
export function nearest(text: string, held: Held[], most = NEAR_MAX): Held[] {
  const mine = telling(text);
  if (mine.length === 0 || held.length === 0) return [];
  const theirs = held.map((one) => ({ one, has: new Set(telling(one.text)) }));
  const holders = new Map<string, number>();
  for (const { has } of theirs) for (const word of has) holders.set(word, (holders.get(word) ?? 0) + 1);
  const weight = (word: string): number => Math.log(1 + (held.length + 0.5) / ((holders.get(word) ?? 0) + 0.5));
  const sum = (list: Iterable<string>): number => [...list].reduce((total, word) => total + weight(word), 0);
  const whole = sum(mine);
  return theirs
    .map(({ one, has }) => {
      const shared = mine.filter((word) => has.has(word));
      // Against the lighter of the two: a short thing wholly within a long one is near it.
      return { one, shared: shared.length, share: sum(shared) / Math.max(1e-9, Math.min(whole, sum(has))) };
    })
    .filter((scored) => scored.shared >= SHARED_MIN && scored.share >= SHARE_MIN)
    .sort((a, b) => b.share - a.share)
    .slice(0, most)
    .map((scored) => scored.one);
}

const SYSTEM = [
  'You decide whether things newly written down are things already held. You are not shown where they come from, and you do not judge whether they are true.',
  'For each numbered new item you are given a few held items that share words with it. Answer one line for each new item, in order, and nothing else:',
  '<number>: same <mark>      when the held item says the same thing, whatever the words: nothing would be learned by keeping both',
  '<number>: replaces <mark>  when both are about the same matter and the new one says how it stands now, so that the held one no longer holds',
  '<number>: new              when neither is so',
  'Sharing a subject is not being the same: two different things about one person, project or place are both kept, so that is new. '
  + 'When in doubt, say new: a thing kept twice costs little, and a thing wrongly taken for another is lost.',
].join('\n');

/** The request put to the judge. */
export function judgeRequest(what: string, asked: Asked[]): ChatMessage[] {
  const body = asked.map((one, i) => `${i + 1}. ${one.text}\n${one.near.map((held) => `   ${held.mark}: ${held.text}`).join('\n')}`).join('\n\n');
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: `These are ${what}. New items, each with the held items nearest to it:\n\n${body}` }];
}

/** The verdicts in a reply: one for each item asked about. A line not in form, or naming a mark that was not put beside that item, is `new`. */
export function verdicts(reply: string, asked: Asked[]): Verdict[] {
  const out: Verdict[] = asked.map(() => ({ is: 'new' }));
  for (const line of reply.split('\n')) {
    const m = /^\s*(\d+)\s*[:.)-]\s*(same|replaces|new)\b\s*`?([A-Za-z][0-9A-Za-z]{1,16})?/i.exec(line);
    if (m === null) continue;
    const at = Number(m[1]) - 1;
    const one = asked[at];
    if (one === undefined) continue;
    const is = m[2]!.toLowerCase() as 'same' | 'replaces' | 'new';
    if (is === 'new') out[at] = { is };
    else if (m[3] !== undefined && one.near.some((held) => held.mark === m[3])) out[at] = { is, mark: m[3] };
  }
  return out;
}

/**
 * Asks the judge about `items`, those that have something near them; the rest are new without
 * asking, and when none has, nobody is asked. A request that fails decides nothing: everything is
 * new, as it was before there was a judge. Returns a verdict for each item, in order.
 */
export async function judge(provider: Provider, what: string, items: Asked[], signal?: AbortSignal): Promise<{ verdicts: Verdict[]; usage?: Usage; asked: number }> {
  const all: Verdict[] = items.map(() => ({ is: 'new' }));
  const doubtful = items.map((item, at) => ({ item, at })).filter(({ item }) => item.near.length > 0);
  if (doubtful.length === 0) return { verdicts: all, asked: 0 };
  try {
    const reply = await provider(judgeRequest(what, doubtful.map(({ item }) => item)), [], signal && { signal });
    if (reply.toolCalls.length > 0) return { verdicts: all, asked: doubtful.length };
    verdicts(reply.text, doubtful.map(({ item }) => item)).forEach((verdict, i) => { all[doubtful[i]!.at] = verdict; });
    return { verdicts: all, asked: doubtful.length, ...(reply.usage ? { usage: reply.usage } : {}) };
  } catch {
    return { verdicts: all, asked: doubtful.length };
  }
}
