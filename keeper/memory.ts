// The owner's `/memory`: a page on how the agent's memory stands, and the owner's own hand on it.
// What the owner says here is carried to the body as a word (brain/owned.ts) and journaled there;
// nothing on this page is asked of a model, and nothing here writes to the journal itself.

import { episodes, type Episode } from '../brain/episodes';
import type { JournalEvent } from '../brain/journal';
import { agenda, known } from '../brain/known';
import { PIN_SHARE, pinnedAmong } from '../brain/logbook';
import { DEFAULT_BUDGET } from '../brain/memory';
import { standing, type Word } from '../brain/owned';
import { remembered, type Memory, type Merge } from '../brain/remembered';
import { memoryLine } from './usage';

/** What `/memory` answers with: lines to show and, when the owner said something to be done, the word to carry over. */
export interface Answer {
  lines: string[];
  word?: Word;
}

/** A memory's mark: a letter and the first characters of its note's id, short enough to type. */
export const markOf = (id: string): string => `M${id.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`;
const when = (ts: string): string => ts.slice(0, 16).replace('T', ' ');
const brief = (text: string, most = 70): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > most ? `${line.slice(0, most - 1)}…` : line;
};
/** How many memories the page lists. The older ones are the agent's to list, with its `timeline`. */
const LISTED = 12;

const HOW = [
  '/memory pin [mark]        keep a stretch in front of the agent word for word: the one going on now, or the one a memory is of',
  '/memory unpin [mark]      let it be told as a memory again',
  '/memory withdraw <mark>   a memory or a fact does not stand; a memory is then formed again from the journal',
  '/memory back [n]          take the conversation back to before your last message, or your last n; what followed is set aside',
];

/** The page: how the memory stands, what is pinned, the latest memories, what is known and meant, each with its mark. */
function page(events: JournalEvent[], now: number): string[] {
  const all = remembered(events);
  const kept = episodes(events, all.spans).filter((e) => e.why === 'kept');
  const held = known(events);
  const pins = [...pinnedAmong(events, kept)].sort((a, b) => a - b);
  const memories = [...all.memories.values()].filter((m) => m.outcome !== 'quiet');
  const lines = [memoryLine(events, now) || 'Memory: nothing is remembered yet. An episode is remembered once it is over and the agent has nothing else to do.'];
  if (pins.length > 0) lines.push('', 'Pinned, shown to the agent as it happened:', ...pins.map((i) => `  ${when(kept[i]!.start)} to ${when(kept[i]!.end)}  ${brief(all.memories.get(kept[i]!.first)?.title ?? '')}`));
  if (all.merges.length > 0) lines.push('', 'Memories of several episodes:', ...all.merges.map((m: Merge) => `  ${markOf(m.id)}  ${when(m.start)} to ${when(m.end)}  ${brief(m.title)}`));
  if (memories.length > 0) {
    lines.push('', memories.length > LISTED ? `The latest ${LISTED} of ${memories.length} memories:` : 'Memories:');
    lines.push(...memories.slice(-LISTED).map((m: Memory) => `  ${markOf(m.id)}  ${when(m.start)}  ${m.outcome.padEnd(7)} ${brief(m.title)}`));
  }
  if (held.facts.length > 0) lines.push('', 'Facts held:', ...held.facts.map((f) => `  ${f.mark}  [${f.source}] ${brief(f.text, 90)}`));
  const todo = agenda(held, new Date(now).toISOString().slice(0, 10));
  const asks = held.intentions.filter((i) => i.waits);
  if (todo.length > 0) {
    lines.push('', "Agenda, in the order a clock tick offers it (owed: taken on for someone; own: the agent's idea; yes: an idea you allowed):");
    lines.push(...todo.map((i) => `  ${i.mark}  ${i.origin !== 'own' ? 'owed' : i.allowed === undefined ? 'own ' : 'yes '}${i.due === undefined ? '' : `  due ${i.due}`}  ${brief(i.text, 90)}`));
  }
  if (asks.length > 0) {
    lines.push('', 'Waiting for your word. Answer the agent in the conversation; an idea it is not sure of is kept until you say yes or no:');
    lines.push(...asks.map((i) => `  ${i.mark}  ${i.unsure === true ? 'idea    ' : 'question'}${i.put ? '' : '  not yet asked'}  ${brief(i.text, 90)}`));
  }
  return [...lines, '', ...HOW];
}

