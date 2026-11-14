import { SILENT_MS, TAIL_SHOWN, beatOf, beatWords } from '../../../keeper/tui/view';
import { expect, test } from 'bun:test';
import { COMMANDS } from '../../../keeper/commands';
import { EMPTY, type Edit } from '../../../keeper/tui/editor';
import type { Attachment } from '../../../keeper/tui/images';
import { lineWidth, plain, type Line } from '../../../keeper/tui/text';
import { glyphs } from '../../../keeper/tui/theme';
import { chip, contextUse, duration, elapsed, entryRows, liveRows, panel, shortDir, status, tokens, welcome, type Live, type Look, type Offered } from '../../../keeper/tui/view';

// --- what the talk client shows, as rows ---

const G = glyphs(true);
const PNG: Attachment = { path: `memory/images/${'a'.repeat(64)}.png`, ext: 'png', width: 1280, height: 720, bytes: 245_760 };
const LOOK: Look = { g: G, tools: true, image: (path) => (path === PNG.path ? PNG : null) };
const text = (rows: Line[]): string[] => rows.map((row) => plain(row).trimEnd());

function live(cols: number, rows: number, more: Partial<Live> = {}): Live {
  return {
    cols, rows, g: G, pending: [], activity: null, edit: EMPTY,
    about: ['gpt-6.1-sol', 'resting', '…/data/work/teneral', 'generation 3 a1b2c3d'], tip: '/help lists the keys and commands', context: 'context 8% (71.9k/1.05M)', hint: '', ...more,
  };
}

test('the live region: a blank row, the input in its box across the width, and the footer with what is known on both sides', () => {
  expect(text(liveRows(live(80, 24)))).toEqual([
    '',
    '╭─────────────────────────────────────────────────────────────────────────────╮',
    '│ ›                                                                           │',
    '╰─────────────────────────────────────────────────────────────────────────────╯',
    ' gpt-6.1-sol  resting  …/data/work/teneral            context 8% (71.9k/1.05M)',
  ]);
  // With room, the generation is there too, and the tip stands before the context.
  expect(text(liveRows(live(140, 24))).at(-1)).toMatch(/^ gpt-6\.1-sol {2}resting {2}…\/data\/work\/teneral {2}generation 3 a1b2c3d {3,}\/help lists the keys and commands {2}context 8% \(71\.9k\/1\.05M\)$/);
  // Nothing known of the context, nothing attached: the footer is one row. Reasoning effort, when known, is beside the model.
  const bare = text(liveRows(live(100, 24, { context: '', about: ['gpt-6.1-sol', 'effort high', 'resting'] })));
  expect(bare).toHaveLength(5);
  expect(bare.at(-1)).toMatch(/^ gpt-6\.1-sol  effort high  resting {20,}\/help lists the keys and commands$/);
  expect(bare.at(-1)).toHaveLength(99);
});

test('while something is under way it stands over the box: what has not finished, then what the agent is doing', () => {
  const rows = text(liveRows(live(80, 24, {
    pending: [[{ text: '  ▪ bash  command: sleep 5' }]],
    activity: [{ text: '⠹ ' }, { text: 'Mica is running bash' }, { text: ' · 0:07' }],
  })));
  expect(rows.slice(0, 5)).toEqual(['', '  ▪ bash  command: sleep 5', '', '⠹ Mica is running bash · 0:07', '╭─────────────────────────────────────────────────────────────────────────────╮']);
});

