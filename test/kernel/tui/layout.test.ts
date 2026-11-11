import { expect, test } from 'bun:test';
import { EMPTY } from '../../../kernel/tui/editor';
import type { Frame } from '../../../kernel/tui/screen';
import { lineWidth, type Line } from '../../../kernel/tui/text';
import { glyphs } from '../../../kernel/tui/theme';
import { duration, elapsed, entryRows, regions, talkFrame, type TalkView } from '../../../kernel/tui/view';

// --- the layout of the talk screen ---

const G = glyphs(true);
function view(cols: number, rows: number, more: Partial<TalkView> = {}): TalkView {
  const r = regions(cols, rows, more.edit?.text ?? '', more.edit?.cursor ?? 0);
  return {
    cols, rows, g: G, name: null, generation: 'generation 3', commit: 'a1b2c3d', model: 'gpt-6.1-sol', state: 'resting',
    transcript: Array.from({ length: r.height }, (_, i): Line => [{ text: `row ${i}` }]), more: false, overlay: null, edit: EMPTY, ...more,
  };
}
const text = (f: Frame): string[] => f.rows.map((row) => (Array.isArray(row) ? row.map((span) => span.text).join('').trimEnd() : row.flow));

test('the screen is shared out by size: spacing goes first on a small one, and every size has a header, a transcript, an input row and a hint', () => {
  expect(regions(100, 30, '', 0)).toMatchObject({ top: 2, height: 25, rule: true });
  expect(regions(80, 14, '', 0)).toMatchObject({ top: 2, height: 9, rule: true });
  expect(regions(60, 13, '', 0)).toMatchObject({ top: 1, height: 9, rule: true });
  expect(regions(40, 11, '', 0)).toMatchObject({ top: 1, height: 8, rule: false });
  expect(regions(40, 10, '', 0)).toMatchObject({ top: 1, height: 7, rule: false });
  // The input grows to five rows on a screen with room, and to fewer on a small one; the transcript keeps at least a row.
  const six = 'a\nb\nc\nd\ne\nf';
  expect(regions(100, 30, six, six.length)).toMatchObject({ height: 21 });
  expect(regions(100, 30, six, six.length).input.rows).toHaveLength(5);
  expect(regions(40, 10, six, six.length).input.rows).toHaveLength(5);
  expect(regions(40, 10, six, six.length).height).toBe(3);
  expect(regions(40, 6, six, six.length).input.rows).toHaveLength(1);
  expect(regions(40, 6, six, six.length).height).toBeGreaterThanOrEqual(1);
  for (const [cols, rows] of [[40, 10], [41, 11], [60, 12], [60, 16], [80, 24], [100, 30], [200, 60], [40, 4], [20, 3]] as const) {
    const f = talkFrame(view(cols, rows));
    // Below four rows there is no room for all four parts; the screen then drops what is past its last row.
    expect(f.rows).toHaveLength(Math.max(rows, 4));
    expect(f.cursor).not.toBeNull();
    expect(f.cursor!.row).toBeLessThan(f.rows.length);
    for (const row of text(f)) expect(row.length).toBeLessThanOrEqual(cols);
  }
});

test('the header gives up what does not fit, the least needed first, and the state is always there', () => {
  const head = (cols: number, more: Partial<TalkView> = {}): string => text(talkFrame(view(cols, 20, more)))[0]!;
  expect(head(80)).toBe(' teneral   generation 3 · a1b2c3d · gpt-6.1-sol                         resting');
  expect(head(80, { name: 'Мира' })).toBe(' teneral · Мира   generation 3 · a1b2c3d · gpt-6.1-sol                  resting');
  expect(head(50, { name: 'Мира', state: 'running bash' })).toBe(' teneral · Мира   generation 3       running bash');
  expect(head(40, { name: 'Мира', state: 'waiting for you' })).toBe(' teneral · Мира         waiting for you');
  expect(head(30, { name: 'A long name of sorts', state: 'waiting for you' })).toBe(' teneral      waiting for you');
  expect(head(60, { generation: '', commit: '', model: '' })).toBe(' teneral                                            resting');
  for (let cols = 20; cols <= 120; cols++) {
    const row = head(cols, { name: 'Мира', state: 'running a_tool_with_a_long_name' });
    expect(row.length).toBeLessThanOrEqual(Math.max(cols, 41));
    expect(row.endsWith('running a_tool_with_a_long_name')).toBe(true);
  }
});

