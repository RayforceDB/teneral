import { afterEach, expect, test } from 'bun:test';
import { appendEvent, readEvents, type EventBody, type JournalEvent } from '../../brain/journal';
import { episodes } from '../../brain/episodes';
import { buildMessages } from '../../brain/memory';
import { lessons, lessonText, LESSON_KIND, LESSON_ACCEPT_KIND } from '../../brain/lessons';
import { TOOLS, type ToolContext } from '../../body/tools';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let serial = 0;
function ev(body: EventBody, at: string, gen = 'g1'): JournalEvent {
  return { ...body, id: `event-${++serial}`, v: 1, ts: at, gen } as JournalEvent;
}
const start = Date.parse('2026-11-16T00:00:00Z');
const at = (minutes = 0) => new Date(start + minutes * 60_000).toISOString();
function proposal(events: JournalEvent[], patch: Record<string, unknown> = {}): JournalEvent[] {
  const source = events.find(e => e.type === 'stimulus')!;
  return [...events, ev({ type: 'note', kind: LESSON_KIND, data: {
    text: 'Abort a running foreground turn before handing off.', topic: 'foreground mutation',
    conversation: source.id, evidence: [source.id], expected: 'The next late terminal line receives an answer.', version: 1, ...patch,
  } }, at(1), source.gen)];
}

afterEach(() => { delete process.env.TENERAL_LESSONS; });

test('a proposal is local and provenance-linked, never automatically permanent', () => {
  const source = ev({ type: 'stimulus', source: 'terminal', text: 'fix foreground mutation' }, at());
  const reply = ev({ type: 'assistant', text: 'done', toolCalls: [] }, at(1));
  const events = proposal([source, reply]);
  expect(lessons(events)).toHaveLength(1);
  expect(lessonText(events)).toContain('local to');
  expect(lessonText(events)).toContain(source.id);
  // A later conversation in the same generation cannot accept it, and is not shown it.
  const same = [...events, ev({ type: 'stimulus', source: 'terminal', text: 'something else entirely' }, at(600))];
  expect(lessonText(same)).toBeNull();
  // A later conversation in another generation is the one that can: it is shown the proposal, with how to keep it, until it runs out.
  const later = [...events, ev({ type: 'generation.promoted', commit: 'b', previous: 'a' }, at(600), 'g2'), ev({ type: 'stimulus', source: 'terminal', text: 'something else entirely' }, at(601), 'g2')];
  const shown = lessonText(later)!;
  expect(shown).toContain('Abort a running foreground turn');
  expect(shown).toContain('waits until 2026-11-23');
  expect(shown).toMatch(/action accept and lesson L\w+/);
  expect(shown).not.toContain('local to');
  const late = [...later, ev({ type: 'stimulus', source: 'terminal', text: 'a week on' }, at(8 * 24 * 60), 'g2')];
  expect(lessonText(late)).toBeNull();
});

test('only a later conversation in another generation can accept; optimistic versions are enforced', () => {
  const source = ev({ type: 'stimulus', source: 'terminal', text: 'fix foreground mutation' }, at());
  const reply = ev({ type: 'assistant', text: 'done', toolCalls: [] }, at(1));
  const proposed = proposal([source, reply]);
  const note = proposed.at(-1)!;
  const same = [...proposed, ev({ type: 'note', kind: LESSON_ACCEPT_KIND, data: { lesson: note.id, basedOn: 1, evidence: [source.id] } }, at(2))];
  expect(lessons(same)[0]!.accepted).toBeUndefined();
  const accepted = [...same, ev({ type: 'generation.promoted', commit: 'b', previous: 'a' }, at(3), 'g2'), ev({ type: 'stimulus', source: 'terminal', text: 'review the foreground lesson' }, at(4), 'g2'), ev({ type: 'note', kind: LESSON_ACCEPT_KIND, data: { lesson: note.id, basedOn: 1, evidence: [source.id] } }, at(5), 'g2')];
  expect(lessons(accepted)[0]!.accepted?.gen).toBe('g2');
  expect(lessons(accepted)[0]!.version).toBe(1);
  expect(lessonText(accepted)).toContain('accepted; v1');
});

test('expiry and malformed provenance remove notes without rewriting the journal', () => {
  const source = ev({ type: 'stimulus', source: 'terminal', text: 'a tool failed' }, at());
  const proposed = proposal([source]);
  expect(lessons(proposed, Date.parse(at(8 * 24 * 60)))).toHaveLength(0);
  expect(proposal([source], { evidence: ['not-in-journal'] }).filter(e => e.type === 'note')).toHaveLength(1);
  expect(lessons(proposal([source], { evidence: ['not-in-journal'] }))).toHaveLength(0);
  expect(lessons(proposal([source], { conversation: 'not-an-episode-start' }))).toHaveLength(0);
});