test('the input grows with its text to eight rows and shows the ones around the cursor; attached images are chips inside the box, and the footer says how to take one off', () => {
  const six = 'a\nb\nc\nd\ne\nf';
  const edit: Edit = { ...EMPTY, text: six, cursor: six.length, chips: [PNG, { ...PNG, path: `memory/images/${'b'.repeat(64)}.jpg`, ext: 'jpg', width: null, height: null, bytes: 3_400_000 }] };
  const rows = text(liveRows(live(100, 30, { edit, hint: 'attached: image 1, image 2 · Backspace at the start removes the last' })));
  expect(rows.slice(1, 5)).toEqual([
    `╭${'─'.repeat(97)}╮`,
    `│ ${'[image 1 · png · 1280×720 · 240 KB]  [image 2 · jpg · 3.2 MB]'.padEnd(95)} │`,
    `│ ${'› a'.padEnd(95)} │`,
    `│ ${'  b'.padEnd(95)} │`,
  ]);
  expect(rows.at(-1)).toMatch(/^ gpt-6\.1-sol {2}resting {3,}attached: image 1, image 2 · Backspace at the start removes the last$/);
  // Where both do not fit, what is attached is said and the context gives way.
  expect(text(liveRows(live(80, 30, { edit, hint: 'attached: image 1, image 2 · Backspace at the start removes the last' }))).at(-1)).toMatch(/ attached: image 1, image 2 · Backspace at the start removes the last$/);
  const many = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const tall = text(liveRows(live(80, 30, { edit: { ...EMPTY, text: many, cursor: many.length } })));
  expect(tall.filter((row) => row.startsWith('│'))).toHaveLength(8);
  expect(tall.some((row) => row.includes('line 19'))).toBe(true);
  // Chips too many for one row go on to the next.
  const four = text(liveRows(live(60, 30, { edit: { ...EMPTY, chips: [PNG, PNG, PNG, PNG] } })));
  expect(four.filter((row) => row.includes('[image'))).toHaveLength(4);
});

test('the cell the owner types at is drawn with its colours swapped, on the character there or on a space after the last', () => {
  const marked = (edit: Edit): string[] => liveRows(live(60, 24, { edit })).flatMap((row) => row.filter((span) => span.style?.inverse).map((span) => span.text));
  expect(marked(EMPTY)).toEqual([' ']);
  expect(marked({ ...EMPTY, text: 'héllo', cursor: 5 })).toEqual([' ']);
  expect(marked({ ...EMPTY, text: 'héllo', cursor: 1 })).toEqual(['é']);
  expect(marked({ ...EMPTY, text: '日本語', cursor: 1 })).toEqual(['本']);
  expect(marked({ ...EMPTY, text: 'a👨‍👩‍👧b', cursor: 1 })).toEqual(['👨‍👩‍👧']);
  expect(marked({ ...EMPTY, text: 'one\ntwo', cursor: 4 })).toEqual(['t']);
});

test('the live region never takes more than half the rows of the screen, and no row reaches the last column, at any size', () => {
  const many = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const busy: Partial<Live> = {
    pending: Array.from({ length: 30 }, (_, i): Line => [{ text: `  ▪ tool ${i}` }]),
    activity: [{ text: '⠹ thinking' }],
    edit: { ...EMPTY, text: many, cursor: many.length, chips: [PNG, PNG] },
    hint: 'image 1 attached',
  };
  for (const [cols, rows] of [[200, 60], [120, 35], [80, 24], [60, 16], [40, 10], [40, 6], [30, 4], [20, 3], [10, 2]] as const) {
    for (const v of [live(cols, rows), live(cols, rows, busy)]) {
      const out = liveRows(v);
      expect(out.length).toBeLessThanOrEqual(Math.max(3, Math.floor(rows / 2)));
      expect(out.length).toBeGreaterThan(0);
      if (cols >= 20) for (const row of out) expect(lineWidth(row)).toBeLessThanOrEqual(cols - 1);
      // The row being typed on is always there.
      expect(out.some((row) => row.some((span) => span.style?.inverse))).toBe(true);
    }
  }
  // A small screen gives up what is under way and what is attached before the box.
  const small = text(liveRows(live(40, 8, busy)));
  expect(small).toHaveLength(3);
  expect(small.some((row) => row.startsWith('╭'))).toBe(true);
  expect(small.some((row) => row.includes('tool'))).toBe(false);
  // At its smallest it is the box alone, around one row.
  expect(text(liveRows(live(30, 4, busy))).map((row) => row[0])).toEqual(['╭', '│', '╰']);
});

// --- commands, offered and coloured ---