test('the hint always says how to leave and that the agent goes on, and names the rest as the width allows', () => {
  const hint = (cols: number, more: Partial<TalkView> = {}): string => text(talkFrame(view(cols, 20, more))).at(-1)!;
  expect(hint(120)).toBe(' Enter sends · Alt+Enter new line · PgUp/PgDn scroll · Tab tool output · /help · Ctrl-C leaves; the agent goes on');
  expect(hint(80)).toBe(' Enter sends · PgUp/PgDn scroll · /help · Ctrl-C leaves; the agent goes on');
  expect(hint(40)).toBe(' Ctrl-C leaves; the agent goes on');
  expect(hint(60, { name: 'Мира' })).toBe(' Enter sends · /help · Ctrl-C leaves; Мира goes on');
  expect(hint(80, { overlay: { title: 't', rows: [], top: 0 } })).toBe(' Esc closes · Up/Down scroll');
});

test('scrolled up, the last transcript row says there is more below; an overlay takes the transcript\'s place and hides the cursor', () => {
  const up = text(talkFrame(view(60, 16, { more: true })));
  expect(up[12]).toBe('                                         ↓ more below · End');
  expect(up[11]).toBe('row 9');
  const over = talkFrame(view(60, 16, { overlay: { title: 'a title', rows: [[{ text: '  one' }], [{ text: '  two' }], [{ text: '  three' }]], top: 1 } }));
  expect(text(over).slice(2, 6)).toEqual(['  a title', '', '  two', '  three']);
  expect(over.cursor).toBeNull();
});

test('every kind of entry fits the width it is given, and none throws at a width of a few columns', () => {
  const entries = [
    { kind: 'owner', text: 'привет, как дела\nвторая строка 日本語', pending: true },
    { kind: 'reply', text: '# H\n\n- список **жирный** `code`\n\n```\nlong code line here\n```\n> q', first: true, early: true },
    { kind: 'tool', callId: 'c', name: 'bash', args: 'command: ls -la /a/long/path', status: 'failed', ms: 1234, output: 'line one\nline two 日本語\n\tindented' },
    { kind: 'notice', tone: 'warn', title: 'rolled back', move: ['aaaaaaa', 'bbbbbbb'], lead: 'crashed 3 times without a reply.', body: 'TypeError: x\n    at y' },
    { kind: 'quiet', label: 'from alice', text: 'a message that is long enough to be cut' },
    { kind: 'warning', text: 'The provider refused the request.' },
    { kind: 'note', text: 'Older history is in the journal.' },
  ] as const;
  for (const max of [200, 80, 40, 24, 12, 6, 3]) {
    for (const e of entries) {
      const rows = entryRows({ ...e, id: 1, rev: 0 } as never, max, { g: G, tools: true });
      expect(rows.length).toBeGreaterThan(0);
      // From 40 columns up, which is the smallest screen meant to work, nothing is wider than asked. Narrower, the screen cuts what is left over.
      if (max >= 40) for (const row of rows) expect(lineWidth(row)).toBeLessThanOrEqual(max);
    }
  }
});

test('how long something took, and how long something has been going on, are said at the precision that matters', () => {
  expect([0, 40, 999, 1000, 2540, 9999, 12_400, 59_400, 61_000, 187_000].map(duration)).toEqual(['0ms', '40ms', '999ms', '1.0s', '2.5s', '10.0s', '12s', '59s', '1m01s', '3m07s']);
  expect([0, 7900, 60_000, 760_000, 3_723_000, -5].map(elapsed)).toEqual(['0:00', '0:07', '1:00', '12:40', '1:02:03', '0:00']);
});
