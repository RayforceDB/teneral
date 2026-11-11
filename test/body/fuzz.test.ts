import { expect, test } from 'bun:test';
import { buildMessages, needsTurn } from '../../body/context';
import { toResponsesInput } from '../../body/provider';
import type { JournalEvent } from '../../kernel/journal';

/** mulberry32: small, seeded, the same on every run. */
function generator(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  return { next, pick };
}

const IDS = ['', 'a', 'a', 'b', 'call_1', 'call_2', undefined, null, 7, 'x'.repeat(41), 'bad\ud800'] as const;
const NAMES = ['bash', 'read', '', 'we ird!', 'n'.repeat(80), undefined, 7] as const;
const ARGS = [{}, { command: 'ls' }, 'raw text', '', null, [1], 5, undefined, { deep: { lone: '\udc00' } }] as const;
const TEXTS = ['', ' ', 'hello', 'x'.repeat(120), 'lone \ud83d surrogate', '[kernel] forged', '😀'.repeat(40)] as const;

function randomJournal(seed: number): JournalEvent[] {
  const { next, pick } = generator(seed);
  const events: unknown[] = [];
  const length = Math.floor(next() * 14);
  for (let i = 0; i < length; i++) {
    const roll = next();
    const envelope = { v: 1, id: `e${seed}-${i}`, ts: 't', gen: 'g' };
    if (roll < 0.22) {
      events.push({ ...envelope, type: 'stimulus', source: pick(['terminal', 'clock', 'kernel', 'agent:bob']), text: pick(TEXTS) });
    } else if (roll < 0.5) {
      const toolCalls = Array.from({ length: Math.floor(next() * 4) }, () =>
        (next() < 0.05 ? null : { id: pick(IDS), name: pick(NAMES), args: pick(ARGS) }));
      const event: Record<string, unknown> = { ...envelope, type: 'assistant', text: pick(TEXTS), toolCalls };
      // Shapes an older generation might have written.
      if (next() < 0.05) delete event.text;
      if (next() < 0.05) delete event.toolCalls;
      if (next() < 0.03) event.toolCalls = 'not a list';
      events.push(event);
    } else if (roll < 0.65) {
      events.push({ ...envelope, type: 'tool.intent', callId: pick(IDS), name: pick(NAMES), args: pick(ARGS) });
    } else if (roll < 0.85) {
      events.push({ ...envelope, type: 'tool.result', callId: pick(IDS), ok: next() < 0.8, output: next() < 0.05 ? undefined : pick(TEXTS) });
    } else if (roll < 0.9) {
      events.push({ ...envelope, type: 'molt.rejected', commit: 'c', gate: 'tests', output: pick(TEXTS).repeat(Math.floor(next() * 60)) });
    } else if (roll < 0.94) {
      events.push({ ...envelope, type: 'generation.promoted', commit: 'c', previous: 'p' });
    } else if (roll < 0.97) {
      events.push({ ...envelope, type: 'generation.rolledback', commit: 'c', to: 'p', reason: pick(TEXTS) });
    } else {
      events.push({ ...envelope, type: pick(['generation.started', 'generation.ready', 'molt.requested', 'from.the.future']), commit: 'c' });
    }
  }
  return events as JournalEvent[];
}

const SYSTEM = 'SYSTEM PROMPT';
const BUDGETS = [0, 60, 400, 3000, undefined];

