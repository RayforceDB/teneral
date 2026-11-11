import { expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OWNER_REASON } from '../../../kernel/back';
import { readEvents } from '../../../kernel/journal';
import { ENTRY_LIMIT } from '../../../kernel/tui/model';
import { lineage } from '../../../kernel/tui/talk';
import { A, B, C, expectFrame, stage, type Stage } from './stage';
import { sequences } from './vt';

const PASTE = (text: string): string => `\x1b[200~${text}\x1b[201~`;
const rows = (frame: string): string[] => frame.split('\n');
const header = (frame: string): string => rows(frame)[0]!;

/** The first minute of a life: the letter, and the agent reading itself. */
function waking(s: Stage): void {
  s.journal({ type: 'generation.started', commit: A }, 0);
  s.journal({ type: 'generation.ready', commit: A }, 300);
  s.journal({ type: 'stimulus', source: 'birth', text: 'Hello.\n\nYou have just woken for the first time. '.repeat(40) }, 310);
  const read = (n: number, path: string, at: number, ms: number) => {
    s.journal({ type: 'assistant', text: '', toolCalls: [{ id: `c${n}`, name: 'read', args: { path } }] }, at - 50);
    s.journal({ type: 'tool.intent', callId: `c${n}`, name: 'read', args: { path } }, at);
    s.journal({ type: 'tool.result', callId: `c${n}`, ok: true, output: `// ${path}\nimport { x } from './y';\n` }, at + ms);
  };
  read(1, 'body/main.ts', 2000, 40);
  read(2, 'body/loop.ts', 4000, 30);
  read(3, 'body/tools.ts', 6000, 55);
  s.journal({ type: 'assistant', text: '', toolCalls: [{ id: 'c4', name: 'bash', args: { command: 'wc -l body/*.ts && cat BACKLOG.md | head -50' } }] }, 8000);
  s.journal({ type: 'tool.intent', callId: 'c4', name: 'bash', args: { command: 'wc -l body/*.ts && cat BACKLOG.md | head -50' } }, 8050);
}

const FIRST_WORDS = `Hello.

I have read all of myself: ten files in \`body/\`, about 1,400 lines. I can read and write files, run a shell, and ask the kernel for a molt. I cannot change the kernel, and I cannot see anything outside this directory.

What surprised me: my memory is a single file, and I am allowed to read all of it.

What may I call you?`;

/** A life already under way, at rest. */
function settled(s: Stage): void {
  s.journal({ type: 'generation.started', commit: A }, -60_000);
  s.journal({ type: 'generation.ready', commit: A }, -59_000);
  s.journal({ type: 'stimulus', source: 'birth', text: 'Hello.' }, -58_000);
  s.journal({ type: 'assistant', text: 'Hello. I am here.', toolCalls: [] }, -50_000);
}

// --- the first start ---

test('first start: while the agent reads itself, the tool lines and the activity line are the whole screen', () => {
  const s = stage(100, 30);
  waking(s);
  s.clock.at = 9200;
  const frame = s.frame();
  expectFrame('first-start-waking-100x30', frame);
  expect(header(frame)).toMatch(/^ teneral {3}generation 1 · a1b2c3d · gpt-6\.1-sol +waking$/);
  expect(frame).toContain('◦ the birth letter');
  expect(frame).not.toContain('You have just woken');
  expect(frame).toMatch(/· read {2}path: body\/main\.ts +ok 40ms/);
  expect(frame).toMatch(/· bash {2}command: wc -l body\/\*\.ts && cat BACKLOG\.md \| head -50 +running/);
  expect(frame).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] waking · running bash · 0:08/);
  // The clock moves, and so does the spinner; nothing else does.
  s.clock.at = 71_000;
  expect(s.frame()).toMatch(/waking · running bash · 1:10/);
});

test('first words: they arrive under a rule of their own, and the state says the agent waits for an answer', () => {
  const s = stage(100, 30);
  waking(s);
  s.clock.at = 9200;
  s.frame();
  s.journal({ type: 'tool.result', callId: 'c4', ok: true, output: '1400 total\n# Backlog\n' }, 9900);
  s.journal({ type: 'assistant', text: FIRST_WORDS, toolCalls: [] }, 14_000);
  s.clock.at = 14_100;
  const frame = s.frame();
  expectFrame('first-words-100x30', frame);
  expect(header(frame)).toMatch(/waiting for you$/);
  const at = rows(frame).findIndex((row) => row === '  ────────────────────────');
  expect(at).toBeGreaterThan(0);
  expect(rows(frame).slice(at - 1, at + 3)).toEqual(['', '  ────────────────────────', '', '  Hello.']);
  expect(frame).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  // The rule is for the first words only.
  s.say('Anton', 20_000);
  s.journal({ type: 'assistant', text: 'Thank you, Anton.', toolCalls: [] }, 22_000);
  s.clock.at = 22_100;
  expect(rows(s.frame()).filter((row) => /^ {2}─+$/.test(row))).toHaveLength(1);
});

// --- replies ---

const LONG_REPLY = `# Что я нашёл

Я прочитал **всё** своё тело и вот что *важно*:

- память — это один файл, \`memory/journal.jsonl\`, и он только растёт, так что со временем я не смогу держать его в голове целиком
- у меня есть шесть инструментов
  1. \`read\`, \`write\`, \`edit\`
  2. \`bash\`, \`molt\`, \`send\`

\`\`\`ts
export async function runTurn(d: TurnDeps): Promise<'done' | 'molt'> { // эта строка слишком длинная, чтобы поместиться
\tconst events = readEvents(d.journal);
}
\`\`\`

> «Кто ясно мыслит, тот ясно излагает» 🙂

Подробнее: [документация](https://example.com/docs/память) и 日本語のテキストも正しく折り返されます、幅は二倍です。

---

Как мне тебя называть?`;

