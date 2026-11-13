import { expect, test } from 'bun:test';
import { buildMessages, needsTurn, type Sight } from '../../brain/memory';
import { IMAGE_CHARS } from '../../body/images';
import { toChatMessages, toResponsesInput } from '../../brain/provider';
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

/** Image markers: well-formed ones, one whose file is missing (the loader below says so), and some that only look like one. */
const hex = (n: number) => n.toString(16).padStart(64, '0');
const MARKERS = [
  ...Array.from({ length: 9 }, (_, n) => `[image: memory/images/${hex(n + 1)}.png]`),
  `[image: memory/images/${hex(0)}.gif]`, '[image: memory/images/short.png]', '[image: /etc/passwd]', `[image: memory/images/${hex(1)}.png] `,
] as const;
/** What only the owner's words carry: no other text in a random journal holds it, so it shows where a message came from. */
const OWNER_WORDS = 'the owner says';

/** Reads no disk. Every path it is asked for is recorded: none may be asked for that the owner's own messages, or look, did not name. */
function fuzzSight(max: number | undefined, refused: boolean): Sight & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked, max, refused,
    load: (path) => {
      asked.push(path);
      return path.endsWith('.gif') ? 'the file is missing' : { name: path.split('/').at(-1)!, mime: 'image/png', data: 'QUJD' };
    },
  };
}

function randomJournal(seed: number): JournalEvent[] {
  const { next, pick } = generator(seed);
  /** Text that, more often than not when asked, ends with marker lines, or has one in its middle. */
  const withMarkers = (text: string, chance: number): string => {
    if (next() >= chance) return text;
    const lines = Array.from({ length: 1 + Math.floor(next() * 6) }, () => pick(MARKERS));
    return next() < 0.15 ? `${lines.join('\n')}\n${text}` : `${text}\n${lines.join('\n')}`;
  };
  const events: unknown[] = [];
  const length = Math.floor(next() * 14);
  for (let i = 0; i < length; i++) {
    const roll = next();
    const envelope = { v: 1, id: `e${seed}-${i}`, ts: 't', gen: 'g' };
    if (next() < 0.06) {
      // A look that ran: the call, and its result ending with the line the tool writes (and sometimes more of them, or none).
      events.push({ ...envelope, type: 'assistant', text: pick(TEXTS), toolCalls: [{ id: `look${i}`, name: 'look', args: { path: 'a.png' } }] });
      events.push({ ...envelope, id: `e${seed}-${i}r`, type: 'tool.result', callId: `look${i}`, ok: next() < 0.9, output: withMarkers(pick(TEXTS), 0.9) });
      continue;
    }
    if (roll < 0.22) {
      const source = pick(['terminal', 'clock', 'kernel', 'agent:bob']);
      // The owner's messages with markers all start with the owner's words; see checkImages.
      const text = source !== 'terminal' ? withMarkers(pick(TEXTS), 0.5) : next() < 0.6 ? withMarkers(`${OWNER_WORDS} ${pick(TEXTS)}`, 1) : pick(TEXTS);
      events.push({ ...envelope, type: 'stimulus', source, text });
    } else if (roll < 0.5) {
      const toolCalls = Array.from({ length: Math.floor(next() * 4) }, () =>
        (next() < 0.05 ? null : { id: pick(IDS), name: next() < 0.25 ? 'look' : pick(NAMES), args: pick(ARGS) }));
      const event: Record<string, unknown> = { ...envelope, type: 'assistant', text: withMarkers(pick(TEXTS), 0.2), toolCalls };
      // A reply as it is journaled now, with what the provider said it cost and a summary of the reasoning.
      if (next() < 0.3) Object.assign(event, { usage: { input: 10, output: 2, cached: 1 }, reasoning: `REASONING ${pick(TEXTS)}` });
      // Shapes an older generation might have written.
      if (next() < 0.05) delete event.text;
      if (next() < 0.05) delete event.toolCalls;
      if (next() < 0.03) event.toolCalls = 'not a list';
      events.push(event);
    } else if (roll < 0.65) {
      events.push({ ...envelope, type: 'tool.intent', callId: pick(IDS), name: pick(NAMES), args: pick(ARGS) });
    } else if (roll < 0.85) {
      events.push({ ...envelope, type: 'tool.result', callId: pick(IDS), ok: next() < 0.8, output: next() < 0.05 ? undefined : withMarkers(pick(TEXTS), 0.4) });
    } else if (roll < 0.9) {
      events.push({ ...envelope, type: 'mutation.rejected', commit: 'c', gate: 'tests', output: withMarkers(pick(TEXTS).repeat(Math.floor(next() * 60)), 0.3) });
    } else if (roll < 0.94) {
      events.push({ ...envelope, type: 'generation.promoted', commit: 'c', previous: 'p' });
    } else if (roll < 0.97) {
      events.push({ ...envelope, type: 'generation.rolledback', commit: 'c', to: 'p', reason: pick(TEXTS) });
    } else {
      events.push({ ...envelope, type: pick(['generation.started', 'generation.ready', 'mutation.requested', 'from.the.future']), commit: 'c' });
    }
  }
  return events as JournalEvent[];
}