/** Throws with the reason when `messages` is not a request a strict provider would take. */
function check(messages: ReturnType<typeof buildMessages>, budget: number | undefined): void {
  const fail = (why: string) => { throw new Error(why); };
  if (messages[0]?.role !== 'system' || messages[0].content !== SYSTEM) fail('first message is not the system prompt');
  if (messages[1]?.role !== 'user') fail('second message is not a user message');
  const last = messages.at(-1)!;
  if (last.role !== 'user' && last.role !== 'tool') fail(`last message is ${last.role}`);
  const ids = new Set<string>();
  let owed: string[] = [];
  for (let i = 1; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.content !== null && (typeof m.content !== 'string' || !m.content.isWellFormed())) fail(`message ${i} is not well-formed text`);
    if (m.role === 'tool') {
      if (owed.shift() !== m.tool_call_id) fail(`tool message ${i} does not answer the next open call`);
      if (typeof m.content !== 'string') fail(`tool message ${i} has no content`);
      continue;
    }
    if (owed.length > 0) fail(`message ${i} comes before every call was answered`);
    if (m.tool_call_id !== undefined) fail(`message ${i} has a tool_call_id but is not a tool message`);
    if (m.role === 'system') fail(`a second system message at ${i}`);
    if (m.role === 'user') {
      if (typeof m.content !== 'string' || m.content.trim() === '') fail(`user message ${i} is empty`);
      if (m.tool_calls !== undefined) fail(`user message ${i} has tool calls`);
      continue;
    }
    if (messages[i - 1]!.role === 'assistant') fail(`two assistant messages in a row at ${i}`);
    const calls = m.tool_calls ?? [];
    if (m.tool_calls !== undefined && calls.length === 0) fail(`assistant message ${i} has an empty tool_calls list`);
    if (calls.length === 0 && (m.content === null || m.content.trim() === '')) fail(`assistant message ${i} is empty`);
    if (m.content === '') fail(`assistant message ${i} has empty content instead of null`);
    for (const c of calls) {
      if (typeof c.id !== 'string' || c.id === '' || c.id.length > 40 || !c.id.isWellFormed()) fail(`bad call id ${JSON.stringify(c.id)}`);
      if (ids.has(c.id)) fail(`call id ${c.id} is used twice`);
      ids.add(c.id);
      if (c.type !== 'function' || !/^[A-Za-z0-9_-]{1,64}$/.test(c.function.name)) fail(`bad tool name ${JSON.stringify(c.function.name)}`);
      const args: unknown = JSON.parse(c.function.arguments);
      if (typeof args !== 'object' || args === null || Array.isArray(args)) fail(`arguments are not an object: ${c.function.arguments}`);
      if (!c.function.arguments.isWellFormed()) fail('arguments are not well-formed text');
    }
    owed = calls.map((c) => c.id);
  }
  if (owed.length > 0) fail('the last calls were not all answered');
  // The whole request is JSON text a strict parser on the other side reads back unchanged.
  if (JSON.stringify(JSON.parse(JSON.stringify(messages))) !== JSON.stringify(messages)) fail('the request does not survive JSON');
  // A lone surrogate hidden as an escape inside the arguments' JSON is still one for whoever parses them.
  if (/\\u[dD][89a-fA-F]/.test(JSON.stringify(messages))) fail('a surrogate escape is left in the request');
  const size = messages.reduce((sum, m) => sum + (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
  // When nothing fits, one short note is sent anyway; otherwise the budget holds.
  const note = messages.length === 2 && messages[1]!.content!.startsWith('[context] ');
  if (budget !== undefined && !note && size > budget) fail(`${size} characters for a budget of ${budget}`);
}

/**
 * Trimming only ever removes from the front: what is sent is the end of what would be sent with no
 * limit, message for message, except that the newest user message may have lost its middle.
 */
function checkIsTail(trimmed: ReturnType<typeof buildMessages>, whole: ReturnType<typeof buildMessages>): void {
  const kept = trimmed.slice(1);
  if (kept.length === 1 && kept[0]!.content!.startsWith('[context] The last exchange was too large')) return;
  const tail = whole.slice(whole.length - kept.length);
  const newest = kept.findLastIndex((m) => m.role === 'user');
  kept.forEach((m, i) => {
    const same = JSON.stringify(m) === JSON.stringify(tail[i]);
    const clipped = i === newest && m.role === tail[i]?.role && m.content!.includes('characters dropped here');
    if (!same && !clipped) throw new Error(`message ${i + 1} of the trimmed request is not the one the whole request has there`);
  });
}

/** How much more than it had to the trimming took away. A step is a fifth of the room, so never the better part of it. */
function checkNotWasteful(trimmed: ReturnType<typeof buildMessages>, whole: ReturnType<typeof buildMessages>, budget: number): void {
  const sizeOf = (list: ReturnType<typeof buildMessages>) => list.reduce((sum, m) => sum + (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
  if (sizeOf(whole) <= budget && trimmed.length !== whole.length) throw new Error('a request that fitted whole was trimmed');
}

/**
 * The same request on the Responses wire: throws with the reason when it is not input the Responses API takes.
 * Every call has exactly one result, after it; no result is without its call; nothing has an `id` or the system role.
 */
function checkResponses(messages: ReturnType<typeof buildMessages>): void {
  const fail = (why: string) => { throw new Error(`as Responses input: ${why}`); };
  for (const namespace of [undefined, 'teneral']) {
    const { instructions, input } = toResponsesInput(messages, namespace);
    if (instructions !== SYSTEM) fail('the instructions are not the system prompt');
    const calls = new Map<unknown, number>();
    for (const [i, item] of input.entries()) {
      if ('id' in item) fail(`item ${i} has an id`);
      if (item.type === 'function_call') {
        if (calls.has(item.call_id)) fail(`call id ${String(item.call_id)} is used twice`);
        if (typeof item.call_id !== 'string' || item.call_id === '') fail(`item ${i} has no call_id`);
        if (typeof item.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.name)) fail(`item ${i} has a bad name`);
        if (typeof item.arguments !== 'string') fail(`item ${i} has no arguments`);
        if (item.namespace !== namespace) fail(`item ${i} is in the wrong namespace`);
        calls.set(item.call_id, 0);
      } else if (item.type === 'function_call_output') {
        if (!calls.has(item.call_id)) fail(`item ${i} answers a call that was not made before it`);
        calls.set(item.call_id, calls.get(item.call_id)! + 1);
        if (typeof item.output !== 'string') fail(`item ${i} has no output`);
      } else {
        if (item.type !== undefined) fail(`item ${i} is of an unexpected type`);
        if (item.role !== 'user' && item.role !== 'assistant') fail(`item ${i} has role ${String(item.role)}`);
        if (typeof item.content !== 'string' || item.content === '') fail(`item ${i} is a message without text`);
      }
    }
    for (const [id, results] of calls) if (results !== 1) fail(`call ${String(id)} has ${results} results`);
    if (input.length === 0) fail('there is no input');
    const sentCalls = messages.reduce((sum, m) => sum + (m.tool_calls?.length ?? 0), 0);
    if (calls.size !== sentCalls) fail('a call was lost or made up');
    const text = JSON.stringify(input);
    if (!text.isWellFormed() || /\\u[dD][89a-fA-F]/.test(text)) fail('a lone surrogate is left in the input');
  }
}

test('any journal at any budget gives a request a provider accepts', () => {
  const runs = 4000;
  for (let seed = 1; seed <= runs; seed++) {
    const events = randomJournal(seed);
    for (const budget of BUDGETS) {
      try {
        const trimmed = buildMessages(events, SYSTEM, budget);
        check(trimmed, budget);
        checkResponses(trimmed);
        const whole = buildMessages(events, SYSTEM, Infinity);
        checkIsTail(trimmed, whole);
        if (budget !== undefined) checkNotWasteful(trimmed, whole, budget);
        needsTurn(events);
      } catch (err) {
        throw new Error(`seed ${seed}, budget ${budget}: ${err instanceof Error ? err.message : String(err)}\n${JSON.stringify(events)}`);
      }
    }
  }
});

test('the generator covers what it is meant to: calls, results, old shapes', () => {
  const all = Array.from({ length: 300 }, (_, i) => randomJournal(i + 1)).flat() as unknown as Record<string, unknown>[];
  const count = (pred: (e: Record<string, unknown>) => boolean) => all.filter(pred).length;
  expect(count((e) => e.type === 'assistant' && Array.isArray(e.toolCalls) && e.toolCalls.length > 1)).toBeGreaterThan(50);
  expect(count((e) => e.type === 'tool.result')).toBeGreaterThan(100);
  expect(count((e) => e.type === 'assistant' && !('text' in e))).toBeGreaterThan(0);
  expect(count((e) => e.type === 'molt.rejected')).toBeGreaterThan(10);
});
