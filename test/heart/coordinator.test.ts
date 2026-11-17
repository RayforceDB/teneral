import { expect, test } from 'bun:test';
import { Heart, afterTurn, heartCommand, pulseNeeded, type HeartState } from '../../heart/coordinator';
import { appendEvent, readEvents, type JournalEvent } from '../../brain/journal';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { known } from '../../brain/known';

const setup = () => {
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-heart-')), 'journal.jsonl');
  appendEvent(journal, 'g', { type: 'stimulus', source: 'birth', text: 'Hello.' });
  appendEvent(journal, 'g', { type: 'assistant', text: 'Here.', toolCalls: [] });
  return journal;
};

test('the heart command is one exact owner line, not an arbitrary message', () => {
  expect(heartCommand(' /heart ')).toBe(true);
  expect(heartCommand('/heart now')).toBe(false);
  expect(heartCommand('please /heart')).toBe(false);
});

test('a completed ordinary turn asks for one look; clock and interruption do not', () => {
  const state: HeartState = { look: false, pulse: false };
  const events = setup();
  afterTurn(state, readEvents(events));
  expect(state.look).toBe(true);
  const clock: HeartState = { look: false, pulse: false };
  appendEvent(events, 'g', { type: 'stimulus', source: 'clock', text: 'tick' });
  afterTurn(clock, readEvents(events));
  expect(clock.look).toBe(false);
  const stopped: HeartState = { look: false, pulse: false };
  appendEvent(events, 'g', { type: 'turn.interrupted' });
  afterTurn(stopped, readEvents(events));
  expect(stopped.look).toBe(false);
});

test('a scheduled work turn preserves an already requested look without starting another', () => {
  const state: HeartState = { look: true, pulse: false };
  const events = setup();
  appendEvent(events, 'g', { type: 'stimulus', source: 'work', text: 'Resume a waiting commitment.' });
  appendEvent(events, 'g', { type: 'assistant', text: 'Checked the dependency.', toolCalls: [] });
  afterTurn(state, readEvents(events));
  expect(state.look).toBe(true);
  const fresh: HeartState = { look: false, pulse: false };
  afterTurn(fresh, readEvents(events));
  expect(fresh.look).toBe(false);
});

test('an owner pulse is coalesced and does not call the model by itself', async () => {
  const journal = setup();
  const pulses: string[] = [];
  let remembered = 0;
  const heart = new Heart({ born: () => true, events: () => readEvents(journal), emit: s => pulses.push(s.text), reflect: async () => { throw new Error('not requested'); }, remember: async () => { remembered++; return false; }, onError: () => {} });
  heart.requestPulse(); heart.requestPulse();
  expect(await heart.next()).toBe('pulse');
  expect(pulses).toHaveLength(1);
  expect(await heart.next()).toBe('wait');
  expect(remembered).toBe(1);
});

test('reflection asks for a pulse for a newly ready task, not a recursive reflection', async () => {
  const journal = setup();
  appendEvent(journal, 'g', { type: 'stimulus', source: 'terminal', text: 'finish' });
  appendEvent(journal, 'g', { type: 'assistant', text: 'Finished.', toolCalls: [] });
  const state: HeartState = { look: false, pulse: false };
  afterTurn(state, readEvents(journal));
  expect(state.look).toBe(true);
  const heart = new Heart({ born: () => true, events: () => readEvents(journal), emit: s => appendEvent(journal, 'g', { type: 'stimulus', source: s.source, text: s.text }), reflect: async () => {
    appendEvent(journal, 'g', { type: 'note', kind: 'memory.intention.v1', data: { text: 'Do the next safe step.', origin: 'own', episode: 'fixture' } });
  }, remember: async () => false, onError: () => {} });
  heart.completed(readEvents(journal));
  expect(await heart.next()).toBe('reflect');
  expect(known(readEvents(journal)).intentions.some(i => i.origin === 'own')).toBe(true);
  expect(await heart.next()).toBe('turn');
});

test('an unchanged reflection gives one follow-up to existing waiting work, not another reflection', async () => {
  const journal = setup();
  appendEvent(journal, 'g', { type: 'stimulus', source: 'terminal', text: 'Continue the repository work.' });
  appendEvent(journal, 'g', { type: 'assistant', text: 'I have recorded the current dependency.', toolCalls: [] });
  appendEvent(journal, 'g', { type: 'note', kind: 'memory.intention.v1', data: { text: 'Publish the verified work.', work: { status: 'waiting', next: 'Check whether the current review requirement has changed.', attempts: 0, resumeAt: 0 } } });
  const heart = new Heart({ born: () => true, events: () => readEvents(journal), emit: s => appendEvent(journal, 'g', { type: 'stimulus', source: s.source, text: s.text }), reflect: async () => {}, remember: async () => false, onError: () => {} });
  heart.completed(readEvents(journal));
  expect(await heart.next()).toBe('reflect');
  expect(await heart.next()).toBe('turn');
  const pulse = readEvents(journal).find(e => e.type === 'stimulus' && e.source === 'clock');
  expect(pulse?.type === 'stimulus' && pulse.text.includes('Check whether the current review requirement has changed.')).toBe(true);
  expect(pulse?.type === 'stimulus' && pulse.text.includes('do not retry an external action without checking its receipt or new evidence')).toBe(true);
  appendEvent(journal, 'g', { type: 'assistant', text: 'Nothing new yet.', toolCalls: [] });
  expect(await heart.next()).toBe('wait');
});

test('a fresh individual waits for its first dialogue instead of starting idle work', async () => {
  const journal = join(mkdtempSync(join(tmpdir(), 'teneral-birth-heart-')), 'journal.jsonl');
  let reflected = 0;
  const heart = new Heart({ events: () => readEvents(journal), born: () => false, emit: () => { throw new Error('no agenda before birth'); }, reflect: async () => { reflected++; }, remember: async () => { throw new Error('no memory work before birth'); }, onError: () => {} });
  appendEvent(journal, 'g', { type: 'stimulus', source: 'birth', text: 'Hello.' });
  heart.requestPulse(); heart.completed(readEvents(journal));
  expect(await heart.next()).toBe('turn');
  appendEvent(journal, 'g', { type: 'assistant', text: 'Hello. What may I call you?', toolCalls: [] });
  expect(await heart.next()).toBe('wait');
  expect(reflected).toBe(0);
});