const SYSTEM = 'SYSTEM PROMPT';
const BUDGETS = [0, 60, 400, 3000, 30_000, undefined];
/** Images per request: the default, none, one, an odd number, more than a journal here holds. */
const LIMITS = [undefined, 0, 1, 3, 100];
const sizeOf = (list: ReturnType<typeof buildMessages>) => list.reduce(
  (sum, m) => sum + (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0) + (m.images?.length ?? 0) * IMAGE_CHARS, 0);

/** Throws with the reason when `messages` is not a request a strict provider would take. */
function check(messages: ReturnType<typeof buildMessages>, budget: number | undefined): void {
  const fail = (why: string) => { throw new Error(why); };
  if (messages[0]?.role !== 'system' || messages[0].content !== SYSTEM) fail('first message is not the system prompt');
  if (messages[1]?.role !== 'user') fail('second message is not a user message');
  const last = messages.at(-1)!;
  if (last.role !== 'user' && last.role !== 'tool') fail(`last message is ${last.role}`);
  const ids = new Set<string>();
  const named = new Map<string, string>();
  let owed: string[] = [];
  for (let i = 1; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.content !== null && (typeof m.content !== 'string' || !m.content.isWellFormed())) fail(`message ${i} is not well-formed text`);
    if (m.images !== undefined && (m.images.length === 0 || m.images.some((image) => !/^image\/(png|jpeg|gif|webp)$/.test(image.mime) || !/^[A-Za-z0-9+/]+=*$/.test(image.data)))) {
      fail(`message ${i} has an empty or malformed list of images`);
    }
    if (m.role === 'tool') {
      const id = owed.shift();
      if (id !== m.tool_call_id) fail(`tool message ${i} does not answer the next open call`);
      if (typeof m.content !== 'string') fail(`tool message ${i} has no content`);
      // An image on a result is what `look` returned, and nothing else's.
      if (m.images !== undefined && named.get(id!) !== 'look') fail(`tool message ${i} has an image but answers ${named.get(id!)}`);
      continue;
    }
    if (m.images !== undefined && m.role !== 'user') fail(`a ${m.role} message has images at ${i}`);
    if (owed.length > 0) fail(`message ${i} comes before every call was answered`);
    if (m.tool_call_id !== undefined) fail(`message ${i} has a tool_call_id but is not a tool message`);
    if (m.role === 'system') fail(`a second system message at ${i}`);
    if (m.role === 'user') {
      // Text, or images, or both; never neither.
      if (m.images === undefined && (typeof m.content !== 'string' || m.content.trim() === '')) fail(`user message ${i} is empty`);
      if (m.content !== null && m.content.trim() === '') fail(`user message ${i} has empty text instead of none`);
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
      named.set(c.id, c.function.name);
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
  const size = sizeOf(messages);
  // When nothing fits, one short note is sent anyway; otherwise the budget holds.
  const note = messages.length === 2 && (messages[1]!.content ?? '').startsWith('[context] ');
  if (budget !== undefined && !note && size > budget) fail(`${size} characters for a budget of ${budget}`);
}

/**
 * Images are where they may be and nowhere else: beside a user message that is the owner's own
 * (a `terminal` stimulus), or on the result of a `look` call (see `check`); never more than the
 * limit in one request; none once the provider refused them. And no file was asked for that such
 * a message did not name: not for a marker in an inbox message, a tick, a kernel note, another
 * tool's output or the agent's own text.
 */
function checkImages(messages: ReturnType<typeof buildMessages>, events: JournalEvent[], sight: Sight & { asked: string[] }, untrimmed: boolean): void {
  const fail = (why: string) => { throw new Error(`images: ${why}`); };
  const limit = sight.max ?? 4;
  const count = messages.reduce((sum, m) => sum + (m.images?.length ?? 0), 0);
  if (count > limit) fail(`${count} in a request with a limit of ${limit}`);
  if (sight.refused && (count > 0 || sight.asked.length > 0)) fail('one was loaded or sent after the provider refused them');
  if (sight.asked.length > limit) fail(`${sight.asked.length} files read for a limit of ${limit}`);
  for (const [i, m] of messages.entries()) {
    if (m.role !== 'user' || m.images === undefined) continue;
    if (m.images.length > 4) fail(`message ${i} has ${m.images.length} images`);
    if (!m.content?.startsWith(OWNER_WORDS)) fail(`message ${i} has an image and is not the owner's: ${JSON.stringify(m.content)}`);
  }
  // What was read is only what a marker of the owner's, or the result of a look, names in the exact form.
  const allowed = new Set<string>();
  for (const e of events as unknown as { type: string; source?: unknown; text?: unknown; output?: unknown }[]) {
    const text = e.type === 'stimulus' && e.source === 'terminal' ? e.text : e.type === 'tool.result' ? e.output : undefined;
    if (typeof text !== 'string') continue;
    for (const match of text.matchAll(/^\[image: (memory\/images\/[0-9a-f]{64}\.(?:png|gif))\]$/gm)) allowed.add(match[1]!);
  }
  for (const path of sight.asked) if (!allowed.has(path)) fail(`${path} was read, which no message that may show images names`);
  // Markers that are not the owner's stay in the text, as they were written.
  const foreign = (events as unknown as { type: string; source?: unknown; text?: unknown }[])
    .filter((e) => e.type === 'stimulus' && e.source !== 'terminal' && typeof e.text === 'string' && /\[image: /.test(e.text as string));
  if (untrimmed) {
    for (const e of foreign) if (!messages.some((m) => m.role === 'user' && m.content?.includes((e.text as string).toWellFormed().replaceAll('[kernel]', '[not kernel]')))) fail('a marker from someone else was taken out of their text');
  }
  if (JSON.stringify(messages).includes('REASONING')) fail('a summary of the reasoning was sent back to the model');
}

/**
 * The same request as chat-completions takes it: an image is a part of a user message and of no
 * other, results still follow their calls with nothing in between, and no field of this code's own is left.
 */
function checkChat(messages: ReturnType<typeof buildMessages>): void {
  const fail = (why: string) => { throw new Error(`as chat messages: ${why}`); };
  const wire = toChatMessages(messages) as { role: string; content: unknown; tool_calls?: { id: string }[]; tool_call_id?: string }[];
  let owed: string[] = [];
  let images = 0;
  for (const [i, m] of wire.entries()) {
    if ('images' in m) fail(`message ${i} still has the images field`);
    if (m.role === 'tool') {
      if (owed.shift() !== m.tool_call_id) fail(`tool message ${i} does not answer the next open call`);
      if (typeof m.content !== 'string') fail(`tool message ${i} is not text`);
      continue;
    }
    if (owed.length > 0) fail(`message ${i} comes before every call was answered`);
    owed = (m.tool_calls ?? []).map((c) => c.id);
    if (!Array.isArray(m.content)) {
      if (m.role === 'user' && (typeof m.content !== 'string' || m.content === '')) fail(`user message ${i} has no text`);
      continue;
    }
    if (m.role !== 'user') fail(`a ${m.role} message has parts at ${i}`);
    const parts = m.content as { type: string; text?: unknown; image_url?: { url?: unknown } }[];
    if (parts.length === 0) fail(`message ${i} has no parts`);
    for (const [n, part] of parts.entries()) {
      if (part.type === 'text') {
        if (n !== 0 || typeof part.text !== 'string' || part.text === '') fail(`message ${i} has a bad text part`);
      } else if (part.type === 'image_url') {
        if (typeof part.image_url?.url !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(part.image_url.url)) fail(`message ${i} has a bad image part`);
        images += 1;
      } else fail(`message ${i} has a part of type ${part.type}`);
    }
  }
  if (owed.length > 0) fail('the last calls were not all answered');
  if (images !== messages.reduce((sum, m) => sum + (m.images?.length ?? 0), 0)) fail('an image was lost or made up');
  if (wire.at(-1)!.role !== 'user' && wire.at(-1)!.role !== 'tool') fail(`the last message is ${wire.at(-1)!.role}`);
}

/**
 * Trimming only ever removes from the front: what is sent is the end of what would be sent with no
 * limit, message for message, except that the newest user message may have lost its middle.
 */
function checkIsTail(trimmed: ReturnType<typeof buildMessages>, whole: ReturnType<typeof buildMessages>): void {
  const kept = trimmed.slice(1);
  if (kept.length === 1 && (kept[0]!.content ?? '').startsWith('[context] The last exchange was too large')) return;
  const tail = whole.slice(whole.length - kept.length);
  const newest = kept.findLastIndex((m) => m.role === 'user');
  kept.forEach((m, i) => {
    const same = JSON.stringify(m) === JSON.stringify(tail[i]);
    // Cut in its text only: the images of a clipped message are the ones the whole request has there.
    const clipped = i === newest && m.role === tail[i]?.role && (m.content ?? '').includes('characters dropped here')
      && JSON.stringify(m.images) === JSON.stringify(tail[i]!.images);
    if (!same && !clipped) throw new Error(`message ${i + 1} of the trimmed request is not the one the whole request has there`);
  });
}

/** How much more than it had to the trimming took away. A step is a fifth of the room, so never the better part of it. */
function checkNotWasteful(trimmed: ReturnType<typeof buildMessages>, whole: ReturnType<typeof buildMessages>, budget: number): void {
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
    let images = 0;
    const checkPart = (part: { type?: unknown; image_url?: unknown }, i: number): void => {
      if (part.type !== 'input_image' || typeof part.image_url !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(part.image_url)) fail(`item ${i} has a bad image part`);
    };
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
        if (typeof item.output !== 'string') {
          // A list of parts, when `look` returned an image: the text first, then images.
          const parts = item.output as { type?: unknown; text?: unknown }[];
          if (!Array.isArray(parts) || parts.length === 0) fail(`item ${i} has no output`);
          for (const [n, part] of parts.entries()) {
            if (part.type === 'input_text') {
              if (n !== 0 || typeof part.text !== 'string' || part.text === '') fail(`item ${i} has a bad text part`);
            } else { checkPart(part, i); images += 1; }
          }
        }
      } else {
        if (item.type !== undefined) fail(`item ${i} is of an unexpected type`);
        if (item.role !== 'user' && item.role !== 'assistant') fail(`item ${i} has role ${String(item.role)}`);
        if (typeof item.content === 'string') {
          if (item.content === '') fail(`item ${i} is a message without text`);
          continue;
        }
        const parts = item.content as { type?: unknown; text?: unknown }[];
        if (item.role !== 'user' || !Array.isArray(parts) || parts.length === 0) fail(`item ${i} has parts but is not a user message with some`);
        for (const [n, part] of parts.entries()) {
          if (part.type === 'input_text') {
            if (n !== 0 || typeof part.text !== 'string' || part.text === '') fail(`item ${i} has a bad text part`);
          } else { checkPart(part, i); images += 1; }
        }
      }
    }
    if (images !== messages.reduce((sum, m) => sum + (m.images?.length ?? 0), 0)) fail('an image was lost or made up');
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
    // Each journal with one limit on images, and now and then as after a refusal, or with no way to load any.
    const max = LIMITS[seed % LIMITS.length];
    const refused = seed % 7 === 0;
    const blind = seed % 11 === 0;
    for (const budget of BUDGETS) {
      try {
        const sight = fuzzSight(max, refused);
        const trimmed = buildMessages(events, SYSTEM, budget, blind ? undefined : sight);
        check(trimmed, budget);
        checkImages(trimmed, events, sight, budget === undefined);
        if (blind && (sight.asked.length > 0 || trimmed.some((m) => m.images !== undefined))) throw new Error('an image without a way to load one');
        checkResponses(trimmed);
        checkChat(trimmed);
        const whole = buildMessages(events, SYSTEM, Infinity, blind ? undefined : fuzzSight(max, refused));
        checkIsTail(trimmed, whole);
        if (budget !== undefined) checkNotWasteful(trimmed, whole, budget);
        needsTurn(events);
      } catch (err) {
        throw new Error(`seed ${seed}, budget ${budget}, images ${max}: ${err instanceof Error ? err.message : String(err)}\n${JSON.stringify(events)}`);
      }
    }
  }
});