const KEYS = ['Tab completes', 'Enter runs', 'Esc closes', 'Up/Down choose'];
const offered = (prefix: string, chosen = 0): Offered => ({ matches: COMMANDS.filter((c) => c.name.startsWith(prefix)), chosen, keys: KEYS });
const typing = (typed: string, cursor = typed.length): Edit => ({ ...EMPTY, text: typed, cursor });

test('the commands offered stand under the box, the chosen one marked, each with what may follow it and what it does; where the footer was, what the keys do', () => {
  expect(text(liveRows(live(80, 24, { edit: typing('/h'), list: offered('/h') })))).toEqual([
    '',
    `╭${'─'.repeat(77)}╮`,
    `│ › /h${' '.repeat(72)}│`,
    `╰${'─'.repeat(77)}╯`,
    '  ▸ /help     the keys and commands',
    '    /history  print the earlier conversation that was read from the journal',
    ' Tab completes · Enter runs · Esc closes · Up/Down choose',
  ]);
  // The footer, with its tip, the context and what is attached, is back when nothing is offered.
  expect(text(liveRows(live(80, 24, { edit: typing('/h'), list: null }))).at(-1)).toBe(' gpt-6.1-sol  resting  …/data/work/teneral            context 8% (71.9k/1.05M)');
  // What is under way and what the agent is doing stay over the box.
  const busy = text(liveRows(live(80, 30, { edit: typing('/h'), list: offered('/h', 1), pending: [[{ text: '  ▪ bash  sleep 9' }]], activity: [{ text: '⠹ The agent is running bash' }] })));
  expect(busy).toEqual([
    '',
    '  ▪ bash  sleep 9',
    '',
    '⠹ The agent is running bash',
    `╭${'─'.repeat(77)}╮`,
    `│ › /h${' '.repeat(72)}│`,
    `╰${'─'.repeat(77)}╯`,
    '    /help     the keys and commands',
    '  ▸ /history  print the earlier conversation that was read from the journal',
    ' Tab completes · Enter runs · Esc closes · Up/Down choose',
  ]);
  // The chosen row is the owner's colour and heavy; the others are set back.
  const rows = liveRows(live(80, 24, { edit: typing('/h'), list: offered('/h', 1) }));
  expect(rows[4]!.find((span) => span.text === '/help')!.style).toBeUndefined();
  expect(rows[5]!.find((span) => span.text === '/history')!.style).toEqual({ fg: 'accent', bold: true });
  expect(plain(rows[5]!).startsWith('  ▸ /history')).toBe(true);
  // Without UTF-8 the mark is a plain one.
  expect(text(liveRows(live(80, 24, { g: glyphs(false), edit: typing('/h'), list: offered('/h') })))[4]).toBe('  > /help     the keys and commands');
});

test('of more commands than six, the six around the chosen one are shown, and the row under them says which of how many it is', () => {
  const at = (chosen: number, cols = 80, rows = 30): string[] => text(liveRows(live(cols, rows, { edit: typing('/'), list: offered('/', chosen) }))).slice(4);
  const shown = (rows: string[]): string[] => rows.slice(0, -1).map((row) => /\/[a-z]+/.exec(row)![0]);
  expect(shown(at(0))).toEqual(['/help', '/image', '/stop', '/approve', '/tools', '/generations']);
  expect(at(0).at(-1)).toBe(` Tab completes · Enter runs · Esc closes · Up/Down choose${' '.repeat(15)}1 of 13`);
  expect(at(0)[0]!.startsWith('  ▸ /help ')).toBe(true);
  expect(shown(at(5))).toEqual(['/stop', '/approve', '/tools', '/generations', '/history', '/offers']);
  expect(at(5)[3]!.startsWith('  ▸ /generations ')).toBe(true);
  expect(shown(at(12))).toEqual(['/offers', '/plain', '/usage', '/memory', '/reasoning', '/quit']);
  expect(at(12)[5]!.startsWith('  ▸ /quit ')).toBe(true);
  expect(at(12).at(-1)).toMatch(/ {3,}13 of 13$/);
  for (let chosen = 0; chosen < COMMANDS.length; chosen++) expect(at(chosen).filter((row) => row.startsWith('  ▸ '))).toEqual([expect.stringContaining(COMMANDS[chosen]!.name)]);
});