test('one switch disables both loading and writing', () => {
  const source = ev({ type: 'stimulus', source: 'terminal', text: 'fix foreground mutation' }, at());
  const events = proposal([source]);
  process.env.TENERAL_LESSONS = '0';
  expect(lessonText(events)).toBeNull();
  expect(buildMessages(events, 'S').map(m => m.content).join('\n')).not.toContain('Abort a running');
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-tool-'));
  const journal = join(dir, 'journal');
  const ctx: ToolContext = { workspace: dir, soul: dir, journal, gen: 'g1', mutationCommit: null, id: 'test', inbox: dir, peers: join(dir, 'peers') };
  const tool = TOOLS.find(t => t.spec.name === 'lesson')!;
  const add = (body: EventBody, gen = 'g1') => appendEvent(journal, gen, body);
  return { dir, ctx, tool, add };
}

test('lesson tool validates evidence, separate acceptance, stale writes and effect checks', async () => {
  const f = await fixture();
  try {
    const source = f.add({ type: 'stimulus', source: 'terminal', text: 'repair foreground mutation' });
    f.add({ type: 'assistant', text: '', toolCalls: [{ id: 'bad', name: 'edit', args: {} }] });    f.add({ type: 'tool.result', callId: 'bad', ok: false, output: 'failed' });
    f.add({ type: 'assistant', text: '', toolCalls: [{ id: 'good', name: 'edit', args: {} }] });
    f.add({ type: 'tool.result', callId: 'good', ok: true, output: 'passed' });
    await expect(f.tool.run({ action: 'propose', basedOn: 0, topic: 'foreground mutation', text: 'Abort before generation hand-off.', conversation: source.id, evidence: ['missing'] }, f.ctx)).rejects.toThrow('must exist');
    const proposed = await f.tool.run({ action: 'propose', basedOn: 0, topic: 'foreground mutation', text: 'Abort before generation hand-off.', conversation: source.id, evidence: [source.id], expected: 'A late terminal line is answered.' }, f.ctx);
    const mark = proposed.match(/L\w+/)![0];
    await expect(f.tool.run({ action: 'accept', lesson: mark, basedOn: 1, evidence: [source.id] }, f.ctx)).rejects.toThrow(); // same generation/conversation
    const proposedNote = readEvents(f.ctx.journal).at(-1)!;
    f.add({ type: 'assistant', text: '', toolCalls: [{ id: 'propose', name: 'lesson', args: {} }] });
    f.add({ type: 'tool.result', callId: 'propose', ok: true, output: proposed });
    f.add({ type: 'assistant', text: 'Proposal recorded.', toolCalls: [] });
    expect(proposedNote.type).toBe('note');
    expect(episodes(readEvents(f.ctx.journal)).at(-1)?.closed).toBe(false);
    f.add({ type: 'generation.promoted', commit: 'b', previous: 'a' }, 'g2');
    f.add({ type: 'stimulus', source: 'terminal', text: 'review foreground mutation lesson' }, 'g2');
    f.ctx.gen = 'g2';
    expect(await f.tool.run({ action: 'accept', lesson: mark, basedOn: 1, evidence: [source.id] }, f.ctx)).toContain('Accepted');
    const observed = f.add({ type: 'stimulus', source: 'terminal', text: 'late terminal line answered' }, 'g2');
    expect(await f.tool.run({ action: 'check', lesson: mark, basedOn: 1, evidence: [observed.id], outcome: 'observed' }, f.ctx)).toContain('version is now 2');
    await expect(f.tool.run({ action: 'check', lesson: mark, basedOn: 1, evidence: [observed.id], outcome: 'observed' }, f.ctx)).rejects.toThrow('stale lesson version');
    expect(lessonText(readEvents(f.ctx.journal))).toContain('checked');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('the same switch refuses new lesson tool writes', async () => {
  const f = await fixture();
  try {
    const source = f.add({ type: 'stimulus', source: 'terminal', text: 'repair foreground mutation' });
    process.env.TENERAL_LESSONS = '0';
    await expect(f.tool.run({ action: 'propose', basedOn: 0, topic: 'foreground', text: 'A lesson.', conversation: source.id, evidence: [source.id] }, f.ctx)).rejects.toThrow('disabled');
    expect(readEvents(f.ctx.journal)).toHaveLength(1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});


test('a lesson is proposed with a topic and its text alone, and kept by its mark alone: the body knows the conversation and the version', async () => {
  const f = await fixture();
  try {
    const source = f.add({ type: 'stimulus', source: 'terminal', text: 'you sent the report before checking the figures' });
    const proposed = await f.tool.run({ action: 'propose', topic: 'reports', text: 'Check every figure against its source before sending a report.' }, f.ctx);
    const mark = proposed.match(/L\w+/)![0];
    const note = readEvents(f.ctx.journal).at(-1)!;
    expect(note).toMatchObject({ type: 'note', kind: LESSON_KIND, data: { conversation: source.id, evidence: [source.id], version: 1 } });
    await expect(f.tool.run({ action: 'accept', lesson: mark }, f.ctx)).rejects.toThrow('generation');
    f.add({ type: 'assistant', text: 'Noted.', toolCalls: [] });
    f.add({ type: 'generation.promoted', commit: 'b', previous: 'a' }, 'g2');
    f.add({ type: 'stimulus', source: 'terminal', text: 'another day, another report' }, 'g2');
    f.ctx.gen = 'g2';
    expect(lessonText(readEvents(f.ctx.journal))).toContain(mark);
    expect(await f.tool.run({ action: 'accept', lesson: mark }, f.ctx)).toContain('Accepted');
    expect(lessons(readEvents(f.ctx.journal))[0]!.accepted?.gen).toBe('g2');
    // A check still says which version it read, and names what it saw.
    await expect(f.tool.run({ action: 'check', lesson: mark, outcome: 'observed' }, f.ctx)).rejects.toThrow();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