/** The episode a mark means: the one a memory of that mark is of. Null when no memory has it. */
function episodeOf(mark: string, events: JournalEvent[]): { first: string; title: string } | null {
  const all = remembered(events);
  const memory = [...all.memories.values()].find((m) => markOf(m.id) === mark);
  return memory === undefined ? null : { first: memory.from, title: memory.title };
}

/**
 * What the owner's `/memory <arg>` means, against the journal as it is now. A word is given only
 * for something that can be done: what cannot is refused here, with the reason, and never sent.
 */
export function memoryCommand(journaled: JournalEvent[], arg: string, now: number, budgetChars = DEFAULT_BUDGET): Answer {
  const events = standing(journaled);
  const [verb = '', ...rest] = arg.trim().split(/\s+/).filter((part) => part !== '');
  const mark = rest[0] ?? '';
  switch (verb) {
    case '':
      return { lines: page(events, now) };
    case 'pin':
    case 'unpin': {
      const all = remembered(events);
      const cut = episodes(events, all.spans);
      let target: Episode | undefined;
      let what: string;
      if (mark === '') {
        target = cut.at(-1);
        what = 'the stretch going on now';
      } else {
        const named = episodeOf(mark, events);
        if (named === null) return { lines: [`No memory has the mark ${mark}. /memory lists them.`] };
        target = cut.find((e) => e.first === named.first);
        what = `the stretch remembered as "${brief(named.title, 50)}"`;
      }
      if (target === undefined) return { lines: ['There is nothing in the journal to pin yet.'] };
      if (verb === 'unpin') return { lines: [`Unpinned: ${what} may be told as a memory again.`], word: { do: 'unpin', event: target.first } };
      // Checked here, so that a pin is refused when it is made and not broken later without a word: what is pinned has a share of the room, and no more.
      const kept = cut.filter((e) => e.why === 'kept');
      const already = [...pinnedAmong(events, kept)].reduce((sum, i) => sum + (kept[i]!.first === target!.first ? 0 : kept[i]!.chars), 0);
      const room = Math.floor(budgetChars * PIN_SHARE);
      if (already + target.chars > room) {
        return { lines: [`Not pinned: ${what} is ${target.chars} characters, and with what is pinned already (${already}) that is more than the ${room} that pinned stretches may take. Unpin something first.`] };
      }
      return {
        lines: [`Pinned: ${what} stays in front of the agent word for word (${target.chars} characters now; pinned stretches may take ${room} together).`],
        word: { do: 'pin', event: target.first },
      };
    }
    case 'withdraw': {
      if (mark === '') return { lines: ['/memory withdraw <mark> names what does not stand: a memory (M…), a fact (F…) or an intention (I…). /memory lists them.'] };
      const all = remembered(events);
      const held = known(events);
      const memory = [...all.memories.values(), ...all.merges].find((m) => markOf(m.id) === mark);
      const item = [...held.facts, ...held.intentions].find((i) => i.mark === mark);
      if (memory !== undefined) {
        const wide = 'level' in memory;
        return {
          lines: [`Withdrawn: the memory "${brief(memory.title, 60)}" does not stand. ${wide ? 'The memories it stood for are shown again.' : 'The agent forms a new one from the journal when it next has nothing else to do.'}`],
          word: { do: 'withdraw', ids: [memory.id] },
        };
      }
      if (item !== undefined) return { lines: [`Withdrawn: "${brief(item.text, 70)}" is no longer held.`], word: { do: 'withdraw', ids: [item.id] } };
      return { lines: [`Nothing held has the mark ${mark}. /memory lists them.`] };
    }
    case 'back': {
      const n = mark === '' ? 1 : Number(mark);
      if (!Number.isInteger(n) || n < 1) return { lines: ['/memory back [n] takes a whole number of your messages: /memory back 2'] };
      const mine = events.filter((e) => e.type === 'stimulus' && e.source === 'terminal');
      const to = mine.at(-n);
      if (to === undefined) return { lines: [`You have said ${mine.length} things to the agent; there are not ${n} to take back.`] };
      return {
        lines: [
          `Taken back to before "${brief((to as { text?: unknown }).text as string, 60)}" (${when(to.ts)}). What was said and done from there on is set aside: the agent no longer sees it and does not find it.`,
          'It is still in the journal, and whatever it changed outside the conversation stays changed.',
        ],
        word: { do: 'back', to: to.id },
      };
    }
    default:
      return { lines: [`/memory ${verb} is not something this does.`, ...HOW] };
  }
}