test('with commands offered the live region still takes no more than half the screen and never the last column: fewer are shown, down to the chosen one, at 40, 80 and 120 columns and smaller', () => {
  const busy: Partial<Live> = {
    pending: Array.from({ length: 30 }, (_, i): Line => [{ text: `  ▪ tool ${i}` }]),
    activity: [{ text: '⠹ thinking' }],
  };
  for (const [cols, rows] of [[200, 60], [120, 40], [120, 12], [80, 24], [80, 10], [60, 16], [40, 24], [40, 10], [40, 6], [30, 4], [20, 3]] as const) {
    for (const chosen of [0, 5, 10]) {
      for (const more of [{}, busy, { edit: { ...typing('/'), chips: [PNG, PNG] } }]) {
        const out = liveRows(live(cols, rows, { edit: typing('/'), list: offered('/', chosen), ...more }));
        expect(out.length).toBeLessThanOrEqual(Math.max(3, Math.floor(rows / 2)));
        for (const row of out) expect(lineWidth(row)).toBeLessThanOrEqual(cols - 1);
        // The row typed on is there, and so is the chosen command, whatever else gave way.
        expect(out.some((row) => row.some((span) => span.style?.inverse))).toBe(true);
        expect(text(out).filter((row) => row.startsWith('  ▸ /'))).toEqual([expect.stringContaining(COMMANDS[chosen]!.name)]);
      }
    }
  }
  // 24 rows: all six, and the keys. 10 rows: the box, two commands. 6 rows: the row typed on and one command.
  expect(text(liveRows(live(40, 24, { edit: typing('/'), list: offered('/') })))).toEqual([
    '',
    `╭${'─'.repeat(37)}╮`,
    `│ › /${' '.repeat(33)}│`,
    `╰${'─'.repeat(37)}╯`,
    '  ▸ /help              the keys and co…',
    '    /image <path>      attach an image…',
    '    /stop              interrupt what …',
    '    /approve [commit]  approve the mut…',
    '    /tools             show or hide wh…',
    '    /generations       the generations…',
    ' Tab completes · Enter runs     1 of 13',
  ]);
  expect(text(liveRows(live(40, 10, { edit: typing('/'), list: offered('/', 4) }))).map((row) => row.slice(0, 12))).toEqual(['╭───────────', '│ › /       ', '╰───────────', '    /approve', '  ▸ /tools  ']);
  expect(text(liveRows(live(40, 6, { edit: typing('/'), list: offered('/', 4) })))).toEqual(['› /', '  ▸ /tools             show or hide wh…']);
});

test('in the box a command\'s name is drawn in the owner\'s colour, a name still being typed set back, a mistake as a warning; what follows it and every other text stay plain', () => {
  /** The spans of the row typed on that carry a colour, without the prompt mark. */
  const coloured = (edit: Edit, cols = 80): [string, string][] => liveRows(live(cols, 24, { edit })).filter((row) => plain(row).startsWith('│'))
    .flatMap((row) => row.slice(3, -2)).filter((span) => span.style?.fg !== undefined).map((span) => [span.text, span.style!.fg!]);
  expect(coloured(typing('/help'))).toEqual([['/help', 'accent']]);
  expect(coloured(typing('/image ~/Pictures/plan.png'))).toEqual([['/image', 'accent']]);
  expect(coloured(typing('/image ~/写真/日本語.png'))).toEqual([['/image', 'accent']]);
  expect(coloured(typing('  /stop'))).toEqual([['/stop', 'accent']]);
  expect(coloured(typing('/he'))).toEqual([['/he', 'dim']]);
  expect(coloured(typing('/hlep'))).toEqual([['/hlep', 'warn']]);
  expect(coloured(typing('/hlep me out'))).toEqual([['/hlep', 'warn']]);
  expect(coloured(typing('/stop doing that'))).toEqual([['/stop', 'warn']]);
  for (const words of ['hello', 'what does /help do?', '/home/owner/file.png', '/teneral/body is where you live', '//help', '/help\nplease', '日本語 /help', '']) expect(coloured(typing(words))).toEqual([]);
  // The cursor inside the name: that cell is swapped and keeps the name's colour, and the name is still whole.
  const row = liveRows(live(80, 24, { edit: typing('/help me', 2) })).find((r) => plain(r).startsWith('│'))!;
  expect(row.slice(3, -2).map((span) => [span.text, span.style ?? null])).toEqual([
    ['/h', { fg: 'warn' }], ['e', { fg: 'warn', inverse: true }], ['lp', { fg: 'warn' }], [' me', null], [' '.repeat(65), null],
  ]);
  // A name too long for a row of a very narrow box is coloured on each row it runs over.
  expect(coloured(typing('/generations'), 14)).toEqual([['/genera', 'accent'], ['tions', 'accent']]);
});