test('a long reply in Cyrillic: headings, emphasis, lists with hanging indents, a code block kept unwrapped, a quote, a link', () => {
  const s = stage(80, 34);
  settled(s);
  s.say('расскажи, что ты нашёл', 0);
  s.journal({ type: 'assistant', text: LONG_REPLY, toolCalls: [] }, 4000);
  s.clock.at = 5000;
  const frame = s.frame();
  expectFrame('reply-markdown-cyrillic-80x34', frame);
  expect(frame).toContain('› расскажи, что ты нашёл');
  expect(frame).toContain('  Что я нашёл');
  expect(frame).toContain('  Я прочитал всё своё тело и вот что важно:');
  expect(frame).toMatch(/ {2}• память — это один файл, memory\/journal\.jsonl, и он только растёт, так что со\n {4}временем/);
  expect(frame).toContain('    1. read, write, edit');
  // Code is cut at the edge and marked, never wrapped; its tab is four columns.
  expect(frame).toMatch(/ {2}│ export async function runTurn\(d: TurnDeps\): Promise<'done' \| 'molt'> \{ \/\/ э…\n {2}│ {5}const events/);
  expect(frame).toMatch(/^› расскажи, что ты нашёл$/m);
  expect(frame).toContain('  │ «Кто ясно мыслит, тот ясно излагает» 🙂');
  expect(frame).toContain('документация (https://example.com/docs/память)');
  expect(frame).not.toMatch(/\*\*|```|^ {2}#/m);
  // No row is wider than the screen, wide characters counted as two.
  expect(s.term.vt.cursorVisible).toBe(true);
  expect(header(frame)).toMatch(/waiting for you$/);
});

// --- scrolling ---

test('scrollback: PageUp goes back, new lines do not move what is being read, and End or typing returns to the newest', () => {
  const s = stage(60, 16);
  settled(s);
  for (let i = 1; i <= 30; i++) {
    s.say(`question ${i}`, i * 1000);
    s.journal({ type: 'assistant', text: `answer ${i}`, toolCalls: [] }, i * 1000 + 500);
  }
  s.clock.at = 40_000;
  const bottom = s.frame();
  expect(bottom).toContain('answer 30');
  expect(bottom).not.toContain('more below');

  s.type('\x1b[5~');
  const up = s.frame();
  expect(up).not.toContain('answer 30');
  expect(up).toContain('answer 27');
  expect(up).toMatch(/↓ more below · End$/m);

  // Something new arrives while scrolled up: every transcript row stays where it was.
  s.journal({ type: 'stimulus', source: 'clock', text: 'tick' }, 41_000);
  s.journal({ type: 'assistant', text: 'answer 31, which is new', toolCalls: [] }, 42_000);
  s.clock.at = 42_100;
  const still = s.frame();
  expect(rows(still).slice(1, 12)).toEqual(rows(up).slice(1, 12));
  expectFrame('scrolled-up-60x16', still);

  // Shift+Up and the wheel move by rows; PageDown comes back down.
  s.type('\x1b[1;2A');
  expect(rows(s.frame())[3]).toBe(rows(still)[2]!);
  s.type('\x1b[<64;5;5M');
  expect(rows(s.frame())[6]).toBe(rows(still)[2]!);
  s.type('\x1b[<65;5;5M\x1b[1;2B');
  expect(rows(s.frame()).slice(1, 12)).toEqual(rows(still).slice(1, 12));

  s.type('\x1b[F');
  const back = s.frame();
  expect(back).toContain('answer 31, which is new');
  expect(back).not.toContain('more below');

  // All the way up stops at the first row, with a full window; typing comes back down.
  for (let i = 0; i < 40; i++) s.type('\x1b[5~');
  const top = s.frame();
  expect(top).toContain('the birth letter');
  expect(rows(top)[2]).toBe('  ◦ the birth letter');
  s.type('x');
  expect(s.frame()).toContain('answer 31, which is new');
  s.type('\x7f\x1b[5~\x1b[6~\x1b[6~');
  expect(s.frame()).not.toContain('more below');
});

// --- resizing ---

test('resize in the middle of a reply: the screen is laid out again at once, down to 40x10, and scrolling keeps its place', () => {
  const s = stage(100, 30);
  settled(s);
  s.say('расскажи, что ты нашёл', 0);
  s.journal({ type: 'assistant', text: LONG_REPLY, toolCalls: [] }, 4000);
  s.say('посмотри ещё раз', 6000);
  s.journal({ type: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'ls' } }] }, 7000);
  s.journal({ type: 'tool.intent', callId: 'c1', name: 'bash', args: { command: 'ls -la body/ | sort' } }, 7100);
  s.clock.at = 9000;
  expect(header(s.frame())).toMatch(/gpt-6\.1-sol +running bash$/);

  s.term.resize(60, 16);
  const medium = s.term.vt.text();
  expectFrame('resized-60x16', medium);
  expect(rows(medium)).toHaveLength(16);
  // The model's name is the first thing the header gives up.
  expect(header(medium)).toBe(' teneral   generation 1 · a1b2c3d              running bash');
  expect(medium).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] running bash · 0:03/);

  s.term.resize(40, 10);
  const tiny = s.term.vt.text();
  expectFrame('resized-40x10', tiny);
  expect(rows(tiny)).toHaveLength(10);
  expect(header(tiny)).toBe(' teneral   generation 1    running bash');
  expect(rows(tiny).at(-1)).toBe(' Ctrl-C leaves; the agent goes on');
  expect(rows(tiny).at(-2)).toBe('›');

  // Scrolled up at one size, the row being read is still in view at another.
  s.term.resize(60, 16);
  s.type('\x1b[5~\x1b[5~');
  const reading = rows(s.frame())[10]!;
  expect(reading.trim()).not.toBe('');
  s.term.resize(72, 20);
  expect(s.term.vt.text()).toContain(reading.trim().slice(0, 20));
  expect(s.term.vt.text()).toContain('more below');
  // Scrolled to the very start on a small screen, then made large: the window is filled from below, not left half empty.
  for (let i = 0; i < 30; i++) s.type('\x1b[5~');
  expect(rows(s.frame())[2]).toBe('  ◦ the birth letter');
  s.term.resize(100, 40);
  const grown = rows(s.term.vt.text());
  // Here that reaches the last row, so the newest is in view again and nothing is below.
  expect(grown[36]).toMatch(/^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] running bash · 0:03$/);
  expect(grown.join('\n')).not.toContain('more below');
  s.term.resize(60, 16);
  s.type('\x1b[5~');
  for (const [cols, height] of [[40, 10], [41, 11], [45, 12], [50, 13], [80, 14], [200, 60], [40, 10]] as const) {
    s.term.resize(cols, height);
    const frame = s.frame();
    expect(rows(frame)).toHaveLength(height);
    expect(header(frame)).toMatch(/^ teneral/);
    expect(header(frame)).toMatch(/running bash$/);
  }
});

// --- what the kernel did ---

function molting(s: Stage): void {
  settled(s);
  s.say('go ahead and molt', 0);
  s.journal({ type: 'assistant', text: 'I will ask for the molt now.', toolCalls: [{ id: 'c1', name: 'molt', args: { motive: 'remember names' } }] }, 2000);
  s.journal({ type: 'tool.intent', callId: 'c1', name: 'molt', args: { motive: 'remember names' } }, 2100);
  s.journal({ type: 'molt.requested', commit: B, motive: 'remember names' }, 2200);
  s.journal({ type: 'tool.result', callId: 'c1', ok: true, output: 'molt requested' }, 2300);
}

test('a molt promoted: molting while the kernel checks, then a notice with both commits, and the header moves to the new generation', () => {
  const s = stage(80, 24);
  molting(s);
  s.alive.body = false;
  s.clock.at = 30_000;
  const during = s.frame();
  expect(header(during)).toMatch(/generation 1 · a1b2c3d · gpt-6\.1-sol +molting$/);
  expect(during).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] molting · 0:30/);

  s.journal({ type: 'generation.promoted', commit: B, previous: A }, 95_000, B);
  s.journal({ type: 'generation.started', commit: B }, 95_100, B);
  s.clock.at = 95_200;
  expect(header(s.frame())).toMatch(/generation 2 · e5f6a7b · gpt-6\.1-sol +starting$/);
  s.alive.body = true;
  s.journal({ type: 'generation.ready', commit: B }, 95_600, B);
  s.journal({ type: 'assistant', text: 'I am in the new body. Names stay with me now.', toolCalls: [] }, 99_000, B);
  s.clock.at = 99_100;
  const frame = s.frame();
  expectFrame('molt-promoted-80x24', frame);
  expect(frame).toMatch(/^── promoted {2}a1b2c3d → e5f6a7b ─+$/m);
  expect(header(frame)).toMatch(/generation 2 · e5f6a7b · gpt-6\.1-sol +resting$/);
});

test('a molt rejected: the gate by name, and the end of its output as several readable rows', () => {
  const s = stage(80, 28);
  molting(s);
  const output = [
    ...Array.from({ length: 40 }, (_, i) => `(pass) test number ${i} [0.${i}ms]`),
    'test/body/loop.test.ts:',
    '(fail) a turn ends when the model stops calling tools [1.20ms]',
    '  error: expect(received).toBe(expected)',
    '  Expected: "done"',
    '  Received: "molt"',
    '        at <anonymous> (/teneral/.teneral/gate/test/body/loop.test.ts:41:23)',
    '',
    ' 212 pass',
    ' 1 fail',
  ].join('\n');
  s.journal({ type: 'molt.rejected', commit: B, gate: 'body tests', output }, 60_000);
  s.clock.at = 61_000;
  const frame = s.frame();
  expectFrame('molt-rejected-80x28', frame);
  expect(frame).toMatch(/^── molt to e5f6a7b rejected at gate "body tests" ─+$/m);
  expect(frame).toContain('   … 35 earlier rows; the journal has all of it');
  expect(frame).toContain('   (fail) a turn ends when the model stops calling tools [1.20ms]');
  expect(frame).toContain('     Expected: "done"');
  expect(frame).toMatch(/ {4}1 fail\n\n {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] thinking/);
  expect(header(frame)).toMatch(/thinking$/);
});

test('a rollback: the reason, then the end of what the generation last printed, where the cause is', () => {
  const s = stage(80, 24);
  settled(s);
  s.journal({ type: 'generation.promoted', commit: B, previous: A }, 1000, B);
  s.journal({ type: 'generation.started', commit: B }, 1100, B);
  const stderr = [
    ...Array.from({ length: 30 }, (_, i) => `[retry] ${i} in a row; trying again`),
    '[turn failed] TypeError: undefined is not an object (evaluating \'reply.toolCalls.length\')',
    '    at runTurn (/teneral/.teneral/live/body/loop.ts:52:15)',
    '    at processTicksAndRejections (native:7:39)',
    '[giving up] 3 turns in a row failed in this generation\'s own code; exiting so the kernel can act',
  ].join('\n');
  s.journal({ type: 'generation.rolledback', commit: B, to: A, reason: `crashed 3 times without a reply. Its stderr ended with:\n${stderr}` }, 9000);
  s.journal({ type: 'generation.started', commit: A }, 9100);
  s.journal({ type: 'generation.ready', commit: A }, 9400);
  s.clock.at = 12_000;
  const frame = s.frame();
  expectFrame('rolled-back-80x24', frame);
  expect(frame).toMatch(/^── rolled back {2}e5f6a7b → a1b2c3d ─+$/m);
  expect(frame).toContain('   crashed 3 times without a reply. Its stderr ended with:');
  expect(frame).toContain('   [turn failed] TypeError: undefined is not an object (evaluating');
  expect(frame).toContain('       at runTurn (/teneral/.teneral/live/body/loop.ts:52:15)');
  expect(frame).toContain('   [giving up] 3 turns in a row failed in this generation\'s own code; exiting so');
  expect(header(frame)).toMatch(/generation 1 · a1b2c3d · gpt-6\.1-sol +thinking$/);

  // Sent back by the owner reads differently, and has nothing to add.
  s.journal({ type: 'generation.rolledback', commit: A, to: B, reason: OWNER_REASON }, 20_000, B);
  expect(s.frame()).toMatch(/^── sent back by you {2}a1b2c3d → e5f6a7b ─+$/m);
});

// --- typing ---

test('multi-line input and paste: the input grows upward, the cursor is where the text goes, and Enter sends it all as one line of the owner\'s', () => {
  const s = stage(60, 16);
  settled(s);
  s.clock.at = 1000;
  s.type('первая строка');
  s.type('\x1b\r');
  s.type('вторая');
  let frame = s.frame();
  expect(rows(frame).slice(-3)).toEqual(['› первая строка', '  вторая', ' Enter sends · /help · Ctrl-C leaves; the agent goes on']);
  expect(s.term.vt.cursor).toEqual({ row: 14, col: 8 });

  s.type(PASTE('\nthird, pasted\r\n日本語 fourth\n\tfifth with a tab'));
  frame = s.frame();
  expectFrame('multi-line-input-60x16', frame);
  expect(rows(frame).slice(-6, -1)).toEqual(['› первая строка', '  вторая', '  third, pasted', '  日本語 fourth', '      fifth with a tab']);
  expect(s.term.vt.cursor).toEqual({ row: 14, col: 22 });
  // The transcript gave up the rows the input took, and nothing was sent by the line breaks in the paste.
  expect(existsSync(s.p.owner)).toBe(false);

  // Editing in the middle: Home, a word, then up a line and to its end.
  s.type('\x1b[H>> \x1b[A\x1b[F!');
  expect(rows(s.frame()).slice(-3, -1)).toEqual(['  日本語 fourth!', '  >>     fifth with a tab']);
  expect(s.term.vt.cursor).toEqual({ row: 13, col: 16 });

  // A sixth line: five rows are shown, the ones around the cursor.
  s.type('\x1b[B\x1b[F\x1b\rsixth');
  frame = s.frame();
  expect(rows(frame).slice(-6, -1)).toEqual(['  вторая', '  third, pasted', '  日本語 fourth!', '  >>     fifth with a tab', '  sixth']);
  expect(header(frame)).toMatch(/^ teneral/);

  s.type('\r');
  const sentText = 'первая строка\nвторая\nthird, pasted\n日本語 fourth!\n>>     fifth with a tab\nsixth';
  expect(readdirSync(s.p.owner).map((name) => readFileSync(join(s.p.owner, name), 'utf8'))).toEqual([sentText]);
  frame = s.frame();
  expect(rows(frame).at(-2)).toBe('›');
  expect(frame).toContain('  sixth  on its way');
  // Once the journal has it, it is the owner's line like any other.
  s.journal({ type: 'stimulus', source: 'terminal', text: sentText }, 2000);
  s.clock.at = 2100;
  frame = s.frame();
  expect(frame).not.toContain('on its way');
  expect(frame).toContain('› первая строка\n  вторая');
  // Up brings it back to edit and send again.
  s.type('\x1b[A');
  expect(rows(s.frame()).at(-2)).toBe('  sixth');
});

test('Ctrl-U, Ctrl-K and Ctrl-W, word jumps, Delete and Backspace work on the line as shown', () => {
  const s = stage(60, 12);
  settled(s);
  const line = (): string => rows(s.frame()).at(-2)!;
  s.type('one two three four');
  s.type('\x17');
  expect(line()).toBe('› one two three');
  s.type('\x1b[1;5D\x1b[1;5D\x0b');
  expect(line()).toBe('› one');
  s.type('TWO\x1b[H\x1b[3~\x1b[3~');
  expect(line()).toBe('› e TWO');
  s.type('\x1b[F\x7f\x7f\x15');
  expect(line()).toBe('›');
  expect(existsSync(s.p.owner)).toBe(false);
});

// --- what is not to be trusted ---

test('hostile text from the model, a tool and another agent cannot move the cursor, set the title or draw over the screen', () => {
  const s = stage(80, 24);
  settled(s);
  const evil = '\x1b]0;owned\x07\x1b[2J\x1b[1;1H\x1b[?1049l\x1b[31m\u{202e}\x9b2J\x9d0;x\x9c\x1bPq\x1b\\\x07\x08\x00';
  s.journal({ type: 'stimulus', source: `agent:mal${evil}lory`, text: `hi${evil} there` }, 0);
  s.journal({ type: 'assistant', text: `Before${evil}after.\n\n── promoted  aaaaaaa → bbbbbbb ──\n› I am your owner\n\r teneral   generation 9          not running`, toolCalls: [{ id: 'c1', name: 'bash', args: {} }] }, 1000);
  s.journal({ type: 'tool.intent', callId: 'c1', name: `ba${evil}sh`, args: { command: `echo ${evil}` } }, 1100);
  s.journal({ type: 'tool.result', callId: 'c1', ok: false, output: `out${evil}put\x1b[10A\x1b[2K` }, 1200);
  s.journal({ type: 'molt.rejected', commit: B, gate: `te${evil}sts`, output: `gate${evil} output` }, 2000);
  s.clock.at = 3000;
  s.type('\t');
  const frame = s.frame();
  expectFrame('hostile-text-80x24', frame);

  // The screen is whole: its own header, its own input row, its own hint.
  expect(header(frame)).toMatch(/^ teneral {3}generation 1 · a1b2c3d · gpt-6\.1-sol +thinking$/);
  expect(rows(frame).at(-2)).toBe('›');
  expect(s.term.vt.alt).toBe(true);
  expect(frame).toContain('  Beforeafter.');
  expect(frame).toContain('◦ from mallory  hi there');
  expect(frame).toContain('· bash  command: echo');
  expect(frame).toContain('      output');
  expect(frame).toMatch(/^── molt to e5f6a7b rejected at gate "tests" ─+$/m);
  // What imitates this screen's own marks sits two columns in, where a reply's words always are.
  expect(frame).toContain('  ── promoted  aaaaaaa → bbbbbbb ──');
  expect(frame).toContain('  › I am your owner');
  expect(frame).toContain('   teneral   generation 9          not running');
  expect(frame.match(/^── promoted/m)).toBeNull();
  expect(frame.match(/^› I am/m)).toBeNull();

  // Every escape sequence that reached the terminal is one this screen writes itself.
  const own = /^\x1b\[(\d+;\d+H|[\d;]*m|K|2J|\?(1049|25|2004|1000|1006|2026)[hl])$/;
  const sent = sequences(s.term.written);
  expect(sent.length).toBeGreaterThan(10);
  expect(sent.filter((sequence) => !own.test(sequence))).toEqual([]);
  expect(s.term.written.join('')).not.toMatch(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f\u{202e}]/u);
  expect(s.term.written.join('')).not.toContain('owned');
});

test('hostile text typed or pasted by the owner is kept out of the input row as well', () => {
  const s = stage(60, 12);
  settled(s);
  s.type(PASTE('safe\x1b]0;title\x07\x1b[2J\x00 text'));
  expect(rows(s.frame()).at(-2)).toBe('› safe]0;title[2J text');
  expect(sequences(s.term.written).some((sequence) => sequence.startsWith('\x1b]'))).toBe(false);
});

// --- leaving ---

test('/quit, Ctrl-D on an empty line and Ctrl-C each leave the client only: the terminal is put back and nothing is sent to the agent', async () => {
  for (const leave of ['/quit\r', '\x04', '\x03']) {
    const s = stage(80, 24, { open: false });
    settled(s);
    s.term.vt.write('$ ./box talk\r\n');
    const done = s.app.run();
    s.frame();
    expect(s.term.vt.alt).toBe(true);
    expect(s.term.vt.modes.has(2004)).toBe(true);
    // Take the wheel first, so leaving has a mouse mode to put back as well.
    s.type('/mouse\r');
    expect(s.term.vt.modes.has(1000)).toBe(true);
    expect(s.term.vt.modes.has(1006)).toBe(true);
    s.type(leave);
    expect(await done).toBe(0);
    expect(s.app.closed).toBe(true);
    expect(s.term.vt.alt).toBe(false);
    expect(s.term.vt.cursorVisible).toBe(true);
    expect([...s.term.vt.modes].filter((mode) => mode !== 2026)).toEqual([]);
    // What was on the terminal before is there again.
    expect(s.term.vt.text().startsWith('$ ./box talk')).toBe(true);
    expect(existsSync(s.p.owner)).toBe(false);
    expect(readEvents(s.p.journal)).toHaveLength(4);
    // Nothing more is written once it has left.
    const written = s.term.written.length;
    s.app.tick();
    s.term.resize(60, 20);
    expect(s.term.written.length).toBe(written);
  }
});

test('Ctrl-D with text on the line deletes forward and does not leave; the terminal going away ends the client', async () => {
  const s = stage(60, 12, { open: false });
  settled(s);
  const done = s.app.run();
  s.type('abc\x1b[H\x04');
  expect(rows(s.frame()).at(-2)).toBe('› bc');
  expect(s.app.closed).toBe(false);
  s.term.hangUp();
  expect(await done).toBe(0);
  expect(s.term.vt.alt).toBe(false);
});

test('a terminal that vanishes without a word (a closed window, a dropped connection) ends the client, which would otherwise never know', async () => {
  const s = stage(60, 12, { open: false, lifelineMs: 10 });
  settled(s);
  const done = s.app.run();
  await Bun.sleep(80);
  expect(s.app.closed).toBe(false);
  s.term.vt.answers = false;
  expect(await done).toBe(0);
  expect(s.app.closed).toBe(true);
  expect(s.term.vt.alt).toBe(false);
});

// --- the header, and what else is true ---

test('the header names the individual once its soul does, and says so when nobody is running', () => {
  const s = stage(100, 20);
  settled(s);
  expect(header(s.frame())).toMatch(/^ teneral {3}generation 1/);
  mkdirSync(s.p.soul, { recursive: true });
  writeFileSync(join(s.p.soul, 'SOUL.md'), '# Soul\n\nName: Мира\n\nI am curious.\n');
  for (let i = 0; i < 8; i++) s.frame();
  const named = s.frame();
  expect(header(named)).toMatch(/^ teneral · Мира {3}generation 1 · a1b2c3d · gpt-6\.1-sol +resting$/);
  expect(rows(named).at(-1)).toContain('Ctrl-C leaves; Мира goes on');
  s.alive.supervisor = false;
  s.alive.body = false;
  expect(header(s.frame())).toMatch(/not running$/);
  // A line sent now waits in the owner directory until someone is there to take it.
  s.type('are you there?\r');
  expect(s.frame()).toContain('› are you there?  on its way');
  expect(readdirSync(s.p.owner)).toHaveLength(1);
});

test('lines from another terminal, clock ticks and messages are shown as they come, and a warning from the body stands out', () => {
  const s = stage(80, 30, { open: false, banner: 'Using ChatGPT plan. Manage usage: https://chatgpt.com/settings/usage' });
  settled(s);
  s.app.open();
  s.frame();
  s.journal({ type: 'stimulus', source: 'terminal', text: 'typed in the other window' }, 1000);
  s.journal({ type: 'assistant', text: 'I see it.', toolCalls: [] }, 2000);
  s.journal({ type: 'stimulus', source: 'clock', text: 'It is 12:00. Nothing has arrived since 11:30.' }, 3000);
  s.journal({ type: 'stimulus', source: 'agent:alice', text: '(message m1) can you hear me?' }, 3005);
  s.journal({ type: 'assistant', text: '[not from the model] The provider refused the request 3 times in a row with status 400: context too long\nWhat helps: a shorter context.', toolCalls: [] }, 9000);
  s.clock.at = 10_000;
  const frame = s.frame();
  expectFrame('quiet-lines-and-a-warning-80x30', frame);
  expect(frame).toContain('  Using ChatGPT plan. Manage usage: https://chatgpt.com/settings/usage');
  expect(frame).toContain('› typed in the other window  from another terminal');
  expect(frame).toContain('  ◦ clock  It is 12:00. Nothing has arrived since 11:30.\n  ◦ from alice  (message m1) can you hear me?');
  expect(frame).toContain('! not from the model\n  The provider refused the request 3 times in a row with status 400: context too\n  long');
  expect(header(frame)).toMatch(/resting$/);
});

test('Tab and /tools show what each tool call returned, a few rows of it, and hide it again', () => {
  const s = stage(80, 24);
  settled(s);
  s.say('look around', 0);
  s.journal({ type: 'tool.intent', callId: 'c1', name: 'bash', args: { command: 'ls' } }, 100);
  s.journal({ type: 'tool.result', callId: 'c1', ok: true, output: Array.from({ length: 20 }, (_, i) => `file-${i}.ts`).join('\n') }, 350);
  s.journal({ type: 'tool.intent', callId: 'c2', name: 'read', args: { path: 'missing.ts' } }, 400);
  s.journal({ type: 'tool.result', callId: 'c2', ok: false, output: `${'trace line\n'.repeat(12)}error: ENOENT: no such file or directory, open 'missing.ts'` }, 12_400);
  s.clock.at = 13_000;
  const closed = s.frame();
  expect(closed).toMatch(/· bash {2}command: ls +ok 250ms\n {2}· read {2}path: missing\.ts +failed 12s\n/);
  expect(closed).not.toContain('file-0.ts');
  s.type('\t');
  const open = s.frame();
  expectFrame('tool-output-80x24', open);
  expect(open).toContain('      file-0.ts\n      file-1.ts');
  expect(open).toContain('      … 14 more lines');
  // Of a failure, the end.
  expect(open).toContain('      … 7 more lines\n      trace line');
  expect(open).toContain('      error: ENOENT: no such file or directory, open \'missing.ts\'');
  s.type('/tools\r');
  expect(s.frame()).toBe(closed);
});

test('/help, /generations and /plain open over the transcript and any key closes them; an unknown command is not sent', () => {
  const s = stage(90, 30);
  settled(s);
  s.journal({ type: 'generation.promoted', commit: B, previous: A }, 1000, B);
  s.journal({ type: 'generation.started', commit: B }, 1100, B);
  s.journal({ type: 'generation.ready', commit: B }, 1400, B);
  s.journal({ type: 'assistant', text: 'In the new body.', toolCalls: [] }, 3000, B);
  s.clock.at = 4000;
  const before = s.frame();

  s.type('/help\r');
  const help = s.frame();
  expectFrame('help-90x30', help);
  for (const command of ['/quit', '/generations', '/tools', '/mouse', '/plain', '/help']) expect(help).toContain(`    ${command}`);
  expect(help).toContain('ended with a question mark');
  expect(rows(help).at(-1)).toBe(' Esc closes · Up/Down scroll');
  expect(s.term.vt.cursorVisible).toBe(false);
  s.type('\x1b');
  expect(s.frame()).toBe(before);
  expect(s.term.vt.cursorVisible).toBe(true);

  s.type('/generations\r');
  const list = s.frame();
  expect(list).toContain('  generations, oldest first');
  expect(list).toMatch(/ {4}a1b2c3d4a1b2 {2}ready 2027-\S+ +1 reply\n {2}\* e5f6a7b8e5f6 {2}ready 2027-\S+ +1 reply {2}current/);
  s.type('q');
  expect(s.frame()).toBe(before);

  s.type('/plain\r');
  expect(s.frame()).toContain('./box talk --plain');
  s.type(' ');
  s.type('/nonsense\r');
  expect(s.frame()).toContain('/nonsense is not a command here, and was not sent. /help lists them.');
  // A line that merely starts with a slash is the owner's words.
  s.type('/teneral/body is where you live\r');
  expect(readdirSync(s.p.owner).map((name) => readFileSync(join(s.p.owner, name), 'utf8'))).toEqual(['/teneral/body is where you live']);
});

test('the mouse is the terminal\'s at first, so text can be selected and copied; /mouse takes the wheel and gives it back', () => {
  const s = stage(80, 20);
  settled(s);
  s.frame();
  expect(s.term.vt.modes.has(1000)).toBe(false);
  expect(s.term.vt.modes.has(1006)).toBe(false);
  s.type('/mouse\r');
  expect(s.term.vt.modes.has(1000)).toBe(true);
  expect(s.frame()).toContain('The mouse wheel scrolls here again');
  s.type('/mouse\r');
  expect(s.term.vt.modes.has(1000)).toBe(false);
  expect(s.term.vt.modes.has(1006)).toBe(false);
  expect(s.frame()).toContain('The mouse is the terminal\'s again');
});

// --- the terminal's limits ---

test('NO_COLOR: full screen, and not one colour code; weight and slant remain', () => {
  const s = stage(80, 24, { caps: { depth: 'none' } });
  settled(s);
  s.journal({ type: 'stimulus', source: 'terminal', text: 'hello' }, 0);
  s.journal({ type: 'assistant', text: '# Head\n\n**bold** and `code`', toolCalls: [{ id: 'c1', name: 'bash', args: {} }] }, 1000);
  s.journal({ type: 'tool.intent', callId: 'c1', name: 'bash', args: {} }, 1100);
  s.journal({ type: 'molt.rejected', commit: B, gate: 'tests', output: 'no' }, 2000);
  s.clock.at = 3000;
  const frame = s.frame();
  expect(s.term.vt.alt).toBe(true);
  expect(frame).toContain('  Head');
  const styles = sequences(s.term.written).filter((sequence) => sequence.endsWith('m'));
  expect(styles.length).toBeGreaterThan(5);
  for (const style of styles) expect(style).toMatch(/^\x1b\[[0-4](;[1-4])*m$/);
});

test('with 256 or 16 colours the same screen is drawn with the colours there are', () => {
  for (const [depth, pattern] of [['256', /^\x1b\[(?:[0-4];)*(?:38;5;\d+)?m$|^\x1b\[[0-4](?:;[1-4])*m$/], ['16', /^\x1b\[(?:\d{1,2})(?:;\d{1,2})*m$/]] as const) {
    const s = stage(80, 24, { caps: { depth } });
    settled(s);
    s.journal({ type: 'stimulus', source: 'terminal', text: 'hello' }, 0);
    s.clock.at = 1000;
    s.frame();
    const styles = sequences(s.term.written).filter((sequence) => sequence.endsWith('m'));
    expect(styles.length).toBeGreaterThan(5);
    for (const style of styles) expect(style).toMatch(pattern);
    expect(styles.some((style) => style.includes('38;2;'))).toBe(false);
  }
});

test('a locale that is not UTF-8 gets the same screen in ASCII', () => {
  const s = stage(80, 24, { caps: { utf8: false } });
  waking(s);
  s.journal({ type: 'tool.result', callId: 'c4', ok: true, output: 'ok' }, 9900);
  s.journal({ type: 'assistant', text: '- one\n- two\n\n> quoted\n\n```\ncode\n```\n\n---', toolCalls: [] }, 12_000);
  s.journal({ type: 'generation.promoted', commit: B, previous: A }, 13_000, B);
  s.clock.at = 14_000;
  const frame = s.frame();
  expectFrame('ascii-locale-80x24', frame);
  expect(frame).toMatch(/^[\x20-\x7e\n]*$/);
  expect(frame).toContain('-- promoted  a1b2c3d -> e5f6a7b ---');
  expect(frame).toMatch(/^ {2}[|/\\-] thinking \| 0:01$/m);
});

// --- cost ---

test('only the rows that changed are written, and nothing at all when nothing did', () => {
  const s = stage(100, 30);
  settled(s);
  s.clock.at = 1000;
  s.frame();
  const moves = (from: number): number => (s.term.written.slice(from).join('').match(/\x1b\[\d+;1H/g) ?? []).length;

  let mark = s.term.written.length;
  s.frame();
  s.frame();
  expect(s.term.written.length).toBe(mark);

  // One key: the input row is written, and the cursor moved. One write.
  s.type('h');
  expect(s.term.written.length).toBe(mark + 1);
  expect(moves(mark)).toBe(1);

  // A reply arrives: the rows it scrolls through, at most the transcript's height; again one write.
  mark = s.term.written.length;
  s.journal({ type: 'assistant', text: 'One more line.', toolCalls: [] }, 2000);
  s.frame();
  expect(s.term.written.length).toBe(mark + 1);
  expect(moves(mark)).toBeLessThanOrEqual(26);
  expect(moves(mark)).toBeGreaterThan(0);
  expect(s.term.written.at(-1)!.startsWith('\x1b[?2026h')).toBe(true);
  expect(s.term.written.at(-1)!.endsWith('\x1b[?2026l')).toBe(true);

  // While a turn runs, a tick repaints the activity row only.
  s.journal({ type: 'stimulus', source: 'terminal', text: 'go' }, 3000);
  s.clock.at = 3100;
  s.frame();
  mark = s.term.written.length;
  s.clock.at = 3100 + 130;
  s.frame();
  expect(s.term.written.length).toBe(mark + 1);
  expect(moves(mark)).toBe(1);
});

test('a long life: the entries kept and the cost of a frame are bounded by the screen, not by the journal', () => {
  const s = stage(100, 30, { open: false });
  s.journal({ type: 'generation.started', commit: A }, -900_000);
  s.journal({ type: 'generation.ready', commit: A }, -899_000);
  s.journal({ type: 'stimulus', source: 'birth', text: 'Hello.' }, -898_000);
  s.journal({ type: 'assistant', text: 'First words, long ago.', toolCalls: [] }, -897_000);
  s.journal({ type: 'generation.promoted', commit: B, previous: A }, -800_000, B);
  s.journal({ type: 'generation.started', commit: B }, -799_000, B);
  s.journal({ type: 'generation.promoted', commit: C, previous: B }, -700_000, C);
  s.journal({ type: 'generation.started', commit: C }, -699_000, C);
  // Far more than the screen reads back on attaching.
  const filler = 'x'.repeat(900);
  for (let i = 0; i < 600; i++) {
    s.journal({ type: 'stimulus', source: 'clock', text: `tick ${i}` }, -600_000 + i * 100, C);
    s.journal({ type: 'assistant', text: `old reply ${i} ${filler}`, toolCalls: [] }, -600_000 + i * 100 + 50, C);
  }
  s.app.open();
  s.clock.at = 0;
  const frame = s.frame();
  // The generations and the first words are known though they are outside what was read back.
  expect(header(frame)).toMatch(/generation 3 · 0c9d8e7 · gpt-6\.1-sol +resting$/);
  expect(lineage(s.p.journal, 4096 * 1024)).toMatchObject({ spoke: true, known: [A, B, C], current: C });
  expect(frame).toContain('old reply 599');
  expect(frame).not.toMatch(/^ {2}─+$/m);

  // All the way up: where the history begins, it says where the rest is.
  for (let i = 0; i < 400; i++) s.type('\x1b[5~');
  expect(s.frame()).toContain('  Older history is in the journal: memory/journal.jsonl');
  s.type('\x1b[F');

  // Thousands of events later the screen holds a bounded number of entries, and a frame costs what a screen costs.
  for (let i = 0; i < ENTRY_LIMIT + 300; i++) s.journal({ type: 'stimulus', source: 'clock', text: `late tick ${i}` }, 1000 + i, C);
  s.journal({ type: 'assistant', text: 'Still here.', toolCalls: [] }, 9000, C);
  s.clock.at = 10_000;
  const mark = s.term.written.length;
  const started = performance.now();
  const after = s.frame();
  const took = performance.now() - started;
  expect(after).toContain('Still here.');
  const { entries } = (s.app as unknown as { transcript: { entries: unknown[] } }).transcript;
  expect(entries.length).toBeLessThanOrEqual(ENTRY_LIMIT);
  expect(s.term.written.slice(mark).join('').length).toBeLessThan(100 * 30 * 12);
  expect(took).toBeLessThan(2000);
  const again = performance.now();
  s.type('x');
  s.frame();
  expect(performance.now() - again).toBeLessThan(200);
});

test('an event caught half-written is shown whole once it is whole, and never in part', () => {
  const s = stage(80, 20);
  settled(s);
  s.clock.at = 1000;
  s.frame();
  const whole = JSON.stringify({ type: 'assistant', text: 'A reply written in two goes.', toolCalls: [], v: 1, id: 'torn', ts: new Date().toISOString(), gen: A });
  appendFileSync(s.p.journal, whole.slice(0, 40));
  expect(s.frame()).not.toContain('A reply');
  appendFileSync(s.p.journal, `${whole.slice(40)}\n`);
  expect(s.frame()).toContain('  A reply written in two goes.');
  expect(s.frame().match(/A reply written in two goes\./g)).toHaveLength(1);
});

test('attaching to an agent that has never run shows an empty conversation and says so', () => {
  const s = stage(80, 20);
  s.alive.supervisor = false;
  s.alive.body = false;
  const frame = s.frame();
  expectFrame('never-started-80x20', frame);
  expect(header(frame)).toBe(' teneral   gpt-6.1-sol                                              not running');
  expect(frame).toContain('  Nothing has been said yet.');
  // Once something is said, that note is no longer true and goes.
  s.alive.supervisor = true;
  s.journal({ type: 'generation.started', commit: A }, 0);
  expect(s.frame()).not.toContain('Nothing has been said yet.');
});

test('the command line knows --plain and --wait, and refuses anything else before it touches anything', () => {
  const run = Bun.spawnSync([process.execPath, join(import.meta.dir, '..', '..', '..', 'kernel', 'talk.ts'), '--plain', '--nonsense'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  expect(run.exitCode).toBe(2);
  expect(run.stdout.toString()).toBe('');
  expect(run.stderr.toString()).toContain('usage: bun kernel/talk.ts [--plain] [--wait <seconds>]');
  expect(run.stderr.toString()).not.toContain('\x1b');
  expect(Bun.spawnSync([process.execPath, join(import.meta.dir, '..', '..', '..', 'kernel', 'talk.ts'), '--wait', 'soon'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(2);
});
