import { acceptedLine } from '../../../kernel/owner';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OWNER_REASON } from '../../../kernel/back';
import { git } from '../../../kernel/gates';
import type { EventBody } from '../../../kernel/journal';
import { readEvents } from '../../../kernel/journal';
import { IMAGE_MAX_BYTES } from '../../../kernel/tui/images';
import { ENTRY_LIMIT } from '../../../kernel/tui/model';
import { ago, lineage } from '../../../kernel/tui/talk';
import { commitAll, writeFiles } from '../helpers';
import { gif, jpeg, png } from './pictures';
import { A, B, C, T0, expectFrame, stage, type Stage } from './stage';
import { sequences } from './vt';

const PASTE = (text: string): string => `\x1b[200~${text}\x1b[201~`;
const rows = (frame: string): string[] => frame.split('\n');
const SPIN = '[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]';
/** The row of the input box the owner types on, without its frame. */
const typed = (s: Stage): string[] => rows(s.live()).filter((row) => row.startsWith('│')).map((row) => row.slice(2, -1).trimEnd());
const sentFiles = (s: Stage): string[] => (existsSync(s.p.owner) ? readdirSync(s.p.owner) : []).filter((name) => !name.startsWith('.')).map((name) => readFileSync(join(s.p.owner, name), 'utf8'));
/** An event with fields the journal's own type does not have yet. */
const more = (body: object): EventBody => body as EventBody;

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

I have read all of myself: ten files in \`body/\`, about 1,400 lines. I can read and write files, run a shell, and ask the kernel to accept a mutation of my body. I cannot change the kernel, and I cannot see anything outside this directory.

What surprised me: my memory is a single file, and I am allowed to read all of it.

What may I call you?`;

/** A life already under way, at rest. */
function settled(s: Stage): void {
  s.journal({ type: 'generation.started', commit: A }, -60_000);
  s.journal({ type: 'generation.ready', commit: A }, -59_000);
  s.journal({ type: 'stimulus', source: 'birth', text: 'Hello.' }, -58_000);
  s.journal({ type: 'assistant', text: 'Hello. I am here.', toolCalls: [] }, -50_000);
}

// --- attaching ---

test('start: the welcome panel with the mark and the facts, where things stand, then the recent history, and the input box under it all', () => {
  const s = stage(100, 40, { open: false, banner: 'Using ChatGPT plan. Manage usage: https://chatgpt.com/settings/usage', helper: 'xclip', name: 'Mica', env: { TENERAL_PROVIDER: 'chatgpt', TENERAL_HEARTBEAT_MINUTES: '20' } });
  writeFileSync(s.p.peers, JSON.stringify({ alice: '/srv/alice/inbox', bob: '/srv/bob/inbox' }));
  settled(s);
  s.journal({ type: 'generation.promoted', commit: B, previous: A }, -45_000, B);
  s.journal({ type: 'generation.started', commit: B }, -44_900, B);
  s.journal({ type: 'generation.ready', commit: B }, -44_500, B);
  s.journal({ type: 'stimulus', source: 'terminal', text: 'what is in body/?' }, -40_000, B);
  s.journal({ type: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'ls body' } }] }, -39_000, B);
  s.journal({ type: 'tool.intent', callId: 'c1', name: 'bash', args: { command: 'ls body' } }, -38_900, B);
  s.journal({ type: 'tool.result', callId: 'c1', ok: true, output: 'context.ts\nloop.ts' }, -38_700, B);
  s.journal({ type: 'assistant', text: 'Ten files, about **1,400** lines:\n\n- `main.ts` starts me\n- `loop.ts` is one turn\n\nShall I go through them?', toolCalls: [] }, -36_000, B);
  s.app.open();
  const all = s.all();
  expectFrame('start-100x40', all);
  // The panel: a round frame across the width, the mark, the name from the soul's own file, and the facts.
  expect(rows(all)[0]).toBe(`╭${'─'.repeat(97)}╮`);
  expect(all).toContain('│   ▚▖  ▗▞   Talking with Mica');
  expect(all).toContain('│    ▜██▛    Type to talk, Enter sends. /help lists the keys and commands.');
  expect(all).toMatch(/│ {3}Directory {4}\/home\/owner\/work\/teneral +│/);
  expect(all).toMatch(/│ {3}Individual {3}5e1f0a9c +│/);
  expect(all).toMatch(/│ {3}Generation {3}2nd · e5f6a7b · has lived in 2 +│/);
  expect(all).toMatch(/│ {3}Model {8}gpt-6\.1-sol · ChatGPT plan +│/);
  expect(all).toMatch(/│ {3}Version {6}teneral \d+\.\d+\.\d+ +│/);
  expect(all).toMatch(/│ {3}Born {9}2027-01-15 07:59 UTC · 1 min ago +│/);
  expect(all).toMatch(/│ {3}Sensors {6}clock every 20 min · inbox · your terminal +│/);
  expect(all).toMatch(/│ {3}Peers {8}alice, bob +│/);
  // Under it: where things stand, the plan in use with its address, and how images get in.
  expect(all).toContain('◆ Mica is awake · waiting for you\n  Leaving this client stops nothing: Mica goes on.\n\n◆ Using ChatGPT plan. Manage usage: https://chatgpt.com/settings/usage\n◆ Images: Ctrl+V attaches the clipboard\'s image; drag a file in, or /image <path>.');
  // Then the history, each kind with its own mark, and the live region last.
  expect(all).toContain('┃ mutation accepted  a1b2c3d → e5f6a7b\n\n› what is in body/?\n\n  ▪ bash  command: ls body');
  expect(all).toContain('● Ten files, about 1,400 lines:\n\n  • main.ts starts me\n  • loop.ts is one turn\n\n  Shall I go through them?');
  expect(rows(s.live())).toEqual([
    '',
    `╭${'─'.repeat(97)}╮`,
    `│ ›${' '.repeat(95)}│`,
    `╰${'─'.repeat(97)}╯`,
    expect.stringMatching(/^ gpt-6\.1-sol  waiting for you  …\/work\/teneral  gen 2 e5f6a7b( {3,}\S.*)?$/),
  ]);
  // The terminal's own cursor is hidden at the top of the live region; the one the owner sees is drawn in the box.
  expect(s.term.vt.cursorVisible).toBe(false);
  expect(s.term.vt.block).toEqual({ row: s.term.vt.cursor.row + 2, col: 4 });
  expect(s.term.vt.alt).toBe(false);
  expect(s.term.vt.modes.has(1000) || s.term.vt.modes.has(1006)).toBe(false);
});

test('only the last few exchanges are shown on attaching; the status says so, and /history prints the rest that was read', () => {
  const s = stage(80, 30, { open: false });
  settled(s);
  for (let i = 1; i <= 9; i++) {
    s.journal({ type: 'stimulus', source: 'terminal', text: `question ${i}` }, -40_000 + i * 1000);
    s.journal({ type: 'assistant', text: `answer ${i}`, toolCalls: [] }, -40_000 + i * 1000 + 500);
  }
  s.app.open();
  const all = s.all();
  expect(all).toContain('◆ Showing the last of the conversation. /history prints what came before;\n  memory/journal.jsonl has all of it.');
  expect(all).not.toContain('question 6');
  expect(all).toContain('› question 7\n\n● answer 7\n\n› question 8\n\n● answer 8\n\n› question 9\n\n● answer 9');
  // Up brings back what was sent before, also from before what is shown.
  s.type('\x1b[A\x1b[A\x1b[A\x1b[A');
  expect(typed(s)).toEqual(['› question 6']);
  s.type('\x15/history\r');
  const after = s.all();
  expect(after).toMatch(/ {2}── earlier, from the journal ─+\n {2}The 14 entries before what was shown when you attached\.\n\n {2}◦ the birth letter/);
  expect(after).toContain('› question 6\n\n● answer 6\n\n  ── back to now ─');
  expect(after.match(/answer 3/g)).toHaveLength(1);
  s.type('/history\r');
  expect(s.all().replace(/\n {2}/g, ' ')).toContain(' Nothing earlier was read from the journal. memory/journal.jsonl has all of it.');
});

// --- the first start ---

test('first start: while the agent reads itself, each finished tool call is printed and the one still running waits over the input, with what the agent is doing', () => {
  const s = stage(100, 34, { open: false });
  waking(s);
  s.clock.at = 9200;
  s.app.open();
  const all = s.all();
  expectFrame('first-start-waking-100x34', all);
  expect(all).toContain('◆ The agent is awake · waking');
  expect(all).toContain('  ◦ the birth letter');
  expect(all).not.toContain('You have just woken');
  expect(all).toMatch(/▪ read {2}path: body\/main\.ts +✓ 40ms\n {2}▪ read {2}path: body\/loop\.ts +✓ 30ms/);
  // The call without a result is not printed yet: it is in the live region, which is redrawn.
  expect(s.live()).toMatch(new RegExp(`^\\n {2}▪ bash {2}command: wc -l body/\\*\\.ts && cat BACKLOG\\.md \\| head -50 +running\\n\\n${SPIN} The agent is waking · running bash · 0:08 · esc to interrupt\\n╭`));
  // The clock moves, and so does the spinner; nothing else does.
  const printed = s.term.vt.scrollback.length + s.term.vt.cursor.row;
  s.clock.at = 71_000;
  expect(s.live()).toContain('The agent is waking · running bash · 1:10');
  expect(s.term.vt.scrollback.length + s.term.vt.cursor.row).toBe(printed);
});

test('first words: they arrive under a rule of their own, once, and the footer says the agent waits for an answer', () => {
  const s = stage(100, 34, { open: false });
  waking(s);
  s.clock.at = 9200;
  s.app.open();
  s.frame();
  s.journal({ type: 'tool.result', callId: 'c4', ok: true, output: '1400 total\n# Backlog\n' }, 9900);
  s.journal({ type: 'assistant', text: FIRST_WORDS, toolCalls: [] }, 14_000);
  s.clock.at = 14_100;
  const all = s.all();
  expectFrame('first-words-100x34', all);
  expect(all).toMatch(/▪ bash {2}command: wc -l body\/\*\.ts && cat BACKLOG\.md \| head -50 +✓ 1\.9s\n\n {2}─{24}\n\n● Hello\.\n/);
  expect(s.live()).toMatch(/\n gpt-6\.1-sol  waiting for you  /);
  expect(s.live()).not.toMatch(new RegExp(SPIN));
  // The rule is for the first words only.
  s.say('Anton', 20_000);
  s.journal({ type: 'assistant', text: 'Thank you, Anton.', toolCalls: [] }, 22_000);
  s.clock.at = 22_100;
  expect(rows(s.all()).filter((row) => /^ {2}─+$/.test(row))).toHaveLength(1);
  expect(s.all()).toContain('› Anton\n\n● Thank you, Anton.');
});

// --- replies ---