test('the welcome panel: the mark, who is being talked to, and the facts as an aligned table in a round frame', () => {
  const rows = text(welcome({ name: 'Мира', facts: [['Directory', '/home/owner/teneral'], ['Generation', '3rd · a1b2c3d · has lived in 3'], ['Model', 'gpt-6.1-sol · ChatGPT plan']] }, 70, G));
  expect(rows).toEqual([
    '╭────────────────────────────────────────────────────────────────────╮',
    '│                                                                    │',
    '│   ▗▛▀▀▜▄▖   Talking with Мира                                      │',
    '│   █ ▟▙ ▐    Type to talk, Enter sends. /help lists the keys and c… │',
    '│   ▝▜▄▄▟▘                                                           │',
    '│                                                                    │',
    '│   Directory    /home/owner/teneral                                 │',
    '│   Generation   3rd · a1b2c3d · has lived in 3                      │',
    '│   Model        gpt-6.1-sol · ChatGPT plan                          │',
    '│                                                                    │',
    '╰────────────────────────────────────────────────────────────────────╯',
  ]);
  // Without a name it says so plainly; a long value wraps under itself; a narrow panel leaves the mark out.
  const narrow = text(welcome({ name: null, facts: [['Directory', '/a/very/long/path/that/does/not/fit/in/the/panel/at/all']] }, 36, G));
  expect(narrow.join('\n')).toContain('Talking with your teneral agent');
  expect(narrow.join('\n')).not.toContain('▟▙');
  for (const row of narrow) expect(row.length).toBeLessThanOrEqual(36);
  for (const max of [200, 120, 80, 50, 30, 12]) for (const row of welcome({ name: 'Mica', facts: [['A', 'b'.repeat(300)]] }, max, G)) expect(lineWidth(row)).toBeLessThanOrEqual(Math.max(max, 5));
  // Without UTF-8 the same panel is ASCII.
  expect(text(welcome({ name: 'Mica', facts: [['Model', 'm']] }, 60, glyphs(false))).join('\n')).toMatch(/^[\x20-\x7e\n]*$/);
});

test('a frame holds any rows at the width given, and a status line hangs under its mark', () => {
  expect(text(panel([[{ text: 'one' }], [{ text: 'a row that is far too long for it' }]], 16, G, {}))).toEqual(['╭──────────────╮', '│ one          │', '│ a row that i │', '╰──────────────╯']);
  expect(text(status([{ text: 'Mica' }, { text: ' is awake · resting' }], ['Leaving this client stops nothing: Mica goes on.'], 40, G))).toEqual([
    '◆ Mica is awake · resting', '  Leaving this client stops nothing:', '  Mica goes on.',
  ]);
});