test('which images a request shows changes only when the journal gains an image, and then only at a step', () => {
  // A journal that grows event by event: between two requests, an image already sent is never taken
  // back unless a new image arrived, and what is taken back is a whole step's worth (half the limit).
  for (let seed = 1; seed <= 300; seed++) {
    const events = randomJournal(seed);
    let before: { shown: string[]; slots: number } | null = null;
    for (let length = 0; length <= events.length; length++) {
      const messages = buildMessages(events.slice(0, length), SYSTEM, Infinity, fuzzSight(4, false));
      const shown = messages.flatMap((m) => (m.images ?? []).map((image, n) => `${m.tool_call_id ?? m.content}#${n}:${image.name}`));
      const text = JSON.stringify(messages);
      const slots = shown.length + (text.match(/\[an image shown earlier: /g) ?? []).length + (text.match(/\[image not available: the file is missing\]/g) ?? []).length;
      if (before !== null && slots === before.slots && JSON.stringify(shown) !== JSON.stringify(before.shown)) {
        throw new Error(`seed ${seed}, ${length} events: the images shown changed though none arrived\n${JSON.stringify(events)}`);
      }
      before = { shown, slots };
    }
  }
});

test('the generator covers what it is meant to: calls, results, old shapes', () => {
  const all = Array.from({ length: 300 }, (_, i) => randomJournal(i + 1)).flat() as unknown as Record<string, unknown>[];
  const count = (pred: (e: Record<string, unknown>) => boolean) => all.filter(pred).length;
  expect(count((e) => e.type === 'assistant' && Array.isArray(e.toolCalls) && e.toolCalls.length > 1)).toBeGreaterThan(50);
  expect(count((e) => e.type === 'tool.result')).toBeGreaterThan(100);
  expect(count((e) => e.type === 'assistant' && !('text' in e))).toBeGreaterThan(0);
  expect(count((e) => e.type === 'mutation.rejected')).toBeGreaterThan(10);
  // Images: the owner's messages that end with markers, the same markers from others, look calls, and requests that carry images.
  const ends = (e: Record<string, unknown>) => typeof e.text === 'string' && /\[image: memory\/images\/[0-9a-f]{64}\.png\]$/.test(e.text);
  expect(count((e) => e.type === 'stimulus' && e.source === 'terminal' && ends(e))).toBeGreaterThan(15);
  expect(count((e) => e.type === 'stimulus' && e.source !== 'terminal' && ends(e))).toBeGreaterThan(60);
  expect(count((e) => e.type === 'assistant' && Array.isArray(e.toolCalls) && e.toolCalls.some((c) => (c as { name?: unknown } | null)?.name === 'look'))).toBeGreaterThan(50);
  let withImages = 0, onTools = 0, overLimit = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const messages = buildMessages(randomJournal(seed), SYSTEM, Infinity, fuzzSight(1, false));
    if (messages.some((m) => m.role === 'user' && m.images)) withImages += 1;
    if (messages.some((m) => m.role === 'tool' && m.images)) onTools += 1;
    if (JSON.stringify(messages).includes('[an image shown earlier: ')) overLimit += 1;
  }
  expect(withImages).toBeGreaterThan(15);
  expect(onTools).toBeGreaterThan(5);
  expect(overLimit).toBeGreaterThan(10);
});
