import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TAIL_CHARS, beat, follower, rest, type Pulse } from '../../brain/pulse';

// The pulse: what the brain says of a request while it is under way, for the owner's terminal.

const ASKED = '2026-11-13T10:00:00.000Z';
const line = (event: unknown): string => `event: x\ndata: ${JSON.stringify(event)}\n\n`;

test('a stream is followed as it arrives: reasoning, writing and a tool call are told apart, with the end of what came; what is not understood is still counted', () => {
  const said: Omit<Pulse, 'at'>[] = [];
  const feed = follower(ASKED, (p) => said.push(p));
  feed(line({ type: 'response.created' }));
  expect(said.at(-1)).toEqual({ asked: ASKED, step: 'receiving', received: line({ type: 'response.created' }).length });
  feed(line({ type: 'response.reasoning_summary_text.delta', delta: 'First the ' }));
  feed(line({ type: 'response.reasoning_summary_text.delta', delta: 'tests.' }));
  expect(said.at(-1)).toMatchObject({ step: 'reasoning', tail: 'First the tests.' });
  // A new kind of thing starts its tail afresh.
  feed(line({ type: 'response.output_text.delta', delta: 'Done' }));
  expect(said.at(-1)).toMatchObject({ step: 'writing', tail: 'Done' });
  feed(line({ type: 'response.function_call_arguments.delta', delta: '{"command":' }));
  expect(said.at(-1)!.step).toBe('calling');
  expect(said.at(-1)!.tail).toBeUndefined();
  // An event cut in two by the network is read when its second half comes, and a line that is no JSON is passed over.
  const whole = line({ type: 'response.output_text.delta', delta: 'more' });
  feed(whole.slice(0, 30));
  expect(said.at(-1)!.step).toBe('calling');
  feed(`${whole.slice(30)}data: not json\n`);
  expect(said.at(-1)).toMatchObject({ step: 'writing', tail: 'more' });
  expect(said.at(-1)!.received).toBeGreaterThan(300);
  // The tail is the end of what came, however much that was.
  feed(line({ type: 'response.output_text.delta', delta: 'x'.repeat(TAIL_CHARS * 5) }));
  expect(said.at(-1)!.tail!.length).toBe(TAIL_CHARS * 2);
});

test('the pulse is one file, written over, with its tail on one line; it is written at once when the step changes and not more often than a few times a second otherwise; and it is gone when the request ends', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'teneral-pulse-')), 'deep', 'pulse.json');
  const read = (): Pulse => JSON.parse(readFileSync(file, 'utf8')) as Pulse;
  beat({ asked: ASKED, step: 'asked', received: 0 }, file, 1000);
  expect(read()).toEqual({ asked: ASKED, step: 'asked', received: 0, at: new Date(1000).toISOString() });
  beat({ asked: ASKED, step: 'reasoning', received: 10, tail: 'one\ntwo   three' }, file, 1001);
  expect(read()).toMatchObject({ step: 'reasoning', received: 10, tail: 'one two three' });
  beat({ asked: ASKED, step: 'reasoning', received: 20, tail: 'later' }, file, 1100);
  expect(read().received).toBe(10);
  beat({ asked: ASKED, step: 'reasoning', received: 30, tail: 'later still' }, file, 1500);
  expect(read()).toMatchObject({ received: 30, tail: 'later still' });
  rest(file);
  expect(existsSync(file)).toBe(false);
  // With no file named there is nothing to do, and nothing is thrown for one that cannot be written.
  beat({ asked: ASKED, step: 'asked', received: 0 }, undefined);
  beat({ asked: ASKED, step: 'asked', received: 0 }, '/proc/nowhere/pulse.json');
  rest('/proc/nowhere/pulse.json');
});