test('every kind of entry fits the width it is given, and none throws at a width of a few columns', () => {
  const entries = [
    { kind: 'owner', text: 'привет, как дела\nвторая строка 日本語', images: [PNG.path, 'memory/images/gone.png'], pending: true },
    { kind: 'owner', text: '', images: [PNG.path] },
    { kind: 'reasoning', text: 'The owner greets me. I should answer briefly, in the same language.\n\nThen ask.' },
    { kind: 'reply', text: '# H\n\n- список **жирный** `code`\n\n```\nlong code line here\n```\n> q', first: true },
    { kind: 'tool', callId: 'c', name: 'bash', args: 'command: ls -la /a/long/path', status: 'failed', ms: 1234, output: 'line one\nline two 日本語\n\tindented' },
    { kind: 'notice', tone: 'warn', title: 'rolled back', move: ['aaaaaaa', 'bbbbbbb'], lead: 'crashed 3 times without a reply.', body: 'TypeError: x\n    at y' },
    { kind: 'quiet', label: 'from alice', text: 'a message that is long enough to be cut' },
    { kind: 'warning', text: 'The provider refused the request.' },
    { kind: 'note', text: 'Nothing has been said yet.' },
    { kind: 'page', title: 'teneral talk', text: ['Enter sends what you typed.', '', '  /help   this'] },
  ] as const;
  for (const max of [200, 80, 40, 24, 12, 6, 3]) {
    for (const e of entries) {
      const rows = entryRows({ ...e, id: 1, rev: 0 } as never, max, LOOK);
      expect(rows.length).toBeGreaterThan(0);
      // From 40 columns up, which is the smallest screen meant to work, nothing is wider than asked. Narrower, the client cuts what is left over.
      if (max >= 40) for (const row of rows) expect(lineWidth(row)).toBeLessThanOrEqual(max);
    }
  }
});

test('each kind of entry has its own mark in the first two columns, and what others wrote starts in the third', () => {
  const rows = (e: object): string[] => text(entryRows({ ...e, id: 1, rev: 0 } as never, 60, LOOK));
  expect(rows({ kind: 'owner', text: 'look at this', images: [PNG.path, 'memory/images/gone.webp'] })).toEqual(['› look at this', '  [image 1 · png · 1280×720 · 240 KB]', '  [image 2 · webp · not in memory/images]']);
  expect(rows({ kind: 'owner', text: '', images: [PNG.path], elsewhere: true })).toEqual(['› [image 1 · png · 1280×720 · 240 KB]  from another terminal']);
  expect(rows({ kind: 'reasoning', text: 'The owner asks what is in body/. I should list it rather than answer from memory.' })).toEqual(['○ The owner asks what is in body/. I should list it rather', '  than answer from memory.']);
  expect(rows({ kind: 'reply', text: 'Ten files.\n\n- one\n- two', first: false })).toEqual(['● Ten files.', '', '  • one', '  • two']);
  expect(rows({ kind: 'tool', callId: 'c', name: 'bash', args: 'command: ls', status: 'ok', ms: 250, output: '' })).toEqual([`${'  ▪ bash  command: ls'.padEnd(53)}✓ 250ms`]);
  expect(rows({ kind: 'tool', callId: 'c', name: 'read', args: 'path: x', status: 'failed', ms: 12_000, output: 'ENOENT' })).toEqual([`${'  ▪ read  path: x'.padEnd(48)}✗ failed 12s`, '      ENOENT']);
  expect(rows({ kind: 'tool', callId: 'c', name: 'bash', args: '', status: 'running', ms: null, output: '' })).toEqual([`${'  ▪ bash'.padEnd(53)}running`]);
  expect(rows({ kind: 'notice', tone: 'good', title: 'mutation accepted', move: ['aaaaaaa', 'bbbbbbb'], lead: '', body: '' })).toEqual(['┃ mutation accepted  aaaaaaa → bbbbbbb']);
  expect(rows({ kind: 'notice', tone: 'warn', title: 'rolled back', move: ['bbbbbbb', 'aaaaaaa'], lead: 'crashed 3 times.', body: 'TypeError: x\n    at y' })).toEqual(['┃ rolled back  bbbbbbb → aaaaaaa', '┃   crashed 3 times.', '┃   TypeError: x', '┃       at y']);
  expect(rows({ kind: 'quiet', label: 'clock', text: 'tick' })).toEqual(['  ◦ clock  tick']);
  expect(rows({ kind: 'warning', text: 'The provider refused.' })).toEqual(['! not from the model', '  The provider refused.']);
  expect(rows({ kind: 'page', title: 'the plain client', text: ['one', '', '  two'] })[0]).toMatch(/^ {2}── the plain client ─+$/);
  // The same in ASCII.
  expect(text(entryRows({ kind: 'owner', text: 'x', images: [PNG.path], id: 1, rev: 0 }, 60, { ...LOOK, g: glyphs(false) }))).toEqual(['> x', '  [image 1 | png | 1280x720 | 240 KB]']);
  expect(chip(3, null, 'memory/images/x.gif', G)).toBe('[image 3 · gif · not in memory/images]');
});

