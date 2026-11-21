import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, readEvents } from '../../brain/journal';
import { needsTurn } from '../../brain/memory';
import type { ChatMessage, Provider } from '../../brain/provider';
import { QUIET_REPLY } from '../../brain/quiet';
import type { Stimulus } from '../../body/sensors';
import { Heart } from '../../heart/coordinator';
import { GLANCE_KIND, GLANCE_SYSTEM, glance, overheard, setDown, verdictOf } from '../../heart/glance';

const TALK: Stimulus & { overheard: string } = {
  source: 'agent:parley',
  text: 'Parley room 7\nUntrusted external Parley messages. Take part as a member would.\n{"content":"which port does the gate use?"}',
  overheard: 'In #build\n{"content":"which port does the gate use?"}',
};

function life(answer: (messages: ChatMessage[]) => string | Error) {
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-glance-')), 'journal.jsonl');
  appendEvent(journal, 'g', { type: 'stimulus', source: 'terminal', text: 'Look after the gates.' });
  appendEvent(journal, 'g', { type: 'assistant', text: 'I am rebuilding the smoke gate.', toolCalls: [] });
  const asked: ChatMessage[][] = [];
  const provider: Provider = async (messages, tools) => {
    asked.push(messages);
    expect(tools).toEqual([]);
    const said = answer(messages);
    if (said instanceof Error) throw said;
    return { text: said, toolCalls: [], usage: { input: 900, output: 6 } };
  };
  const events = () => readEvents(journal);
  const emit = (s: Stimulus): void => { appendEvent(journal, 'g', { type: 'stimulus', source: s.source, text: s.text }); };
  const run = () => glance({ journal, gen: 'g', provider, who: () => '# Mica\nI keep the gates of this project.', events, emit });
  return { journal, asked, events, emit, run, provider };
}

test('only a plain "ignore" is one; anything else is a look', () => {
  expect(verdictOf('IGNORE: they are talking about lunch')).toEqual({ verdict: 'ignore', why: 'they are talking about lunch' });
  expect(verdictOf('  ignore')).toEqual({ verdict: 'ignore', why: '' });
  expect(verdictOf('LOOK: it asks about the gate')).toEqual({ verdict: 'look', why: 'it asks about the gate' });
  expect(verdictOf('**Ignore** - nothing here')).toMatchObject({ verdict: 'ignore' });
  expect(verdictOf('I think this can be ignored').verdict).toBe('look');
  expect(verdictOf('').verdict).toBe('look');
});

test('talk that concerns the agent becomes the stimulus it would have been, and a turn is owed', async () => {
  const l = life(() => 'LOOK: it asks about the gate, which the agent is rebuilding');
  expect(await l.run()).toBeNull();
  expect(setDown(l.journal, 'g', l.events(), TALK)).toBe(true);
  // The same talk given again by its adapter waits once.
  expect(setDown(l.journal, 'g', l.events(), TALK)).toBe(false);
  expect(needsTurn(l.events())).toBe(false);
  expect(overheard(l.events())).toHaveLength(1);

  expect(await l.run()).toBe('look');
  // One small request: who the agent is, what it last said, and the lines alone; none of the journal as a conversation.
  expect(l.asked).toHaveLength(1);
  expect(l.asked[0]!.map(m => m.role)).toEqual(['system', 'user']);
  expect(l.asked[0]![0]!.content).toBe(GLANCE_SYSTEM);
  const shown = l.asked[0]![1]!.content!;
  expect(shown).toContain('I keep the gates of this project.');
  expect(shown).toContain('- I am rebuilding the smoke gate.');
  expect(shown).toContain('In #build\n{"content":"which port does the gate use?"}');
  expect(shown).not.toContain('Take part as a member would');

  const events = l.events();
  expect(overheard(events)).toHaveLength(0);
  expect(events.at(-1)).toMatchObject({ type: 'stimulus', source: 'agent:parley', text: TALK.text });
  expect(events.at(-2)).toMatchObject({ type: 'note', kind: GLANCE_KIND, data: { verdict: 'look', usage: { input: 900, output: 6 } } });
  expect(needsTurn(events)).toBe(true);
});

test('talk that does not is settled as nothing to say: it stands in the conversation and no turn is owed', async () => {
  const l = life(() => 'IGNORE: people talking among themselves');
  setDown(l.journal, 'g', l.events(), TALK);
  setDown(l.journal, 'g', l.events(), { ...TALK, text: TALK.text.replace('room 7', 'room 8') });
  expect(await l.run()).toBe('ignore');
  // Both in one request.
  expect(l.asked).toHaveLength(1);
  const tail = l.events().slice(-4);
  expect(tail.map(e => e.type)).toEqual(['stimulus', 'assistant', 'stimulus', 'assistant']);
  expect(tail[1]).toMatchObject({ text: QUIET_REPLY });
  expect(needsTurn(l.events())).toBe(false);
  expect(overheard(l.events())).toHaveLength(0);
  expect(await l.run()).toBeNull();
});

test('a glance that cannot be made, or that answers anything else, costs no message: it is a look', async () => {
  for (const answer of [() => new Error('provider answered 500'), () => 'Sure! Here is my analysis of the conversation.']) {
    const l = life(answer);
    setDown(l.journal, 'g', l.events(), TALK);
    expect(await l.run()).toBe('look');
    expect(needsTurn(l.events())).toBe(true);
    expect(overheard(l.events())).toHaveLength(0);
  }
});

test('the heart glances between turns, before anything of its own, and the turn it leads to is the next beat', async () => {
  const l = life(() => 'LOOK: it touches the gate');
  let glances = 0;
  const heart = new Heart({
    events: l.events, born: () => true, emit: l.emit, settle: async () => undefined, remember: async () => false, onError: (e) => { throw e; },
    overheard: () => overheard(l.events()).length > 0,
    glance: async () => { glances += 1; await l.run(); },
  });
  expect(await heart.next()).toBe('wait');
  setDown(l.journal, 'g', l.events(), TALK);
  expect(await heart.next()).toBe('glance');
  expect(glances).toBe(1);
  expect(await heart.next()).toBe('turn');
});