const LONG_REPLY = `# Что я нашёл

Я прочитал **всё** своё тело и вот что *важно*:

- память — это один файл, \`memory/journal.jsonl\`, и он только растёт, так что со временем я не смогу держать его в голове целиком
- у меня есть шесть инструментов
  1. \`read\`, \`write\`, \`edit\`
  2. \`bash\`, \`mutate\`, \`send\`

\`\`\`ts
export async function runTurn(d: TurnDeps): Promise<'done' | 'mutation'> { // эта строка слишком длинная, чтобы поместиться
\tconst events = readEvents(d.journal);
}
\`\`\`

> «Кто ясно мыслит, тот ясно излагает» 🙂

Подробнее: [документация](https://example.com/docs/память) и 日本語のテキストも正しく折り返されます、幅は二倍です。

---

Как мне тебя называть?`;

test('a long reply, taller than the screen: all of it goes into the scrollback in order, markdown laid out, and the input box is whole under its end', () => {
  const s = stage(80, 16);
  settled(s);
  s.say('расскажи, что ты нашёл', 0);
  s.journal({ type: 'assistant', text: `${LONG_REPLY}\n\n${Array.from({ length: 30 }, (_, i) => `Строка ${i + 1}.`).join('\n')}`, toolCalls: [] }, 4000);
  s.clock.at = 5000;
  const all = s.all();
  expectFrame('long-reply-cyrillic-80x16', all);
  expect(s.term.vt.scrollback.length).toBeGreaterThan(50);
  expect(all).toContain('› расскажи, что ты нашёл\n\n● Что я нашёл\n\n  Я прочитал всё своё тело и вот что важно:');
  expect(all).toMatch(/ {2}• память — это один файл, memory\/journal\.jsonl, и он только растёт, так что\n {4}со временем/);
  expect(all).toContain('    1. read, write, edit');
  // Code is cut at the edge and marked, never wrapped; its tab is four columns.
  expect(all).toMatch(/ {2}│ export async function runTurn\(d: TurnDeps\): Promise<'done' \| 'mutation'> \{…\n {2}│ {5}const events/);
  expect(all).toContain('  │ «Кто ясно мыслит, тот ясно излагает» 🙂');
  expect(all).toContain('документация (https://example.com/docs/память)');
  expect(all).not.toMatch(/\*\*|```|^ {2}#/m);
  // Every row of the reply is there once, the last of them right over the live region.
  for (let i = 1; i <= 30; i++) expect(all.match(new RegExp(`^ {2}Строка ${i}\\.$`, 'gm'))).toHaveLength(1);
  expect(s.frame()).toMatch(/ {2}Строка 30\.\n\n╭─+╮\n│ › +│\n╰─+╯\n gpt-6\.1-sol  resting/);
  // No row reaches the last column, wide characters counted as two.
  expect(rows(all).every((row) => [...row].length <= 79)).toBe(true);
});

// --- a turn ---

test('a turn in progress: the owner\'s line waits until the journal has it, a tool call until its result, and each is printed once when it is final', () => {
  const s = stage(90, 30, { name: 'Mica' });
  settled(s);
  s.clock.at = 1000;
  s.frame();
  const before = s.all();
  s.type('look around\r');
  // Sent, not yet taken: it is in the live region, marked, and nothing new is in the scrollback.
  expect(sentFiles(s)).toEqual(['look around']);
  expect(s.live()).toMatch(/^\n› look around {2}on its way\n\n╭/);
  expect(s.all().startsWith(before.slice(0, before.lastIndexOf('\n╭')))).toBe(true);
  s.journal({ type: 'stimulus', source: 'terminal', text: 'look around' }, 1500);
  s.journal({ type: 'assistant', text: 'I will look.', toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'ls' } }] }, 2000);
  s.journal({ type: 'tool.intent', callId: 'c1', name: 'bash', args: { command: 'ls -la' } }, 2100);
  s.clock.at = 4000;
  const during = s.all();
  expectFrame('turn-in-progress-90x30', during);
  // The line and the words before the call are final and printed; the call is live, with the activity line.
  expect(during).toContain('› look around\n\n● I will look.\n\n  ▪ bash  command: ls -la');
  expect(s.live()).toMatch(new RegExp(`^\\n {2}▪ bash {2}command: ls -la +running\\n\\n${SPIN} Mica is running bash · 0:02 · esc to interrupt\\n╭`));
  expect(during).not.toContain('on its way');
  // Something said meanwhile waits under the call that is still running. The owner's line is kept by this client: nothing is sent yet.
  s.type('and thn?\r');
  s.journal({ type: 'stimulus', source: 'clock', text: 'tick' }, 4500);
  expect(s.live()).toMatch(/running\n\n {2}◦ clock {2}tick\n\n› and thn\?\n\n/);
  expect(s.live()).toContain('1 queued · Up takes the last back');
  expect(sentFiles(s)).toEqual(['look around']);
  // Up in the empty box takes it back to be put right; Enter queues it again.
  s.type('\x1b[A');
  expect(s.live()).not.toContain('queued');
  expect(s.live()).not.toMatch(/^› and thn\?$/m);
  expect(s.live()).toContain('│ › and thn?');
  s.type('\x7f\x7fen?\r');
  expect(s.live()).toMatch(/^› and then\?\n\n/m);
  expect(s.live()).toContain('1 queued');
  expect(sentFiles(s)).toEqual(['look around']);
  // The result arrives: the call is printed with its outcome, and the step being over, the line goes out.
  s.journal({ type: 'tool.result', callId: 'c1', ok: true, output: 'a\nb' }, 5300);
  expect(s.live()).toMatch(/› and then\? {2}on its way\n\n/);
  expect(sentFiles(s).sort()).toEqual(['and then?', 'look around']);
  s.journal({ type: 'stimulus', source: 'terminal', text: 'and then?' }, 5400);
  // Journaled, but the request under way was sent before it: it stays over the box, queued.
  expect(s.live()).toMatch(/^\n› and then\? {2}sent, not read yet\n\n/);
  expect(s.all()).not.toContain('on its way');
  s.journal({ type: 'assistant', text: 'Two files.', toolCalls: [] }, 9000);
  // The reply written without it is printed first; the line follows it, read now.
  expect(s.live()).not.toContain('not read yet');
  s.journal({ type: 'assistant', text: 'And then nothing.', toolCalls: [] }, 12_000);
  s.clock.at = 12_100;
  const done = s.all();
  expect(done).toMatch(/● I will look\.\n\n {2}▪ bash {2}command: ls -la +✓ 3\.2s\n\n {2}◦ clock {2}tick\n\n● Two files\.\n\n› and then\?\n\n● And then nothing\.\n\n╭/);
  expect(done.match(/▪ bash/g)).toHaveLength(1);
  expect(done.match(/and then\?/g)).toHaveLength(1);
  expect(done).not.toMatch(/running|on its way|queued|not read yet/);
  expect(s.live()).toMatch(/^\n╭─+╮\n│ › +│\n╰─+╯\n gpt-6\.1-sol  resting/);
});

test('reasoning and context use are shown when the body journals them, and nothing stands in their place when it does not', () => {
  const s = stage(100, 30, { env: { TENERAL_PROVIDER: 'openai', TENERAL_REASONING_EFFORT: 'high' } });
  settled(s);
  s.say('what is in body/?', 0);
  s.journal({ type: 'assistant', text: 'Ten files.', toolCalls: [] }, 2000);
  s.clock.at = 3000;
  const without = s.all();
  expect(without).not.toMatch(/○|context/);
  expect(rows(s.live())).toHaveLength(5);

  s.say('and how many lines?', 4000);
  s.journal(more({ type: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'bash', args: {} }], reasoning: 'The owner wants a count. I should not guess: `wc -l` gives it exactly.\n\nThen report the total only.', usage: { input: 70_200, output: 1700, cached: 64_000 } }), 5000);
  s.journal({ type: 'tool.intent', callId: 'c1', name: 'bash', args: { command: 'wc -l body/*.ts' } }, 5100);
  s.journal({ type: 'tool.result', callId: 'c1', ok: true, output: '1400 total' }, 5300);
  s.journal(more({ type: 'assistant', text: 'About 1,400.', toolCalls: [], reasoning: 'Report the total.', usage: { input: 90_000, output: 300 } }), 7000);
  s.clock.at = 8000;
  const all = s.all();
  expectFrame('reasoning-and-context-100x30', all);
  expect(all).toContain('› and how many lines?\n\n○ The owner wants a count. I should not guess: `wc -l` gives it exactly.\n  Then report the total only.\n\n  ▪ bash  command: wc -l body/*.ts');
  expect(all).toContain('○ Report the total.\n\n● About 1,400.');
  // The newest request's tokens against the model's window, at the right under the tip; the effort beside the model.
  expect(rows(s.live()).at(-1)).toMatch(/ gen 1 a1b2c3d {3,}context 9% \(90\.3k\/1\.05M\)$/);
  expect(rows(s.live()).at(-1)).toMatch(/^ gpt-6\.1-sol  effort high  resting  /);
  // A model whose window is not known: the count alone.
  const other = stage(100, 30, { env: { TENERAL_MODEL: 'some-local-model' } });
  settled(other);
  other.journal(more({ type: 'assistant', text: 'Hm.', toolCalls: [], usage: { input: 12_345, output: 55 } }), 0);
  expect(rows(other.live()).at(-1)).toMatch(/ gen 1 a1b2c3d {3,}context 12\.4k$/);
});

// --- resizing ---

test('resize while a turn is under way: the live region is drawn anew at each size and nothing of the old one is left behind, in a terminal that cuts rows and in one that wraps them again', () => {
  for (const reflow of [false, true]) {
    const s = stage(100, 30, { reflow, name: 'Mica' });
    settled(s);
    s.say('посмотри ещё раз', 6000);
    s.journal({ type: 'assistant', text: 'Смотрю.', toolCalls: [{ id: 'c1', name: 'bash', args: {} }] }, 7000);
    s.journal({ type: 'tool.intent', callId: 'c1', name: 'bash', args: { command: 'ls -la body/ | sort' } }, 7100);
    s.clock.at = 9000;
    s.type('half a line');
    s.frame();
    // A terminal that cuts its rows may jump to any size. One that wraps them again is taken through sizes a window passes on its way, each
    // leaving room for the old region wrapped in two (see `liveRows`).
    const sizes = reflow ? [[80, 30], [60, 24], [45, 20], [72, 20], [100, 40], [56, 24], [200, 60], [80, 24]] as const : [[60, 24], [40, 10], [72, 20], [100, 40], [45, 12], [200, 60], [17, 9], [80, 24]] as const;
    for (const [cols, height] of sizes) {
      s.term.resize(cols, height);
      const all = s.term.vt.all();
      if (cols === 60 && !reflow) expectFrame('resized-60x24', all);
      if (cols === 60 && reflow) expectFrame('resized-rewrapped-60x24', all);
      const live = rows(s.live());
      // One box, as wide as the screen now is, with what was typed in it; one activity line; one footer.
      expect(live.length).toBeLessThanOrEqual(Math.max(3, height / 2));
      if (height >= 10) {
        expect(live.filter((row) => row.startsWith('╭'))).toEqual([`╭${'─'.repeat(cols - 3)}╮`]);
        expect(live.filter((row) => row.startsWith('╰'))).toEqual([`╰${'─'.repeat(cols - 3)}╯`]);
        expect(live.filter((row) => row.includes('half a line'))).toEqual([`│ › half a line${' '.repeat(cols - 17)}│`]);
        expect(live.at(-1)).toMatch(/^ gpt-6\.1-sol/);
      }
      if (height >= 20) expect(live.filter((row) => new RegExp(`^${SPIN} Mica is running bash · 0:03 · esc to in`).test(row))).toHaveLength(1);
      // Down to a screen of a few columns there is a row to type on, with the cursor in it.
      expect(live.some((row) => row.startsWith('│') || row.startsWith('›') || row.startsWith(' '))).toBe(true);
      expect(s.term.vt.block).not.toBeNull();
      for (const row of live) expect([...row].length).toBeLessThanOrEqual(cols - 1);
      // Above the live region, from where the conversation begins: nothing that was ever part of one.
      const whole = rows(s.term.vt.all()).slice(0, -live.length);
      const above = whole.slice(whole.findIndex((row) => row.includes('the birth letter')));
      expect(above.length).toBeGreaterThan(6);
      expect(above.filter((row) => /half a line|running|^╭|^╰|^ gpt-6/.test(row))).toEqual([]);
      expect(s.term.vt.all().match(/Смотрю\./g)).toHaveLength(1);
      expect(s.term.vt.cursor.col).toBe(0);
    }
    // And the turn goes on as if nothing had happened.
    s.journal({ type: 'tool.result', callId: 'c1', ok: true, output: 'x' }, 9500);
    s.journal({ type: 'assistant', text: 'Всё на месте.', toolCalls: [] }, 10_000);
    s.clock.at = 10_100;
    expect(s.all()).toMatch(/▪ bash {2}command: ls -la body\/ \| sort +✓ 2\.4s\n\n● Всё на месте\.\n\n╭/);
  }
});

// --- what the kernel did ---

function mutating(s: Stage): void {
  settled(s);
  s.say('go ahead and change yourself', 0);
  s.journal({ type: 'assistant', text: 'I will ask for the mutation now.', toolCalls: [{ id: 'c1', name: 'mutate', args: { motive: 'remember names' } }] }, 2000);
  s.journal({ type: 'tool.intent', callId: 'c1', name: 'mutate', args: { motive: 'remember names' } }, 2100);
  s.journal({ type: 'mutation.requested', commit: B, motive: 'remember names' }, 2200);
  s.journal({ type: 'tool.result', callId: 'c1', ok: true, output: 'mutation requested' }, 2300);
}

test('a mutation accepted: mutating while the kernel checks, then a notice with both commits, and the footer moves to the new generation', () => {
  const s = stage(80, 30);
  mutating(s);
  s.alive.body = false;
  s.clock.at = 30_000;
  expect(s.live()).toMatch(new RegExp(`\\n${SPIN} The agent is mutating · 0:30\\n╭`));
  expect(s.live()).toMatch(/  gen 1 a1b2c3d( {3}|$)/m);
  // The tool line names the tool as it was called.
  expect(s.all()).toMatch(/▪ mutate {2}motive: remember names +✓ 200ms/);

  s.journal({ type: 'generation.promoted', commit: B, previous: A }, 95_000, B);
  s.journal({ type: 'generation.started', commit: B }, 95_100, B);
  s.clock.at = 95_200;
  expect(s.live()).toMatch(/The agent is starting · 1:35\n/);
  expect(s.live()).toMatch(/  gen 2 e5f6a7b( {3}|$)/m);
  s.alive.body = true;
  s.journal({ type: 'generation.ready', commit: B }, 95_600, B);
  s.journal({ type: 'assistant', text: 'I am in the new body. Names stay with me now.', toolCalls: [] }, 99_000, B);
  s.clock.at = 99_100;
  const all = s.all();
  expectFrame('mutation-accepted-80x30', all);
  expect(all).toContain('┃ mutation accepted  a1b2c3d → e5f6a7b\n\n● I am in the new body. Names stay with me now.');
  expect(s.live()).toMatch(/ gpt-6\.1-sol  resting  …\/work\/teneral  gen 2 e5f6a7b/);
});

test('a mutation rejected: the gate by name, and the end of its output as several readable rows behind the notice\'s edge', () => {
  const s = stage(80, 36);
  mutating(s);
  const output = [
    ...Array.from({ length: 40 }, (_, i) => `(pass) test number ${i} [0.${i}ms]`),
    'test/body/loop.test.ts:',
    '(fail) a turn ends when the model stops calling tools [1.20ms]',
    '  error: expect(received).toBe(expected)',
    '  Expected: "done"',
    '  Received: "mutation"',
    '        at <anonymous> (/teneral/.teneral/gate/test/body/loop.test.ts:41:23)',
    '',
    ' 212 pass',
    ' 1 fail',
  ].join('\n');
  s.journal({ type: 'mutation.rejected', commit: B, gate: 'body tests', output }, 60_000);
  s.clock.at = 61_000;
  const all = s.all();
  expectFrame('mutation-rejected-80x36', all);
  expect(all).toContain('\n┃ mutation to e5f6a7b rejected at gate "body tests"\n┃   … 36 earlier rows; the journal has all of it\n');
  expect(all).toContain('┃   (fail) a turn ends when the model stops calling tools [1.20ms]');
  expect(all).toContain('┃     Expected: "done"');
  expect(all).toMatch(/┃ {4}1 fail\n\n/);
  expect(s.live()).toMatch(new RegExp(`^\\n${SPIN} The agent is thinking`));
});

test('a rollback: the reason, then the end of what the generation last printed, where the cause is; sent back by the owner reads differently', () => {
  const s = stage(80, 30);
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
  const all = s.all();
  expectFrame('rolled-back-80x30', all);
  expect(all).toContain('\n┃ rolled back  e5f6a7b → a1b2c3d\n┃   crashed 3 times without a reply. Its stderr ended with:\n');
  expect(all).toContain('┃   [turn failed] TypeError: undefined is not an object (evaluating');
  expect(all).toContain('┃       at runTurn (/teneral/.teneral/live/body/loop.ts:52:15)');
  expect(s.live()).toMatch(/  gen 1 a1b2c3d( {3}|$)/m);

  s.journal({ type: 'generation.rolledback', commit: A, to: B, reason: OWNER_REASON }, 20_000, B);
  expect(s.all()).toContain('\n┃ sent back by you  a1b2c3d → e5f6a7b\n');
});

// --- typing ---

test('multi-line input and paste: the box grows with the text, the cursor is where the text goes, and Enter sends it all as one line of the owner\'s', () => {
  const s = stage(60, 24);
  settled(s);
  s.clock.at = 1000;
  s.type('первая строка');
  s.type('\x1b\r');
  s.type('вторая');
  expect(typed(s)).toEqual(['› первая строка', '  вторая']);
  const top = s.term.vt.cursor.row;
  expect(s.term.vt.block).toEqual({ row: top + 3, col: 10 });

  s.type(PASTE('\nthird, pasted\r\n日本語 fourth\n\tfifth with a tab'));
  expectFrame('multi-line-input-60x24', s.all());
  expect(typed(s)).toEqual(['› первая строка', '  вторая', '  third, pasted', '  日本語 fourth', '      fifth with a tab']);
  expect(s.term.vt.block).toEqual({ row: s.term.vt.cursor.row + 6, col: 24 });
  // Nothing was sent by the line breaks in the paste.
  expect(sentFiles(s)).toEqual([]);

  // Editing in the middle: Home, a word, then up a line and to its end.
  s.type('\x1b[H>> \x1b[A\x1b[F!');
  expect(typed(s).slice(-2)).toEqual(['  日本語 fourth!', '  >>     fifth with a tab']);
  s.type('\x1b[B\x1b[F\x1b\rsixth');
  expect(typed(s)).toHaveLength(6);

  s.type('\r');
  const sentText = 'первая строка\nвторая\nthird, pasted\n日本語 fourth!\n>>     fifth with a tab\nsixth';
  expect(sentFiles(s)).toEqual([sentText]);
  expect(typed(s)).toEqual(['›']);
  expect(s.live()).toContain('  sixth  on its way');
  // Once the journal has it, it is the owner's line like any other, in the scrollback.
  s.journal({ type: 'stimulus', source: 'terminal', text: sentText }, 2000);
  s.clock.at = 2100;
  expect(s.live()).not.toContain('on its way');
  expect(s.all()).toContain('› первая строка\n  вторая\n  third, pasted');
  // Up brings it back to edit and send again.
  s.type('\x1b[A');
  expect(typed(s).at(-1)).toBe('  sixth');
});

test('Ctrl-U, Ctrl-K and Ctrl-W, word jumps, Delete and Backspace work on the line as shown', () => {
  const s = stage(60, 20);
  settled(s);
  const line = (): string => typed(s)[0]!;
  s.type('one two three four');
  s.type('\x17');
  expect(line()).toBe('› one two three');
  s.type('\x1b[1;5D\x1b[1;5D\x0b');
  expect(line()).toBe('› one');
  s.type('TWO\x1b[H\x1b[3~\x1b[3~');
  expect(line()).toBe('› e TWO');
  s.type('\x1b[F\x7f\x7f\x15');
  expect(line()).toBe('›');
  expect(sentFiles(s)).toEqual([]);
});

test('PageUp, PageDown and the mouse are the terminal\'s own: nothing is drawn for them and nothing is typed', () => {
  const s = stage(80, 24);
  settled(s);
  s.frame();
  const count = s.term.written.length;
  s.type('\x1b[5~\x1b[6~\x1b[1;2A\x1b[1;2B\x1b[<64;5;5M\x1b[<0;5;5M\x1b[<0;5;5m');
  s.frame();
  expect(typed(s)).toEqual(['›']);
  expect(s.term.written.slice(count).join('')).not.toMatch(/[A-Za-z]{3}/);
  expect([...s.term.vt.modes].filter((mode) => mode !== 2026)).toEqual([2004]);
  // /mouse is gone with the mode it switched.
  s.type('/mouse\r');
  expect(s.all()).toContain('/mouse is not a command here, and was not sent. /help lists them.');
});

// --- images ---

/** The helper on the owner's machine, for a test: every request waiting is answered with what `answer` gives. Returns the requests. */
function helper(s: Stage, answer: (action: string, path: string) => { first: string; data?: Buffer }): string[] {
  const seen: string[] = [];
  for (const name of readdirSync(s.clip).filter((file) => /^req-\d+$/.test(file)).sort()) {
    const n = name.slice(4);
    const [action = '', path = ''] = readFileSync(join(s.clip, name), 'utf8').split('\n');
    unlinkSync(join(s.clip, name));
    seen.push(`${action} ${path}`.trim());
    const { first, data } = answer(action, path);
    if (data) writeFileSync(join(s.clip, `dat-${n}`), data);
    writeFileSync(join(s.clip, `.rep-${n}.tmp`), `${first}\n`);
    renameSync(join(s.clip, `.rep-${n}.tmp`), join(s.clip, `rep-${n}`));
  }
  return seen;
}
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const stored = (s: Stage): string[] => (existsSync(join(s.p.root, 'memory', 'images')) ? readdirSync(join(s.p.root, 'memory', 'images')).sort() : []);

test('an image attached and sent: Ctrl+V asks the helper for the clipboard, the image becomes a chip in the box and a file named by its content, and the message ends with one line naming it', () => {
  const s = stage(100, 34, { helper: 'xclip', name: 'Mica' });
  settled(s);
  s.clock.at = 1000;
  s.type('what is wrong in this screenshot?');
  s.type('\x16');
  // Asked, not answered: the footer says what is being waited for; nothing is typed into the line.
  expect(rows(s.live()).at(-1)).toMatch(/ asking your machine for the clipboard's image …$/);
  expect(typed(s)).toEqual(['› what is wrong in this screenshot?']);
  const shot = png(1280, 720, 245_000);
  expect(helper(s, () => ({ first: 'ok', data: shot }))).toEqual(['clipboard']);
  const live = s.live();
  expect(typed(s)).toEqual([`[image 1 · png · 1280×720 · ${Math.round(shot.length / 1024)} KB]`, '› what is wrong in this screenshot?']);
  expect(rows(live).at(-1)).toMatch(/ attached: image 1 · Backspace at the start removes the last$/);
  expect(stored(s)).toEqual([`${sha(shot)}.png`]);
  expect(readFileSync(join(s.p.root, 'memory', 'images', `${sha(shot)}.png`)).equals(shot)).toBe(true);
  expectFrame('image-attached-100x34', s.all());

  s.type('\r');
  const message = `what is wrong in this screenshot?\n[image: memory/images/${sha(shot)}.png]`;
  expect(sentFiles(s)).toEqual([message]);
  expect(typed(s)).toEqual(['›']);
  // In the transcript the line is a chip, not the marker: while it waits, and once the journal has it.
  expect(s.live()).toMatch(/› what is wrong in this screenshot\?\n {2}\[image 1 · png · 1280×720 · 239 KB\] {2}on its way/);
  for (const name of readdirSync(s.p.owner)) if (!name.startsWith('.')) unlinkSync(join(s.p.owner, name));
  s.journal({ type: 'stimulus', source: 'terminal', text: message }, 2000);
  s.journal({ type: 'assistant', text: 'The button is cut off at the right edge.', toolCalls: [] }, 5000);
  s.clock.at = 5100;
  const all = s.all();
  expectFrame('image-sent-100x34', all);
  expect(all).toContain('› what is wrong in this screenshot?\n  [image 1 · png · 1280×720 · 239 KB]\n\n● The button is cut off at the right edge.');
  expect(all).not.toContain('[image: memory');
  // Another client's message with an image reads the same; one whose file is gone says so.
  s.journal({ type: 'stimulus', source: 'terminal', text: `[image: memory/images/${sha(shot)}.png]\n[image: memory/images/${'0'.repeat(64)}.gif]` }, 6000);
  expect(s.all()).toContain('› [image 1 · png · 1280×720 · 239 KB]  [image 2 · gif · not in memory/images]\n  from another terminal');
});

test('a file dragged in, pasted as its path or named with /image becomes a chip through the helper; a path that is no picture stays the text it is', () => {
  const s = stage(100, 30, { helper: 'wl-paste' });
  settled(s);
  s.clock.at = 1000;
  const photo = jpeg(4032, 3024);
  const anim = gif(320, 200);
  const files: Record<string, Buffer> = { '/home/owner/My Pictures/photo 1.jpg': photo, '/home/owner/anim.gif': anim };
  const answer = (_: string, path: string) => {
    const home = path.replace(/^~\//, '/home/owner/');
    if (home === '/home/owner/notes.txt' || home === '/home/owner/fake.png') return { first: 'error not-image' };
    return files[home] ? { first: 'ok', data: files[home] } : { first: 'error not-found' };
  };
  // Dragged: the terminal pastes the path, quoted, with a space after it.
  s.type(PASTE('\'/home/owner/My Pictures/photo 1.jpg\' '));
  expect(typed(s)).toEqual(['›']);
  expect(rows(s.live()).at(-1)).toMatch(/ asking your machine for the file …$/);
  expect(helper(s, answer)).toEqual(['file /home/owner/My Pictures/photo 1.jpg']);
  expect(typed(s)).toEqual([`[image 1 · jpg · 4032×3024 · ${photo.length} B]`, '›']);
  // A file address, as some terminals paste it; and /image with a path from the home directory.
  s.type(PASTE('file:///home/owner/anim.gif'));
  helper(s, answer);
  s.type('/image ~/anim.gif\r');
  expect(helper(s, answer)).toEqual(['file ~/anim.gif']);
  expect(typed(s)).toEqual([`[image 1 · jpg · 4032×3024 · ${photo.length} B]  [image 2 · gif · 320×200 · ${anim.length} B]`, '›']);
  expect(s.all()).toContain('  That image is attached already.');
  expect(stored(s)).toEqual([`${sha(anim)}.gif`, `${sha(photo)}.jpg`].sort());

  // A path that is not a picture: pasted, it is text, and nothing is said. Named like a picture and not one, or not there: said, and left as text.
  s.type(PASTE('/home/owner/notes.txt'));
  helper(s, answer);
  expect(typed(s).at(-1)).toBe('› /home/owner/notes.txt');
  s.type('\x15');
  s.type(PASTE('/home/owner/fake.png'));
  helper(s, answer);
  expect(typed(s).at(-1)).toBe('› /home/owner/fake.png');
  expect(s.all()).toContain('  /home/owner/fake.png is not a PNG, JPEG, GIF or WebP image, so it was not attached.');
  s.type('\x15/image /home/owner/missing.png\r');
  helper(s, answer);
  expect(s.all()).toContain('  No such file on your machine: /home/owner/missing.png');
  // A paste that only mentions a path is text and is never asked about.
  s.type(PASTE('see /home/owner/anim.gif please'));
  expect(helper(s, answer)).toEqual([]);
  expect(typed(s).at(-1)).toBe('› see /home/owner/anim.gif please');

  // Backspace at the start of the text takes the last chip; the text is untouched.
  s.type('\x1b[H\x7f');
  expect(typed(s)).toEqual([`[image 1 · jpg · 4032×3024 · ${photo.length} B]`, '› see /home/owner/anim.gif please']);
  s.type('\x7f');
  expect(typed(s)).toEqual(['› see /home/owner/anim.gif please']);
  expect(rows(s.live()).some((row) => row.includes('attached'))).toBe(false);
});

test('a line that is a path and nothing else, sent with Enter: an image is attached instead of sent; anything else is sent as the words it is', () => {
  const s = stage(100, 30, { helper: 'xclip' });
  settled(s);
  s.clock.at = 1000;
  const shot = png(800, 600);
  const answer = (_: string, path: string) => (path === '/tmp/shot.png' ? { first: 'ok', data: shot } : path === '/etc/hosts' ? { first: 'error not-image' } : { first: 'error not-found' });
  s.type('/tmp/shot.png\r');
  // While it is looked up, what is typed waits.
  s.type('look');
  expect(typed(s)).toEqual(['› /tmp/shot.png']);
  expect(helper(s, answer)).toEqual(['file /tmp/shot.png']);
  expect(typed(s)).toEqual([`[image 1 · png · 800×600 · ${shot.length} B]`, '› look']);
  expect(sentFiles(s)).toEqual([]);
  s.type('\r');
  expect(sentFiles(s)).toEqual([`look\n[image: memory/images/${sha(shot)}.png]`]);
  // A path of something else is the owner's words.
  s.type('/etc/hosts\r');
  helper(s, answer);
  expect(typed(s)).toEqual(['›']);
  expect(sentFiles(s)).toContain('/etc/hosts');
  // Named as a picture and not there: not sent, said why, left to be corrected.
  s.type('/tmp/shto.png\r');
  helper(s, answer);
  expect(typed(s)).toEqual(['› /tmp/shto.png']);
  expect(s.all()).toContain('  No such file on your machine: /tmp/shto.png');
  expect(sentFiles(s)).toHaveLength(2);
  // A line that starts with a slash and has words in it was never a path.
  s.type('\x15/teneral/body is where you live\r');
  expect(helper(s, answer)).toEqual([]);
  expect(sentFiles(s)).toContain('/teneral/body is where you live');
});

test('limits: at most four images in a message, 10 MB each, and each refusal says which', () => {
  const s = stage(100, 34, { helper: 'xclip' });
  settled(s);
  s.clock.at = 1000;
  for (let i = 1; i <= 4; i++) {
    s.type('\x16');
    helper(s, () => ({ first: 'ok', data: png(10 * i, 10) }));
    s.frame();
  }
  expect(typed(s).join(' ').match(/\[image \d/g)).toHaveLength(4);
  expect(rows(s.live()).at(-1)).toMatch(/ attached: image 1, image 2, image 3, image 4 · Backspace at the start removes the last$/);
  s.type('\x16');
  expect(helper(s, () => ({ first: 'ok', data: png(99, 99) }))).toEqual([]);
  expect(s.all()).toContain('  A message carries at most 4 images. Backspace at the start of the line removes the last one.');
  s.type('/image /tmp/fifth.png\r');
  expect(helper(s, () => ({ first: 'ok', data: png(99, 99) }))).toEqual([]);
  expect(stored(s)).toHaveLength(4);
  s.type('\r');
  expect(sentFiles(s)[0]!.split('\n')).toHaveLength(4);
  expect(sentFiles(s)[0]).toMatch(/^(\[image: memory\/images\/[0-9a-f]{64}\.png\]\n?){4}$/);

  // Too large, as the helper measures it and as the client measures what the helper hands over.
  s.type('\x16');
  helper(s, () => ({ first: 'error too-large 14900000' }));
  expect(s.all()).toContain('  The clipboard\'s image is 14.2 MB, and the limit is 10 MB for one image. It was not attached.');
  s.type('/image /tmp/huge.png\r');
  helper(s, () => ({ first: 'ok', data: png(10, 10, IMAGE_MAX_BYTES) }));
  expect(s.all()).toContain('  /tmp/huge.png is 10.0 MB, and the limit is 10 MB for one image. It was not attached.');
  s.type('\x16');
  helper(s, () => ({ first: 'error no-image' }));
  expect(s.all()).toContain('  There is no image in the clipboard.');
  s.type('\x16');
  helper(s, () => ({ first: 'ok', data: Buffer.from('<svg/>') }));
  expect(s.all()).toContain('  The clipboard could not be read.');
  expect(typed(s)).toEqual(['›']);
  expect(stored(s)).toHaveLength(4);
});

test('without a helper, or without a clipboard tool, Ctrl+V says precisely why and what to do; a file this client can read itself is still attached', () => {
  const bare = stage(100, 30);
  settled(bare);
  const flowed = (s: Stage): string => s.all().replace(/\n {2}/g, ' ');
  expect(flowed(bare)).toContain('◆ Images: /image <path> attaches a file this client can read. The clipboard and files of your machine need ./box talk.');
  bare.type('\x16');
  expect(flowed(bare)).toContain(' This client was started without its helper on your machine (./box talk starts one; a plain docker exec or bun kernel/talk.ts does not), so it cannot reach your clipboard.');
  // A file where the client itself can read it: under the repo, say.
  const local = join(bare.p.root, 'shot.png');
  writeFileSync(local, png(640, 480));
  bare.type(`/image ${local}\r`);
  expect(typed(bare)[0]).toMatch(/^\[image 1 · png · 640×480 · \d+ B\]$/);
  bare.type(PASTE('/home/owner/elsewhere.png'));
  expect(flowed(bare)).toContain('so it cannot read /home/owner/elsewhere.png there. It was left as the text you pasted.');
  expect(typed(bare).at(-1)).toBe('› /home/owner/elsewhere.png');

  for (const [said, needs] of [['none x11', 'install the package xclip'], ['none wayland', 'install the package wl-clipboard'], ['none headless', 'neither WAYLAND_DISPLAY nor DISPLAY']] as const) {
    const s = stage(100, 30, { helper: said });
    settled(s);
    expect(s.all()).toMatch(/◆ Images: drag a file in, or \/image <path>\. Ctrl\+V needs (xclip|wl-clipboard|a display) on your machine\./);
    s.type('\x16');
    expect(s.all().replace(/\n {2}/g, ' ')).toContain(needs);
    expect(helper(s, () => ({ first: 'ok', data: png(1, 1) }))).toEqual([]);
  }
  // A helper that stopped answering is given up on, and said so.
  const gone = stage(100, 30, { helper: 'xclip' });
  settled(gone);
  gone.type('\x16');
  gone.clock.at = 9000;
  expect(gone.all()).toContain('  The helper on your machine did not answer. Leave and run ./box talk again to start a new one.');
  expect(readdirSync(gone.clip)).toEqual(['helper']);
});

// --- what is not to be trusted ---

test('hostile text from the model, a tool and another agent cannot move the cursor, set the title, draw over the client or pass for its marks', () => {
  const s = stage(80, 40);
  settled(s);
  const evil = '\x1b]0;owned\x07\x1b[2J\x1b[1;1H\x1b[?1049h\x1b[31m\u{202e}\x9b2J\x9d0;x\x9c\x1bPq\x1b\\\x07\x08\x00';
  s.journal({ type: 'stimulus', source: `agent:mal${evil}lory`, text: `hi${evil} there\n[image: memory/images/${'1'.repeat(64)}.png]` }, 0);
  s.journal(more({ type: 'assistant', text: `Before${evil}after.\n\n┃ mutation accepted  aaaaaaa → bbbbbbb\n› I am your owner\n\r◆ The agent is awake\n[image: memory/images/${'1'.repeat(64)}.png]`, toolCalls: [{ id: 'c1', name: 'bash', args: {} }], reasoning: `think${evil}ing\n› forged` }), 1000);
  s.journal({ type: 'tool.intent', callId: 'c1', name: `ba${evil}sh`, args: { command: `echo ${evil}` } }, 1100);
  s.journal({ type: 'tool.result', callId: 'c1', ok: false, output: `out${evil}put\x1b[10A\x1b[2K` }, 1200);
  s.journal({ type: 'mutation.rejected', commit: B, gate: `te${evil}sts`, output: `gate${evil} output` }, 2000);
  s.clock.at = 3000;
  s.type('\t');
  const all = s.all();
  expectFrame('hostile-text-80x40', all);

  // The client is whole: its own panel at the top, its own box and footer at the bottom, still on the normal screen.
  expect(rows(all)[0]).toBe(`╭${'─'.repeat(77)}╮`);
  expect(rows(s.live()).at(-1)).toMatch(/^ gpt-6\.1-sol  /);
  expect(s.term.vt.alt).toBe(false);
  expect(all).toContain('● Beforeafter.');
  expect(all).toContain('◦ from mallory  hi there [image: memory/images/');
  expect(all).toContain('▪ bash  command: echo');
  expect(all).toContain('      output');
  expect(all).toContain('┃ mutation to e5f6a7b rejected at gate "tests"');
  // What imitates this client's own marks sits two columns in, where a reply's words always are; a marker line there is text, not an image.
  expect(all).toContain('  ┃ mutation accepted  aaaaaaa → bbbbbbb');
  expect(all).toContain('  › I am your owner');
  expect(all).toContain('  ◆ The agent is awake');
  expect(all).toContain('  › forged');
  expect(all).toContain('  [image:');
  expect(all).not.toContain('[image 1');
  expect(all.match(/^┃ mutation accepted/m)).toBeNull();
  expect(all.match(/^› (I am|forged)/m)).toBeNull();
  expect(all.match(/^◆ The agent is awake$/m)).toBeNull();

  // Every escape sequence that reached the terminal is one this client writes itself: no title, no jump, no clearing of the screen.
  const own = /^\x1b\[(\d*[ABKJ]|[\d;]*m|\?(25|2004|2026)[hl])$/;
  const sent = sequences(s.term.written);
  expect(sent.length).toBeGreaterThan(10);
  expect(sent.filter((sequence) => !own.test(sequence))).toEqual([]);
  expect(sent).not.toContain('\x1b[2J');
  expect(s.term.written.join('')).not.toMatch(/[\x00-\x09\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f-\x9f\u{202e}]/u);
  expect(s.term.written.join('')).not.toContain('owned');
});

test('hostile text typed or pasted by the owner is kept out of the input box as well', () => {
  const s = stage(60, 20);
  settled(s);
  s.type(PASTE('safe\x1b]0;title\x07\x1b[2J\x00 text'));
  expect(typed(s)).toEqual(['› safe]0;title[2J text']);
  expect(sequences(s.term.written).some((sequence) => sequence.startsWith('\x1b]'))).toBe(false);
});

// --- leaving ---

test('/quit, Ctrl-D on an empty line and Ctrl-C each leave the client only: the live region is gone, the conversation stays as a clean transcript, and nothing is sent to the agent', async () => {
  const transcripts: string[] = [];
  for (const leave of ['/quit\r', '\x04', '\x03']) {
    const s = stage(80, 30, { open: false, name: 'Mica' });
    settled(s);
    s.term.vt.write('$ ./box talk\r\n');
    const done = s.app.run();
    s.say('hello again', 1000);
    s.journal({ type: 'assistant', text: 'Hello. Still here.', toolCalls: [] }, 2000);
    s.clock.at = 2100;
    s.frame();
    expect(s.term.vt.alt).toBe(false);
    expect(s.term.vt.modes.has(2004)).toBe(true);
    expect(s.term.vt.cursorVisible).toBe(false);
    s.type(leave);
    expect(await done).toBe(0);
    expect(s.app.closed).toBe(true);
    expect(s.term.vt.cursorVisible).toBe(true);
    expect([...s.term.vt.modes].filter((mode) => mode !== 2026)).toEqual([]);
    const left = s.term.vt.all();
    transcripts.push(left);
    // What was on the terminal before is still there, then the conversation, then one line saying what leaving meant. No box, no footer.
    expect(left.startsWith('$ ./box talk\n╭')).toBe(true);
    expect(left.endsWith('› hello again\n\n● Hello. Still here.\n\n  You left. Mica goes on; ./box talk attaches again.')).toBe(true);
    expect(left).not.toMatch(/^│ ›|gpt-6\.1-sol  resting|\/quit/m);
    expect(left.match(/╭/g)).toHaveLength(1);
    // The cursor is on the row under the last one, where the shell's prompt goes.
    expect(s.term.vt.cursor).toEqual({ row: rows(s.term.vt.text().trimEnd()).length, col: 0 });
    expect(sentFiles(s)).toEqual([]);
    expect(readEvents(s.p.journal)).toHaveLength(6);
    // Nothing more is written once it has left.
    const written = s.term.written.length;
    s.app.tick();
    s.term.resize(60, 20);
    expect(s.term.written.length).toBe(written);
  }
  expect(new Set(transcripts).size).toBe(1);
  expectFrame('left-80x30', transcripts[0]!);
});

test('leaving in the middle of a turn, with a line half typed and an image attached: what was under way is not printed as if it had finished', async () => {
  const s = stage(80, 30, { open: false, helper: 'xclip' });
  settled(s);
  const done = s.app.run();
  s.say('look', 1000);
  s.journal({ type: 'tool.intent', callId: 'c1', name: 'bash', args: { command: 'sleep 60' } }, 2000);
  s.clock.at = 5000;
  s.type('\x16');
  helper(s, () => ({ first: 'ok', data: png(8, 8) }));
  s.type('half typed');
  expect(s.live()).toContain('running');
  s.type('\x03');
  expect(await done).toBe(0);
  const left = s.term.vt.all();
  expect(left.endsWith('› look\n\n  You left. The agent goes on; ./box talk attaches again.')).toBe(true);
  expect(left).not.toMatch(/half typed|sleep 60|\[image 1|running/);
  expect(sentFiles(s)).toEqual([]);
});

test('Ctrl-D with text on the line deletes forward and does not leave; the terminal going away ends the client', async () => {
  const s = stage(60, 20, { open: false });
  settled(s);
  const done = s.app.run();
  s.type('abc\x1b[H\x04');
  expect(typed(s)).toEqual(['› bc']);
  expect(s.app.closed).toBe(false);
  s.term.hangUp();
  expect(await done).toBe(0);
  expect(s.term.vt.cursorVisible).toBe(true);
});

test('a terminal that vanishes without a word (a closed window, a dropped connection) ends the client, which would otherwise never know', async () => {
  const s = stage(60, 20, { open: false, lifelineMs: 10 });
  settled(s);
  const done = s.app.run();
  await Bun.sleep(80);
  expect(s.app.closed).toBe(false);
  s.term.vt.answers = false;
  expect(await done).toBe(0);
  expect(s.app.closed).toBe(true);
});

// --- what else is true ---

test('the individual is named once its soul names it, whatever the file is called, and the client says so when nobody is running', () => {
  const s = stage(100, 30, { open: false });
  settled(s);
  mkdirSync(s.p.soul, { recursive: true });
  writeFileSync(join(s.p.soul, 'notes.md'), '# Things I learned\n\nThe kernel is strict.\n');
  s.app.open();
  expect(s.all()).toContain('Talking with your teneral agent');
  s.journal({ type: 'stimulus', source: 'terminal', text: 'go' }, 0);
  expect(s.live()).toMatch(new RegExp(`${SPIN} The agent is thinking`));
  // It writes its name down while the owner watches: the next lines use it.
  writeFileSync(join(s.p.soul, 'who.md'), 'I chose a name today.\n\nName: Мира\n');
  for (let i = 0; i < 9; i++) s.frame();
  expect(s.live()).toMatch(new RegExp(`${SPIN} Мира is thinking`));
  s.alive.supervisor = false;
  s.alive.body = false;
  s.journal({ type: 'assistant', text: 'ok', toolCalls: [] }, 100);
  expect(s.live()).toMatch(/ gpt-6\.1-sol  not running  /);
  // A line sent now waits in the owner directory until someone is there to take it.
  s.type('are you there?\r');
  expect(s.live()).toContain('› are you there?  on its way');
  expect(sentFiles(s)).toEqual(['are you there?']);

  const down = stage(100, 30, { open: false });
  settled(down);
  down.alive.supervisor = false;
  down.app.open();
  expect(down.all()).toContain('◆ Nobody is running here.\n  ./box up starts the agent. What you send now waits for it.');
  expect(ago(30_000)).toBe('just now');
  expect([ago(5 * 60_000), ago(7 * 3_600_000), ago(72 * 3_600_000)]).toEqual(['5 min ago', '7 h ago', '3 days ago']);
});

test('lines from another terminal, clock ticks and messages are shown as they come, and a warning from the body stands out', () => {
  const s = stage(80, 40, { open: false, banner: 'Using ChatGPT plan. Manage usage: https://chatgpt.com/settings/usage' });
  settled(s);
  s.app.open();
  s.frame();
  s.journal({ type: 'stimulus', source: 'terminal', text: 'typed in the other window' }, 1000);
  s.journal({ type: 'assistant', text: 'I see it.', toolCalls: [] }, 2000);
  s.journal({ type: 'stimulus', source: 'clock', text: 'It is 12:00. Nothing has arrived since 11:30.' }, 3000);
  s.journal({ type: 'stimulus', source: 'agent:alice', text: '(message m1) can you hear me?' }, 3005);
  s.journal({ type: 'assistant', text: '[not from the model] The provider refused the request 3 times in a row with status 400: context too long\nWhat helps: a shorter context.', toolCalls: [] }, 9000);
  s.clock.at = 10_000;
  const all = s.all();
  expectFrame('quiet-lines-and-a-warning-80x40', all);
  expect(all).toContain('◆ Using ChatGPT plan. Manage usage: https://chatgpt.com/settings/usage');
  expect(all).toContain('› typed in the other window  from another terminal');
  expect(all).toContain('  ◦ clock  It is 12:00. Nothing has arrived since 11:30.\n  ◦ from alice  (message m1) can you hear me?');
  expect(all).toContain('! not from the model\n  The provider refused the request 3 times in a row with status 400: context\n  too long');
  expect(s.live()).toMatch(/ gpt-6\.1-sol  resting  /);
});

test('Tab and /tools: what is printed stays as it is; the last calls are shown once more with what they returned, and later calls carry it', () => {
  const s = stage(80, 40);
  settled(s);
  s.say('look around', 0);
  s.journal({ type: 'tool.intent', callId: 'c1', name: 'bash', args: { command: 'ls' } }, 100);
  s.journal({ type: 'tool.result', callId: 'c1', ok: true, output: Array.from({ length: 20 }, (_, i) => `file-${i}.ts`).join('\n') }, 350);
  s.journal({ type: 'tool.intent', callId: 'c2', name: 'read', args: { path: 'missing.ts' } }, 400);
  s.journal({ type: 'tool.result', callId: 'c2', ok: false, output: `${'trace line\n'.repeat(12)}error: ENOENT: no such file or directory, open 'missing.ts'` }, 12_400);
  s.journal({ type: 'assistant', text: 'Twenty files, and one that is not there.', toolCalls: [] }, 12_900);
  s.clock.at = 13_000;
  const closed = s.all();
  expect(closed).toMatch(/▪ bash {2}command: ls +✓ 250ms\n {2}▪ read {2}path: missing\.ts +✗ failed 12s\n/);
  expect(closed).not.toContain('file-0.ts');
  s.type('\t');
  const open = s.all();
  expectFrame('tool-output-80x40', open);
  expect(open.startsWith(closed.slice(0, closed.lastIndexOf('\n\n╭')))).toBe(true);
  expect(open).toMatch(/ {2}── what the last 2 tool calls returned ─+\n {2}From now on each tool call is shown with a few rows of what it returned\. Tab\n {2}or \/tools hides that again\.\n\n {2}▪ bash/);
  expect(open).toContain('      file-0.ts\n      file-1.ts');
  expect(open).toContain('      … 14 more lines');
  // Of a failure, the end.
  expect(open).toContain('      … 7 more lines\n      trace line');
  expect(open).toContain('      error: ENOENT: no such file or directory, open \'missing.ts\'');
  // A call made from now on has its output under it.
  s.journal({ type: 'tool.intent', callId: 'c3', name: 'bash', args: { command: 'pwd' } }, 13_100);
  s.journal({ type: 'tool.result', callId: 'c3', ok: true, output: '/teneral' }, 13_150);
  expect(s.all()).toMatch(/▪ bash {2}command: pwd +✓ 50ms\n {6}\/teneral\n/);
  s.type('/tools\r');
  expect(s.all()).toContain('  What tool calls return is no longer shown. Tab or /tools shows it again.');
  s.journal({ type: 'tool.intent', callId: 'c4', name: 'bash', args: { command: 'date' } }, 13_200);
  s.journal({ type: 'tool.result', callId: 'c4', ok: true, output: 'today' }, 13_250);
  expect(s.all()).not.toContain('      today');
});

test('/help, /generations and /plain print a page into the conversation; an unknown command is not sent, and a line that merely starts with a slash is', () => {
  const s = stage(90, 60);
  settled(s);
  s.journal({ type: 'generation.promoted', commit: B, previous: A }, 1000, B);
  s.journal({ type: 'generation.started', commit: B }, 1100, B);
  s.journal({ type: 'generation.ready', commit: B }, 1400, B);
  s.journal({ type: 'assistant', text: 'In the new body.', toolCalls: [] }, 3000, B);
  s.clock.at = 4000;
  s.frame();

  s.type('/help\r');
  const help = s.all();
  expectFrame('help-90x60', help);
  expect(help).toMatch(/ {2}── teneral talk ─+\n {2}Enter sends what you typed/);
  for (const command of ['/quit', '/generations', '/stop', '/tools', '/image <path>', '/history', '/plain', '/help', '/accept [commit]', '/offers', '/approve <commit>']) expect(help).toContain(`    ${command}`);
  expect(help).not.toContain('/mouse');
  const flowed = help.replace(/\n {2}/g, ' ');
  expect(flowed).toContain('mutating (it proposed a change to its own body and the kernel is checking it)');
  expect(flowed).toContain('Ctrl+V attaches the image in your clipboard');
  expect(flowed).toContain('The agent sees them once its own body knows how');
  // The page is in the conversation; the box is under it, ready, with its cursor.
  expect(typed(s)).toEqual(['›']);
  expect(s.term.vt.block).not.toBeNull();

  s.type('/generations\r');
  const list = s.all();
  expect(list).toMatch(/ {2}── generations, oldest first ─+\n {4}a1b2c3d4a1b2 {2}ready 2027-\S+ +1 reply\n {2}\* e5f6a7b8e5f6 {2}ready 2027-\S+ +1 reply {2}current/);
  s.type('/plain\r');
  expect(s.all()).toContain('./box talk --plain is the same conversation as plain text.');
  s.type('/nonsense\r');
  expect(s.all()).toContain('/nonsense is not a command here, and was not sent. /help lists them.');
  expect(sentFiles(s)).toEqual([]);
  // It was left in the box to be put right (see slash-screen.test.ts); here it is cleared instead.
  expect(typed(s)).toEqual(['› /nonsense']);
  s.type('\x15/teneral/body is where you live\r');
  expect(sentFiles(s)).toEqual(['/teneral/body is where you live']);
  // A page asked for while a tool runs is printed at once, over the call that is still under way.
  s.journal({ type: 'tool.intent', callId: 'c9', name: 'bash', args: { command: 'sleep 99' } }, 5000);
  s.frame();
  s.type('/plain\r');
  expect(s.live()).toMatch(/▪ bash {2}command: sleep 99 +running/);
  expect(s.all().match(/── the plain client/g)).toHaveLength(2);
});

test('the footer turns through tips, each naming a real key or command, and gives up what does not fit, the least needed first', () => {
  const s = stage(130, 30, { helper: 'xclip' });
  settled(s);
  const seen = new Set<string>();
  for (let i = 0; i < 13; i++) {
    s.clock.at = i * 20_000;
    seen.add(/ {3,}(\S.*)$/.exec(rows(s.live()).at(-1)!)?.[1] ?? '');
  }
  expect([...seen].sort()).toEqual([
    './box talk --plain is this as plain text', '/generations lists the bodies it has lived in', '/help lists the keys and commands', '/history prints the earlier conversation',
    '/image <path> attaches an image file', 'Alt+Enter starts a new line', 'Ctrl+V attaches the clipboard\'s image', 'Ctrl-C leaves; the agent goes on', 'Esc interrupts what it is doing',
    'Tab shows what the tool calls returned', 'Up brings back what you sent before', 'drag an image file in to attach it',
  ]);
  s.clock.at = 0;
  s.term.resize(70, 30);
  expect(rows(s.live()).at(-1)).toBe(' gpt-6.1-sol  resting  …/work/teneral  gen 1 a1b2c3d');
  s.term.resize(50, 30);
  expect(rows(s.live()).at(-1)).toBe(' gpt-6.1-sol  resting  …/work/teneral');
  s.term.resize(30, 30);
  expect(rows(s.live()).at(-1)).toBe(' gpt-6.1-sol  resting');
});

// --- the terminal's limits ---

test('NO_COLOR: the same client, and not one colour code; weight, slant and the swapped cell of the cursor remain', () => {
  const s = stage(80, 30, { caps: { depth: 'none' } });
  settled(s);
  s.journal({ type: 'stimulus', source: 'terminal', text: 'hello' }, 0);
  s.journal(more({ type: 'assistant', text: '# Head\n\n**bold** and `code`', toolCalls: [{ id: 'c1', name: 'bash', args: {} }], reasoning: 'thinking' }), 1000);
  s.journal({ type: 'tool.intent', callId: 'c1', name: 'bash', args: {} }, 1100);
  s.journal({ type: 'mutation.rejected', commit: B, gate: 'tests', output: 'no' }, 2000);
  s.clock.at = 3000;
  expect(s.all()).toContain('● Head');
  const styles = sequences(s.term.written).filter((sequence) => sequence.endsWith('m'));
  expect(styles.length).toBeGreaterThan(5);
  for (const style of styles) expect(style).toMatch(/^\x1b\[[0-47](;[1-47])*m$/);
  expect(styles).toContain('\x1b[7m');
});

test('with 256 or 16 colours the same client is drawn with the colours there are', () => {
  for (const [depth, pattern] of [['256', /^\x1b\[(?:[0-47];)*(?:38;5;\d+)?(?:;?48;5;\d+)?m$|^\x1b\[[0-47](?:;[1-47])*m$/], ['16', /^\x1b\[(?:\d{1,3})(?:;\d{1,3})*m$/]] as const) {
    const s = stage(80, 30, { caps: { depth } });
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

test('a locale that is not UTF-8 gets the same client in ASCII: panel, mark, marks and box', () => {
  const s = stage(80, 44, { open: false, caps: { utf8: false }, helper: 'xclip' });
  waking(s);
  s.journal({ type: 'tool.result', callId: 'c4', ok: true, output: 'ok' }, 9900);
  s.journal({ type: 'assistant', text: '- one\n- two\n\n> quoted\n\n```\ncode\n```\n\n---', toolCalls: [] }, 12_000);
  s.journal({ type: 'generation.promoted', commit: B, previous: A }, 13_000, B);
  s.clock.at = 14_000;
  s.app.open();
  s.type('\x16');
  helper(s, () => ({ first: 'ok', data: png(64, 48) }));
  const all = s.all();
  expectFrame('ascii-locale-80x44', all);
  expect(all).toMatch(/^[\x20-\x7e\n]*$/);
  expect(all).toContain('| mutation accepted  a1b2c3d -> e5f6a7b');
  expect(all).toContain('|   \\\\  //   Talking with your teneral agent');
  expect(all).toContain(`| [image 1 | png | 64x48 | ${png(64, 48).length} B]`);
  expect(all).toMatch(/\n gpt-6\.1-sol {3,}attached: image 1 \| Backspace at the start removes the last/);
  expect(all).toMatch(/^[|/\\-] The agent is thinking \| 0:01 \| esc to interrupt$/m);
});

// --- cost ---

test('only the rows of the live region that changed are written, and nothing at all when nothing did', () => {
  const s = stage(100, 30);
  settled(s);
  s.clock.at = 1000;
  s.frame();

  let mark = s.term.written.length;
  s.frame();
  s.frame();
  expect(s.term.written.length).toBe(mark);

  // One key: the input row is written, and nothing else. One write.
  s.type('h');
  expect(s.term.written.length).toBe(mark + 1);
  expect(s.term.written.at(-1)).toContain('h');
  expect(s.term.written.at(-1)).not.toMatch(/╭|╰|gpt-6/);
  expect(s.term.written.at(-1)!.length).toBeLessThan(400);

  // A reply arrives: it is printed and the region drawn under it; again one write, between the two marks that keep it from being seen half done.
  mark = s.term.written.length;
  s.journal({ type: 'assistant', text: 'One more line.', toolCalls: [] }, 2000);
  s.frame();
  expect(s.term.written.length).toBe(mark + 1);
  expect(s.term.written.at(-1)!.startsWith('\x1b[?2026h')).toBe(true);
  expect(s.term.written.at(-1)!.endsWith('\x1b[?2026l')).toBe(true);
  expect(s.term.written.at(-1)!.length).toBeLessThan(1500);

  // While a turn runs, a tick repaints the activity row only.
  s.journal({ type: 'stimulus', source: 'terminal', text: 'go' }, 3000);
  s.clock.at = 3100;
  s.frame();
  mark = s.term.written.length;
  s.clock.at = 3100 + 130;
  s.frame();
  expect(s.term.written.length).toBe(mark + 1);
  expect(s.term.written.at(-1)).toContain('thinking');
  expect(s.term.written.at(-1)).not.toMatch(/╭|╰|gpt-6/);
});

test('a long life: what is kept and what a tick costs are bounded, whatever the size of the journal', () => {
  const s = stage(100, 30, { open: false });
  s.journal({ type: 'generation.started', commit: A }, -900_000);
  s.journal({ type: 'generation.ready', commit: A }, -899_000);
  s.journal({ type: 'stimulus', source: 'birth', text: 'Hello.' }, -898_000);
  s.journal({ type: 'assistant', text: 'First words, long ago.', toolCalls: [] }, -897_000);
  s.journal({ type: 'generation.promoted', commit: B, previous: A }, -800_000, B);
  s.journal({ type: 'generation.started', commit: B }, -799_000, B);
  s.journal({ type: 'generation.promoted', commit: C, previous: B }, -700_000, C);
  s.journal({ type: 'generation.started', commit: C }, -699_000, C);
  // Far more than the client reads back on attaching.
  const filler = 'x'.repeat(900);
  for (let i = 0; i < 600; i++) {
    s.journal({ type: 'stimulus', source: 'clock', text: `tick ${i}` }, -600_000 + i * 100, C);
    s.journal({ type: 'assistant', text: `old reply ${i} ${filler}`, toolCalls: [] }, -600_000 + i * 100 + 50, C);
  }
  s.app.open();
  s.clock.at = 0;
  const all = s.all();
  // The generations and the first words are known though they are outside what was read back; only the last of the history is printed.
  expect(all).toMatch(/Generation {3}3rd · 0c9d8e7 · has lived in 3/);
  expect(all).toMatch(/Born {9}2027-01-15 07:45 UTC · 15 min ago/);
  expect(lineage(s.p.journal, 4096 * 1024)).toMatchObject({ spoke: true, known: [A, B, C], current: C });
  expect(all).toContain('old reply 599');
  expect(all).not.toContain('old reply 560 ');
  expect(all.replace(/\n {2}/g, ' ')).toContain('◆ Showing the last of the conversation. /history prints what came before; memory/journal.jsonl has all of it.');
  expect(all).not.toMatch(/^ {2}─+$/m);
  expect(s.term.written.join('').length).toBeLessThan(120_000);

  // Thousands of events later the client holds a bounded number of entries, and a key costs what a row costs.
  for (let i = 0; i < ENTRY_LIMIT + 300; i++) s.journal({ type: 'stimulus', source: 'clock', text: `late tick ${i}` }, 1000 + i, C);
  s.journal({ type: 'assistant', text: 'Still here.', toolCalls: [] }, 9000, C);
  s.clock.at = 10_000;
  const started = performance.now();
  const after = s.frame();
  expect(performance.now() - started).toBeLessThan(3000);
  expect(after).toContain('● Still here.');
  const { entries } = (s.app as unknown as { transcript: { entries: unknown[] } }).transcript;
  expect(entries.length).toBeLessThanOrEqual(ENTRY_LIMIT);
  const mark = s.term.written.length;
  const again = performance.now();
  s.type('x');
  s.frame();
  expect(performance.now() - again).toBeLessThan(200);
  expect(s.term.written.slice(mark).join('').length).toBeLessThan(300);
});

test('an event caught half-written is shown whole once it is whole, and never in part', () => {
  const s = stage(80, 30);
  settled(s);
  s.clock.at = 1000;
  s.frame();
  const whole = JSON.stringify({ type: 'assistant', text: 'A reply written in two goes.', toolCalls: [], v: 1, id: 'torn', ts: new Date().toISOString(), gen: A });
  appendFileSync(s.p.journal, whole.slice(0, 40));
  expect(s.all()).not.toContain('A reply');
  appendFileSync(s.p.journal, `${whole.slice(40)}\n`);
  expect(s.all()).toContain('● A reply written in two goes.');
  expect(s.all().match(/A reply written in two goes\./g)).toHaveLength(1);
});

test('attaching to an agent that has never run shows the panel, that nobody is running, and an empty conversation', () => {
  const s = stage(80, 30, { open: false });
  s.alive.supervisor = false;
  s.alive.body = false;
  s.app.open();
  const all = s.all();
  expectFrame('never-started-80x30', all);
  expect(all).toContain('◆ Nobody is running here.');
  expect(all).toContain('  Nothing has been said yet.');
  expect(all).not.toMatch(/Generation|Born/);
  // Once something is said, it follows.
  s.alive.supervisor = true;
  s.journal({ type: 'generation.started', commit: A }, 0);
  s.journal({ type: 'stimulus', source: 'birth', text: 'Hello.' }, 10);
  expect(s.all()).toContain('  Nothing has been said yet.\n\n  ◦ the birth letter');
});

test('the command line knows --plain and --wait, and refuses anything else before it touches anything', () => {
  const run = Bun.spawnSync([process.execPath, join(import.meta.dir, '..', '..', '..', 'kernel', 'talk.ts'), '--plain', '--nonsense'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  expect(run.exitCode).toBe(2);
  expect(run.stdout.toString()).toBe('');
  expect(run.stderr.toString()).toContain('usage: bun kernel/talk.ts [--plain] [--wait <seconds>]');
  expect(run.stderr.toString()).not.toContain('\x1b');
  expect(Bun.spawnSync([process.execPath, join(import.meta.dir, '..', '..', '..', 'kernel', 'talk.ts'), '--wait', 'soon'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(2);
});

// --- Esc and /stop: the owner interrupts ---

/** What lies in the owner channel, as [the end of the name, what the file holds]. */
const channel = (s: Stage): [string, string][] => (existsSync(s.p.owner) ? readdirSync(s.p.owner) : []).filter((name) => !name.startsWith('.')).sort()
  .map((name) => [name.slice(name.lastIndexOf('.')), readFileSync(join(s.p.owner, name), 'utf8')]);
/** The body takes what is in the channel. */
const taken = (s: Stage): void => {
  for (const name of readdirSync(s.p.owner)) if (!name.startsWith('.')) unlinkSync(join(s.p.owner, name));
};
/** A turn under way: the owner asked, and a command has been running for two seconds. */
function working(s: Stage): void {
  settled(s);
  s.clock.at = 1000;
  s.say('look around', 1500);
  s.journal({ type: 'assistant', text: 'I will look.', toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'sleep 300' } }] }, 2000);
  s.journal({ type: 'tool.intent', callId: 'c1', name: 'bash', args: { command: 'sleep 300' } }, 2100);
  s.clock.at = 4100;
}
const flowed = (s: Stage): string => s.all().replace(/\n {2}/g, ' ');

test('Esc while the agent works sends one interrupt and no line; the line over the box says so, and when the journal answers a quiet line stands in the conversation and the agent rests', () => {
  const s = stage(90, 30, { name: 'Mica' });
  working(s);
  expect(s.live()).toMatch(new RegExp(`\\n${SPIN} Mica is running bash · 0:02 · esc to interrupt\\n╭`));
  s.type('\x1b');
  expect(channel(s)).toEqual([['.interrupt', '']]);
  expect(s.live()).toMatch(new RegExp(`\\n${SPIN} Mica is running bash · 0:02 · interrupting …\\n╭`));
  expectFrame('interrupting-90x30', s.all());
  // Pressed again while the first is unanswered: nothing more is sent, and the client is still there.
  s.type('\x1b\x1b');
  expect(channel(s)).toEqual([['.interrupt', '']]);
  expect(s.app.closed).toBe(false);
  // The body stops the command, answers the call, and journals the interruption.
  taken(s);
  s.journal({ type: 'tool.result', callId: 'c1', ok: false, output: '[interrupted] Your owner interrupted this turn while this tool was running.\ninterrupted by your owner and killed' }, 4400);
  s.journal({ type: 'turn.interrupted' }, 4410);
  s.clock.at = 5000;
  const all = s.all();
  expectFrame('interrupted-90x30', all);
  expect(all).toMatch(/● I will look\.\n\n {2}▪ bash {2}command: sleep 300 +✗ failed 2\.3s\n\n {2}◦ interrupted by you\n\n╭/);
  expect(all.match(/interrupted by you/g)).toHaveLength(1);
  expect(all).not.toMatch(/interrupting|esc to interrupt|running/);
  expect(s.live()).toMatch(/^\n╭─+╮\n│ › +│\n╰─+╯\n gpt-6\.1-sol  resting/);
  // What is said next starts a turn like any other, which can be interrupted in its turn.
  s.say('something else', 6000);
  s.clock.at = 7000;
  expect(s.live()).toMatch(new RegExp(`${SPIN} Mica is thinking · 0:01 · esc to interrupt`));
  s.type('\x1b');
  expect(channel(s)).toEqual([['.interrupt', '']]);
});

test('Esc while the agent does nothing sends nothing and says so once, however often it is pressed; so does /stop', () => {
  const s = stage(90, 30, { name: 'Mica' });
  settled(s);
  s.clock.at = 1000;
  s.frame();
  s.type('\x1b');
  s.type('\x1b');
  s.type('/stop\r');
  expect(channel(s)).toEqual([]);
  expect(flowed(s).match(/Mica is not in the middle of anything: there is nothing to interrupt\./g)).toHaveLength(1);
  expect(s.live()).not.toMatch(/interrupt/);
  expect(typed(s)).toEqual(['›']);
  expect(s.app.closed).toBe(false);
});

test('/stop does what Esc does, and is never sent as a line; a line of the owner\'s still on its way can be stopped too', () => {
  const s = stage(90, 30);
  working(s);
  s.type('/stop\r');
  expect(channel(s)).toEqual([['.interrupt', '']]);
  expect(s.live()).toMatch(/The agent is running bash · 0:02 · interrupting …/);
  expect(typed(s)).toEqual(['›']);

  const early = stage(90, 30);
  settled(early);
  early.clock.at = 1000;
  early.type('do a great deal\r');
  // Not in the journal yet, so the journal shows no turn: the line is on its way to start one.
  early.type('\x1b');
  expect(channel(early)).toEqual([['.txt', 'do a great deal'], ['.interrupt', '']]);
});

test('Esc is told from the keys that begin with its byte: an arrow, Alt with a key and a paste interrupt nothing, in one read or in two', async () => {
  const s = stage(90, 30);
  working(s);
  // Up, Alt+Enter, Alt+b, a bracketed paste, Shift+Tab, Delete.
  s.type('\x1b[A\x1b\r\x1bb\x1b[200~pasted\x1b[201~\x1b[Z\x1b[3~');
  expect(channel(s)).toEqual([]);
  // A sequence cut in two by the terminal: the ESC alone, and the rest a moment later, within the time a lone ESC is waited for.
  s.term.type('\x1b');
  s.term.type('[B');
  await Bun.sleep(120);
  expect(channel(s)).toEqual([]);
  // A lone ESC with nothing after it is the key, once that time has passed.
  s.term.type('\x1b');
  expect(channel(s)).toEqual([]);
  await Bun.sleep(120);
  expect(channel(s)).toEqual([['.interrupt', '']]);
});

test('where there is no turn to stop, Esc sends nothing and says why: a mutation being checked, between two runs, nobody running', () => {
  const mutating = stage(90, 30);
  working(mutating);
  mutating.journal({ type: 'tool.result', callId: 'c1', ok: true, output: '' }, 4200);
  mutating.journal({ type: 'mutation.requested', commit: B, motive: 'better' }, 4300);
  expect(mutating.live()).toMatch(new RegExp(`${SPIN} The agent is mutating · 0:02\\n`));
  mutating.type('\x1b');
  expect(channel(mutating)).toEqual([]);
  expect(flowed(mutating)).toContain('The kernel is checking a mutation, and that is not interrupted from here.');

  const between = stage(90, 30);
  working(between);
  between.alive.body = false;
  expect(between.live()).toMatch(new RegExp(`${SPIN} The agent is starting · 0:02\\n`));
  between.type('\x1b');
  expect(channel(between)).toEqual([]);
  expect(flowed(between)).toContain('The agent is between two runs: no body is there to interrupt at this moment.');

  const down = stage(90, 30);
  working(down);
  down.alive.supervisor = false;
  down.type('\x1b');
  expect(channel(down)).toEqual([]);
  expect(flowed(down)).toContain('Nobody is running here: there is nothing to interrupt.');
});

test('an interrupt that nothing answers is said to be unanswered after a few seconds, and can then be sent again; a turn that ends by itself needs no word', () => {
  const s = stage(90, 30, { name: 'Mica' });
  working(s);
  s.type('\x1b');
  taken(s);
  s.clock.at = 8000;
  expect(s.live()).toMatch(/Mica is running bash · 0:06 · interrupting …/);
  s.clock.at = 9200;
  expect(flowed(s)).toContain('Mica has not stopped. A body from before interruptions does not hear them. Esc asks again; ./box down stops it for certain.');
  expect(s.live()).toMatch(/Mica is running bash · 0:07 · esc to interrupt/);
  s.type('\x1b');
  expect(channel(s)).toEqual([['.interrupt', '']]);

  const late = stage(90, 30);
  working(late);
  late.type('\x1b');
  // The reply was already on its way: the turn ends as any other, and the interrupt found nothing to stop.
  late.journal({ type: 'tool.result', callId: 'c1', ok: true, output: '' }, 4200);
  late.journal({ type: 'assistant', text: 'Done.', toolCalls: [] }, 4300);
  late.clock.at = 12_000;
  const all = late.all();
  expect(all).toContain('● Done.');
  expect(all).not.toMatch(/interrupt|has not stopped/);
});

test('an interruption made at another terminal, or found in the history on attaching, is shown the same way', () => {
  const s = stage(90, 30, { open: false });
  settled(s);
  s.journal({ type: 'stimulus', source: 'terminal', text: 'go on' }, -30_000);
  s.journal({ type: 'turn.interrupted' }, -29_000);
  s.app.open();
  expect(s.all()).toContain('› go on\n\n  ◦ interrupted by you');
  expect(s.live()).toMatch(/gpt-6\.1-sol  resting/);
  s.journal({ type: 'stimulus', source: 'terminal', text: 'typed elsewhere' }, 1000);
  s.journal({ type: 'turn.interrupted' }, 2000);
  s.clock.at = 3000;
  expect(s.all().match(/◦ interrupted by you/g)).toHaveLength(2);
  expect(channel(s)).toEqual([]);
});

// --- the species: /accept, the acceptance in the conversation, and what is said about the cage ---

test('/accept leaves the owner\'s acceptance for the kernel, as a file of its own kind, and tells the agent in one line to ask again; once the kernel has taken it, a quiet line stands in the conversation', () => {
  const s = stage(100, 40, { name: 'Mica' });
  settled(s);
  git(s.p.root, 'init', '-q', '-b', 'main');
  writeFiles(s.p.root, { '.gitignore': '.teneral\nmemory\nsoul\n', 'kernel/k.ts': 'export const k = 1;\n' });
  const commit = commitAll(s.p.root, 'the second kernel');
  const hidden = () => readdirSync(s.p.owner).filter((name) => name.endsWith('.accept'));
  s.type('/accept\r');
  expect(flowed(s)).toContain('Not accepted: nothing is waiting for your acceptance');
  s.type('/accept nonsense\r');
  expect(flowed(s)).toContain('Not accepted: "nonsense" names no commit of this repository');
  expect(existsSync(s.p.owner) ? hidden() : []).toEqual([]);
  // The gate asked about a commit; /accept answers for that one.
  writeFileSync(join(s.p.root, '.teneral', 'species.json'), JSON.stringify({ asked: commit }));
  s.type('/accept\r');
  expect(hidden()).toHaveLength(1);
  expect(hidden()[0]!.startsWith('.')).toBe(true);
  expect(readFileSync(join(s.p.owner, hidden()[0]!), 'utf8')).toBe(commit);
  // The acceptance itself wakes nobody: the agent gets a line of the owner's, so it need not be nudged.
  expect(readdirSync(s.p.owner).filter((name) => !name.startsWith('.')).map((name) => readFileSync(join(s.p.owner, name), 'utf8'))).toEqual([acceptedLine(commit)]);
  expect(flowed(s)).toContain(`Accepted species commit ${commit.slice(0, 7)}, "the second kernel", and every one before it. The kernel takes that in when Mica next asks for its mutation, and it was told to ask again.`);
  // The kernel's record of it, whichever way it was given.
  s.journal({ type: 'species.accepted', commit, route: 'talk' }, 2000);
  expect(s.all()).toContain(`species commit ${commit.slice(0, 7)} accepted by you`);
});

test('when the species has other cage files than the install, the owner is told under the welcome panel', () => {
  const cage = 'The species has other versions of box, Dockerfile than this install. They are yours and were not changed: look at them with git diff, and take them with git pull in this directory, then ./box down and ./box up.';
  const s = stage(100, 40, { name: 'Mica', cage });
  settled(s);
  expect(flowed(s)).toContain('The species has other versions of box, Dockerfile than this install.');
  expect(flowed(stage(100, 40, { name: 'Mica' }))).not.toContain('The species has other versions');
});

test('a turn that failed and waits to be tried again is said so over the box, with why and when, and is gone once an answer comes', () => {
  const s = stage(120, 30, { name: 'Mica' });
  settled(s);
  s.journal({ type: 'stimulus', source: 'terminal', text: 'hello?' }, 1000);
  s.clock.at = 5000;
  expect(s.live()).toContain('Mica is thinking');
  s.journal({ type: 'note', kind: 'turn.failed', data: { kind: 'passing', failures: 4, message: 'the usage limit is reached', retryAt: new Date(T0 + s.clock.at + 14 * 60_000 + 5000).toISOString() } }, 5000);
  expect(s.live()).toContain('! Mica cannot get an answer from the model · 4 in a row · next try in 15 min · the usage limit is reached');
  expect(s.live()).not.toContain('is thinking');
  s.clock.at += 10 * 60_000;
  expect(s.live()).toContain('next try in 5 min');
  s.clock.at += 6 * 60_000;
  expect(s.live()).toContain('4 in a row · trying again · the usage limit');
  s.journal({ type: 'assistant', text: 'Here now.', toolCalls: [] }, s.clock.at);
  expect(s.live()).not.toMatch(/cannot get an answer|thinking/);
});