test('how long something took, and how long something has been going on, are said at the precision that matters', () => {
  expect([0, 40, 999, 1000, 2540, 9999, 12_400, 59_400, 61_000, 187_000].map(duration)).toEqual(['0ms', '40ms', '999ms', '1.0s', '2.5s', '10.0s', '12s', '59s', '1m01s', '3m07s']);
  expect([0, 7900, 60_000, 760_000, 3_723_000, -5].map(elapsed)).toEqual(['0:00', '0:07', '1:00', '12:40', '1:02:03', '0:00']);
});

test('how full the context is: a share and both counts when the window is known, the count alone when it is not; a directory in little room', () => {
  expect([840, 1000, 71_900, 99_950, 128_000, 500_000, 1_000_000, 1_050_000].map(tokens)).toEqual(['840', '1k', '71.9k', '100k', '128k', '500k', '1M', '1.05M']);
  expect(contextUse(71_900, 1_050_000)).toBe('context 7% (71.9k/1.05M)');
  expect(contextUse(400_000, 500_000)).toBe('context 80% (400k/500k)');
  expect(contextUse(600_000, 500_000)).toBe('context 100% (600k/500k)');
  expect(contextUse(71_900, null)).toBe('context 71.9k');
  expect(shortDir('/home/owner/data/work/teneral', G)).toBe('…/work/teneral');
  expect(shortDir('/teneral', G)).toBe('/teneral');
  expect(shortDir('/a/b', G)).toBe('/a/b');
  expect(shortDir('/a/b/c', glyphs(false))).toBe('.../b/c');
});

test('a request under way is put into words: what is arriving, with its end, how long the first word is waited for, and for how long nothing new has come', () => {
  const at = Date.parse('2026-11-13T10:00:00.000Z');
  const b = (step: string, more: Record<string, unknown> = {}) => beatOf(JSON.stringify({ at: new Date(at).toISOString(), asked: new Date(at - 30_000).toISOString(), step, received: 3400, ...more }))!;
  expect(beatWords(b('asked'), at + 12_000, '…')).toBe('waiting for the model\'s first word, 0:42');
  expect(beatWords(b('reasoning', { tail: 'then  the\ntests' }), at, '…')).toBe('the model is reasoning: …then the tests');
  expect(beatWords(b('writing', { tail: 'x'.repeat(300) }), at, '…')).toBe(`the model is writing: …${'x'.repeat(TAIL_SHOWN)}`);
  expect(beatWords(b('calling'), at, '…')).toBe('the model is preparing a tool call, 3.4k characters so far');
  expect(beatWords(b('receiving', { received: 120 }), at, '…')).toBe('the model is answering, 120 characters so far');
  expect(beatWords(b('writing', { tail: 'so' }), at + SILENT_MS + 15_000, '…')).toBe('the model is writing: …so (nothing new for 1:00)');
  // The file is the body's: anything that is not a pulse is none.
  for (const text of ['', 'null', '[]', '{}', '{"at":"soon","asked":"x","step":"asked"}', '{"at":"2026-11-13T10:00:00.000Z","asked":"2026-11-13T10:00:00.000Z"}']) expect(beatOf(text)).toBeNull();
});
