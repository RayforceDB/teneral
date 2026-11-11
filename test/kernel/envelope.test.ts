import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ENVELOPE_VERSION, MAX_TEXT, archive, collect, deliver, findSeen, identity, parseEnvelope, type Envelope,
} from '../../kernel/envelope';

const tmp = () => mkdtempSync(join(tmpdir(), 'teneral-mail-'));

function envelope(over: Partial<Envelope> = {}): Envelope {
  return { v: ENVELOPE_VERSION, id: 'm1', from: 'alice', to: 'bob', replyTo: null, ts: '2026-11-11T00:00:00.000Z', hops: 0, text: 'hi', ...over };
}

test('a delivered envelope is collected intact and leaves no temp file', () => {
  const inbox = join(tmp(), 'inbox');
  deliver(inbox, envelope());
  const arrivals = collect(inbox);
  expect(arrivals).toHaveLength(1);
  expect(arrivals[0]!.envelope).toEqual(envelope());
  expect(arrivals[0]!.reason).toBeNull();
  expect(readdirSync(inbox).filter((n) => n.startsWith('.'))).toEqual([]);
});

test('a missing inbox is empty, and half-written files are not collected', () => {
  const inbox = join(tmp(), 'inbox');
  expect(collect(inbox)).toEqual([]);
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, '.tmp-m9'), '{"v":1');
  expect(collect(inbox)).toEqual([]);
});

test('a file that is not a valid envelope is reported with the reason', () => {
  const inbox = join(tmp(), 'inbox');
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, '1-bad.json'), '{"v":1,"id":"bad"}');
  const [arrival] = collect(inbox);
  expect(arrival!.envelope).toBeNull();
  expect(arrival!.reason).toContain('from');
});

test('archive moves a file out of the inbox, and findSeen finds it by id', () => {
  const inbox = join(tmp(), 'inbox');
  const file = deliver(inbox, envelope({ id: 'm7', hops: 2 }));
  expect(findSeen(inbox, 'm7')).toBeNull();
  archive(inbox, file, 'seen');
  expect(collect(inbox)).toEqual([]);
  expect(existsSync(join(inbox, 'seen', file))).toBe(true);
  expect(findSeen(inbox, 'm7')!.hops).toBe(2);
  expect(findSeen(inbox, 'other')).toBeNull();
});

test('parseEnvelope refuses what a receiver must not trust', () => {
  const bad = (over: Record<string, unknown>) => () => parseEnvelope(JSON.stringify({ ...envelope(), ...over }));
  expect(() => parseEnvelope('{oops')).toThrow(/not JSON/);
  expect(bad({ v: 2 })).toThrow(/version/);
  expect(bad({ id: '../../etc/passwd' })).toThrow(/id/);
  expect(bad({ from: '' })).toThrow(/from/);
  // `from` is shown to the model inside an [agent:<from>] label, so it may not carry anything that could end or imitate one.
  for (const key of ['from', 'to']) {
    const refused = new RegExp(key);
    expect(bad({ [key]: 'ali\nce' })).toThrow(refused);
    expect(bad({ [key]: 'alice]' })).toThrow(refused);
    expect(bad({ [key]: '[alice' })).toThrow(refused);
    expect(bad({ [key]: 'ali ce' })).toThrow(refused);
    expect(bad({ [key]: 'a'.repeat(65) })).toThrow(refused);
    expect(bad({ [key]: 7 })).toThrow(refused);
  }
  expect(bad({ hops: -1 })).toThrow(/hops/);
  expect(bad({ hops: 1.5 })).toThrow(/hops/);
  expect(bad({ replyTo: 5 })).toThrow(/replyTo/);
  expect(bad({ text: 'x'.repeat(MAX_TEXT + 1) })).toThrow(/longer/);
});

test('parseEnvelope accepts the names agents really use', () => {
  const ok = (over: Partial<Envelope>) => parseEnvelope(JSON.stringify(envelope(over)));
  for (const name of ['alice', 'me', 'a', 'drill.v2', 'host:agent_1', '3f0c7a52-9d1e-4c57-8a43-0b6f5d2e9c11', 'a'.repeat(64)]) {
    expect(ok({ from: name }).from).toBe(name);
    expect(ok({ to: name }).to).toBe(name);
  }
});

test('an id file that does not hold an id is replaced by a new id that then stays', () => {
  for (const damaged of ['', '\n', 'garbage', '3f0c7a52-9d1e-4c57-8a43']) {
    const data = join(tmp(), 'data');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'id'), damaged);
    const id = identity(data);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(identity(data)).toBe(id);
    expect(readdirSync(data)).toEqual(['id']);
  }
});

test('identity is created once and then stays the same', () => {
  const data = join(tmp(), 'data');
  const first = identity(data);
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  expect(identity(data)).toBe(first);
});

test('findSeen matches the id inside the file, not the tail of a longer id or the file name', () => {
  const inbox = join(tmp(), 'inbox');
  archive(inbox, deliver(inbox, envelope({ id: 'a-b', hops: 3 })), 'seen');
  expect(findSeen(inbox, 'b')).toBeNull();
  // Another program may name its file anything; the id is what a reply names.
  writeFileSync(join(inbox, 'note.json'), JSON.stringify(envelope({ id: 'x9', hops: 1 })));
  archive(inbox, 'note.json', 'seen');
  expect(findSeen(inbox, 'x9')!.hops).toBe(1);
  expect(findSeen(inbox, 'a-b')!.hops).toBe(3);
});
