import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMANDS, takes } from '../../../kernel/commands';
import { png } from './pictures';
import { A, expectFrame, stage, type Stage } from './stage';

// The owner's commands at the screen client: typed, offered under the input box, chosen, completed
// and run; keys go in as the bytes a terminal sends, and what is asserted is what the owner sees.

const PASTE = (text: string): string => `\x1b[200~${text}\x1b[201~`;
const [UP, DOWN, ESC, TAB, ENTER, CTRL_N, CTRL_P, CTRL_U, BACKSPACE] = ['\x1b[A', '\x1b[B', '\x1b', '\t', '\r', '\x0e', '\x10', '\x15', '\x7f'];
const rows = (frame: string): string[] => frame.split('\n');
const SPIN = '[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]';
/** The rows of the input box the owner types on, without its frame. */
const typed = (s: Stage): string[] => rows(s.live()).filter((row) => row.startsWith('│')).map((row) => row.slice(2, -1).trimEnd());
/** The commands offered now, as the names in the list, the chosen one in brackets; empty while there is no list. */
const listed = (s: Stage): string[] => rows(s.live()).map((row) => /^ {2}([▸ ]) (\/[a-z]+)/.exec(row)).filter((m) => m !== null).map((m) => (m[1] === '▸' ? `[${m[2]}]` : m[2]!));
/** What lies in the owner channel, as [the end of the name, what the file holds]. */
const channel = (s: Stage): [string, string][] => (existsSync(s.p.owner) ? readdirSync(s.p.owner) : []).filter((name) => !name.startsWith('.')).sort()
  .map((name) => [name.slice(name.lastIndexOf('.')), readFileSync(join(s.p.owner, name), 'utf8')]);
const taken = (s: Stage): void => {
  for (const name of readdirSync(s.p.owner)) if (!name.startsWith('.')) unlinkSync(join(s.p.owner, name));
};
const flowed = (s: Stage): string => s.all().replace(/\n {2}/g, ' ');

/** A life already under way, at rest. */
function settled(s: Stage): void {
  s.journal({ type: 'generation.started', commit: A }, -60_000);
  s.journal({ type: 'generation.ready', commit: A }, -59_000);
  s.journal({ type: 'stimulus', source: 'birth', text: 'Hello.' }, -58_000);
  s.journal({ type: 'assistant', text: 'Hello. I am here.', toolCalls: [] }, -50_000);
  s.clock.at = 1000;
  s.frame();
}

/** A turn under way: the owner asked, and a command has been running for two seconds. */
function working(s: Stage): void {
  settled(s);
  s.say('look around', 1500);
  s.journal({ type: 'assistant', text: 'I will look.', toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'sleep 300' } }] }, 2000);
  s.journal({ type: 'tool.intent', callId: 'c1', name: 'bash', args: { command: 'sleep 300' } }, 2100);
  s.clock.at = 4100;
}

// --- the list ---

test('a slash lists the commands under the box, and each letter leaves fewer; Up and Down, or Ctrl-P and Ctrl-N, move through them and round the ends; nothing of the list stays in the conversation', () => {
  const s = stage(80, 24);
  settled(s);
  const before = s.all();
  s.type('/');
  expectFrame('commands-listed-80x24', s.all());
  expect(rows(s.live())).toEqual([
    '',
    `╭${'─'.repeat(77)}╮`,
    `│ › /${' '.repeat(73)}│`,
    `╰${'─'.repeat(77)}╯`,
    '  ▸ /help              the keys and commands',
    '    /image <path>      attach an image file from your machine',
    '    /stop              interrupt what the agent is doing now',
    '    /accept [commit]   accept the species commit the agent asked about, or the…',
    '    /tools             show or hide what each tool call returned',
    '    /generations       the generations this individual has lived in',
    ` Tab completes · Enter runs · Esc closes · Up/Down choose${' '.repeat(15)}1 of 12`,
  ]);
  // The cursor the owner sees is still in the box, after the slash.
  expect(s.term.vt.block).toEqual({ row: s.term.vt.cursor.row + 2, col: 5 });
  // Down past the sixth: the list moves with the choice. Up from the first goes to the last.
  s.type(DOWN.repeat(7));
  expect(listed(s)).toEqual(['/tools', '/generations', '/history', '[/offers]', '/approve', '/plain']);
  expect(rows(s.live()).at(-1)).toMatch(/ {3,}8 of 12$/);
  s.type(UP.repeat(8));
  expect(listed(s)).toEqual(['/history', '/offers', '/approve', '/plain', '/usage', '[/quit]']);
  s.type(DOWN);
  expect(listed(s).slice(0, 2)).toEqual(['[/help]', '/image']);
  s.type(`${CTRL_N}${CTRL_N}${CTRL_P}`);
  expect(listed(s).slice(0, 3)).toEqual(['/help', '[/image]', '/stop']);

  // A letter: fewer, and the choice starts from the top again.
  s.type('h');
  expect(rows(s.live()).slice(4)).toEqual([
    '  ▸ /help     the keys and commands',
    '    /history  print the earlier conversation that was read from the journal',
    ' Tab completes · Enter runs · Esc closes · Up/Down choose',
  ]);
  s.type(DOWN);
  expect(listed(s)).toEqual(['/help', '[/history]']);
  s.type('i');
  expect(listed(s)).toEqual(['[/history]']);
  // A letter no command goes on with: no list, and the footer is back.
  s.type('x');
  expect(listed(s)).toEqual([]);
  expect(rows(s.live()).at(-1)).toMatch(/^ gpt-6\.1-sol  resting/);
  s.type(BACKSPACE);
  expect(listed(s)).toEqual(['[/history]']);
  s.type(BACKSPACE.repeat(3));
  expect(typed(s)).toEqual(['›']);
  expect(listed(s)).toEqual([]);
  // The list was part of the live region only: the conversation above is what it was, and nothing was sent.
  expect(s.all().startsWith(before.slice(0, before.lastIndexOf('\n╭')))).toBe(true);
  expect(s.term.vt.all()).not.toMatch(/▸|Tab completes|\/generations/);
  expect(channel(s)).toEqual([]);
  expect(s.term.vt.alt).toBe(false);
  expect(s.term.vt.modes.has(1000) || s.term.vt.modes.has(1006)).toBe(false);
});

test('Tab completes the chosen command, with a blank after it when something may follow; without a list Tab is what it was', () => {
  const s = stage(80, 24);
  settled(s);
  s.type(`/h${DOWN}${TAB}`);
  expect(typed(s)).toEqual(['› /history']);
  // The whole name, and nothing follows it: it is still offered, alone, and Enter would run it.
  expect(listed(s)).toEqual(['[/history]']);
  expect(s.term.vt.block).toEqual({ row: s.term.vt.cursor.row + 2, col: 12 });
  s.type(`${CTRL_U}/im${TAB}`);
  expect(typed(s)).toEqual(['› /image']);
  expect(s.term.vt.block).toEqual({ row: s.term.vt.cursor.row + 2, col: 11 });
  expect(listed(s)).toEqual([]);
  // On a whole name Tab still adds the blank that what follows needs.
  s.type(`${CTRL_U}/approve`);
  expect(listed(s)).toEqual(['[/approve]']);
  s.type(TAB);
  expect(s.term.vt.block).toEqual({ row: s.term.vt.cursor.row + 2, col: 13 });
  expect(listed(s)).toEqual([]);
  s.type(`${CTRL_U}/ac${TAB}abc`);
  expect(typed(s)).toEqual(['› /accept abc']);
  // Nothing was run or sent by any of it.
  expect(s.all()).not.toMatch(/── \w|accepted|attaches an image/i);
  expect(channel(s)).toEqual([]);
  // Tab with no list open shows what tool calls returned, as before.
  s.type(TAB);
  expect(flowed(s)).toContain('From now on each tool call is shown with a few rows of what it returned.');
  expect(typed(s)).toEqual(['› /accept abc']);
});

test('Enter on a whole name runs it as before; on part of one it runs the chosen command when nothing follows one, and only completes it when something does or may', () => {
  const s = stage(90, 40);
  settled(s);
  // Part of a name, nothing follows the command: completed and run in one.
  s.type(`/pl${ENTER}`);
  expect(s.all()).toContain('./box talk --plain is the same conversation as plain text.');
  expect(typed(s)).toEqual(['›']);
  // The chosen one, not the first.
  s.type(`/h${DOWN}${ENTER}`);
  expect(flowed(s)).toContain('Nothing earlier was read from the journal.');
  expect(s.all()).not.toContain('── teneral talk');
  // Something has to follow /image: Enter completes, and waits for the path.
  s.type(`/i${ENTER}`);
  expect(typed(s)).toEqual(['› /image']);
  expect(rows(s.live()).at(-1)).toMatch(/^ gpt-6\.1-sol/);
  expect(s.all()).not.toContain('attaches an image file');
  // The whole name, as before this list was there: /image alone says what it wants.
  s.type(`${CTRL_U}/image${ENTER}`);
  expect(flowed(s)).toContain('/image <path> attaches an image file from your machine: /image ~/Pictures/plan.png');
  // Something may follow /accept: part of the name is only completed, and nothing is accepted by a slip of the hand.
  s.type(`/ac${ENTER}`);
  expect(typed(s)).toEqual(['› /accept']);
  expect(flowed(s)).not.toMatch(/accepted/i);
  s.type(ENTER);
  expect(flowed(s)).toMatch(/Not accepted: |That could not be accepted: /);
  expect(typed(s)).toEqual(['›']);
  // What the row under the list says Enter does is what it does.
  s.type('/a');
  expect(rows(s.live()).at(-1)).toBe(' Tab completes · Enter completes · Esc closes · Up/Down choose');
  s.type('ccept');
  expect(rows(s.live()).at(-1)).toBe(' Tab completes · Enter runs · Esc closes · Up/Down choose');
  s.type(`${CTRL_U}/q`);
  expect(rows(s.live()).at(-1)).toBe(' Tab completes · Enter runs · Esc closes · Up/Down choose');
  expect(channel(s)).toEqual([]);
  // Alt+Enter is a new line, list or no list; and a text of two lines is no command.
  s.type('\x1b\r');
  expect(typed(s)).toEqual(['› /q', '']);
  expect(listed(s)).toEqual([]);
  expect(s.app.closed).toBe(false);
  s.type(`${BACKSPACE}${ENTER}`);
  expect(s.app.closed).toBe(true);
});

test('every command in the table is carried out by the client, and none is sent to the agent', () => {
  for (const c of COMMANDS) {
    const s = stage(90, 40);
    settled(s);
    s.type(`${c.name}${takes(c) === 'required' ? ' 0000000' : ''}${ENTER}`);
    expect(typed(s)).toEqual(c.name === '/quit' ? [] : ['›']);
    expect(flowed(s)).not.toContain('is not a command here');
    expect(channel(s)).toEqual([]);
    expect(s.app.closed).toBe(c.name === '/quit');
  }
});

// --- Esc ---

test('Esc with the list open closes the list and nothing else: no interrupt goes out though the agent is working, and what was typed stays; with no list it interrupts as before', () => {
  const s = stage(90, 30, { name: 'Mica' });
  working(s);
  expect(s.live()).toMatch(new RegExp(`\\n${SPIN} Mica is running bash · 0:02 · esc to interrupt\\n╭`));
  s.type('/st');
  expectFrame('commands-while-working-90x30', s.all());
  expect(listed(s)).toEqual(['[/stop]']);
  // While the list is open the line over the box does not say Esc would interrupt, because it would not.
  expect(s.live()).toMatch(new RegExp(`\\n${SPIN} Mica is running bash · 0:02\\n╭`));
  expect(s.live()).toContain('Esc closes');
  s.type(ESC);
  expect(channel(s)).toEqual([]);
  expect(listed(s)).toEqual([]);
  expect(typed(s)).toEqual(['› /st']);
  expect(s.live()).toMatch(new RegExp(`\\n${SPIN} Mica is running bash · 0:02 · esc to interrupt\\n╭`));
  expect(s.all()).not.toMatch(/nothing to interrupt/);
  // Closed on this text, it stays closed: the arrows are the editor's again, and the next Esc is for the agent.
  s.type(`${UP}${DOWN}`);
  expect(listed(s)).toEqual([]);
  expect(typed(s)).toEqual(['› /st']);
  s.type(ESC);
  expect(channel(s)).toEqual([['.interrupt', '']]);
  expect(s.live()).toMatch(/Mica is running bash · 0:02 · interrupting …/);
  expect(typed(s)).toEqual(['› /st']);
  taken(s);
  // Another letter and the list is there again; so it is when the text comes back to what it was closed on.
  s.type('o');
  expect(listed(s)).toEqual(['[/stop]']);
  s.type(BACKSPACE);
  expect(listed(s)).toEqual(['[/stop]']);
  // Esc twice in one read: the first closes the list, the second is for the agent, and is not sent again while the first interrupt is unanswered.
  s.type(`${ESC}${ESC}`);
  expect(listed(s)).toEqual([]);
  expect(channel(s)).toEqual([]);
  expect(s.app.closed).toBe(false);
});

test('Esc with the list open while the agent rests closes it without a word; Esc alone in a read is told from an arrow that begins with its byte', async () => {
  const s = stage(90, 30);
  settled(s);
  s.type(`/h${ESC}`);
  expect(listed(s)).toEqual([]);
  expect(typed(s)).toEqual(['› /h']);
  expect(s.all()).not.toMatch(/nothing to interrupt/);
  s.type(ESC);
  expect(flowed(s)).toContain('The agent is not in the middle of anything: there is nothing to interrupt.');
  // An arrow cut in two by the terminal is an arrow: the list stays, and the choice moves.
  s.type(`${CTRL_U}/h`);
  s.term.type('\x1b');
  s.term.type('[B');
  await Bun.sleep(120);
  expect(listed(s)).toEqual(['/help', '[/history]']);
  // A lone ESC is the key once nothing followed it.
  s.term.type('\x1b');
  expect(listed(s)).toEqual(['/help', '[/history]']);
  await Bun.sleep(120);
  expect(listed(s)).toEqual([]);
  expect(typed(s)).toEqual(['› /h']);
});

// --- what is no command ---

test('a path, a slash later in the line, two slashes and a text of several lines are words: no list, the arrows and Tab are what they were, and Enter sends them', () => {
  const s = stage(90, 30);
  settled(s);
  s.say('first', 1100);
  s.say('second', 1200);
  s.journal({ type: 'assistant', text: 'Both read.', toolCalls: [] }, 1250);
  s.clock.at = 1300;
  // A path typed by hand: the list is there for its first letters only, as long as some command begins so.
  s.type('/h');
  expect(listed(s)).toEqual(['[/help]', '/history']);
  s.type('o');
  expect(listed(s)).toEqual([]);
  s.type('me/owner/notes.txt');
  expect(listed(s)).toEqual([]);
  s.type(ENTER);
  expect(channel(s)).toEqual([['.txt', '/home/owner/notes.txt']]);
  taken(s);
  expect(typed(s)).toEqual(['›']);
  // A slash further in: Up and Down walk through what was sent, as they always did.
  s.type('look at /h');
  expect(listed(s)).toEqual([]);
  s.type(UP);
  expect(typed(s)).toEqual(['› /home/owner/notes.txt']);
  // That line came from the history: it is not offered commands, and the arrows go on through the history.
  s.type(UP);
  expect(typed(s)).toEqual(['› second']);
  s.type(`${DOWN}${DOWN}`);
  expect(typed(s)).toEqual(['› look at /h']);
  s.type(ENTER);
  // Two slashes; and a slash with a blank after it.
  s.type('//h');
  expect(listed(s)).toEqual([]);
  s.type(`${CTRL_U}/ h`);
  expect(listed(s)).toEqual([]);
  s.type(ENTER);
  expect(channel(s).map(([, text]) => text)).toEqual(['look at /h', '/ h']);
  taken(s);
  // Pasted text of several lines that begins with a slash: all of it is in the box, nothing is offered, and Enter sends it whole.
  s.type(PASTE('/help\nis what I would type\n/quit too'));
  expect(typed(s)).toEqual(['› /help', '  is what I would type', '  /quit too']);
  expect(listed(s)).toEqual([]);
  s.type(ENTER);
  expect(channel(s)).toEqual([['.txt', '/help\nis what I would type\n/quit too']]);
  expect(s.app.closed).toBe(false);
  expect(s.all()).not.toMatch(/── teneral talk|is not a command/);
  // Part of a name pasted on one line is the same as typed.
  s.type(PASTE('/he'));
  expect(listed(s)).toEqual(['[/help]']);
});

test('a line from the history that looks like a command is shown as it is and not offered a list, so Up and Down still walk the history through it', () => {
  const s = stage(90, 30, { open: false });
  s.journal({ type: 'generation.started', commit: A }, -60_000);
  s.journal({ type: 'stimulus', source: 'terminal', text: 'older' }, -50_000);
  s.journal({ type: 'stimulus', source: 'terminal', text: '/he' }, -40_000);
  s.journal({ type: 'assistant', text: 'What is /he?', toolCalls: [] }, -30_000);
  s.app.open();
  s.type(UP);
  expect(typed(s)).toEqual(['› /he']);
  expect(listed(s)).toEqual([]);
  s.type(UP);
  expect(typed(s)).toEqual(['› older']);
  s.type(DOWN);
  expect(typed(s)).toEqual(['› /he']);
  // Once the owner changes it, it is their own line, and a command being named.
  s.type('l');
  expect(listed(s)).toEqual(['[/help]']);
});

// --- a mistake ---

test('a name that is no command is not sent and not thrown away: one line says so with the nearest command, and the text stays in the box to be put right', () => {
  const s = stage(90, 30);
  settled(s);
  s.type(`/hlep${ENTER}`);
  expectFrame('command-unknown-90x30', s.all());
  expect(flowed(s)).toContain('/hlep is not a command here, and was not sent. The nearest is /help. To send the line to the agent as your words, begin it with two slashes.');
  expect(typed(s)).toEqual(['› /hlep']);
  expect(channel(s)).toEqual([]);
  // Enter again says nothing more.
  s.type(ENTER);
  expect(s.all().match(/is not a command here/g)).toHaveLength(1);
  // Put right where it stands, and run.
  s.type(`${BACKSPACE.repeat(3)}elp${ENTER}`);
  expect(s.all()).toContain('── teneral talk');
  expect(typed(s)).toEqual(['›']);
  // With words after it: the same, and the nearest is shown with what follows it.
  s.type(`/imag ~/a.png${ENTER}`);
  expect(flowed(s)).toContain('/imag is not a command here, and was not sent. The nearest is /image <path>.');
  expect(typed(s)).toEqual(['› /imag ~/a.png']);
  s.type(`${CTRL_U}/nonsense at all${ENTER}`);
  expect(flowed(s)).toContain('/nonsense is not a command here, and was not sent. /help lists them.');
  // A command that takes nothing, with words after it, is neither run nor sent.
  s.type(`${CTRL_U}/quit smoking${ENTER}`);
  expect(flowed(s)).toContain('/quit takes nothing after it, so it was not run, and the line was not sent.');
  expect(s.app.closed).toBe(false);
  expect(typed(s)).toEqual(['› /quit smoking']);
  expect(channel(s)).toEqual([]);
});

test('two slashes send a line that begins with one: the agent gets it with a single slash, and Up brings back what was typed', () => {
  const s = stage(90, 30);
  settled(s);
  s.type(`//quit smoking, it said${ENTER}`);
  expect(channel(s)).toEqual([['.txt', '/quit smoking, it said']]);
  expect(s.app.closed).toBe(false);
  expect(s.live()).toContain('› /quit smoking, it said  on its way');
  taken(s);
  s.type(`//help${ENTER}`);
  expect(channel(s)).toEqual([['.txt', '/help']]);
  expect(s.all()).not.toContain('── teneral talk');
  s.type(UP);
  expect(typed(s)).toEqual(['› //help']);
  s.type(UP);
  expect(typed(s)).toEqual(['› //quit smoking, it said']);
  // /help says how.
  s.type(`${CTRL_U}/help${ENTER}`);
  expect(flowed(s)).toContain('To send the agent a line that begins with a slash, begin it with two: //like this arrives as /like this.');
});

// --- colours ---

test('the name is coloured as it is typed: set back while it is part of one, the owner\'s colour once it is a command, a warning when it is none; a path has no colour at all', () => {
  const s = stage(90, 30);
  settled(s);
  const from = () => s.term.written.length;
  const since = (at: number): string => s.term.written.slice(at).join('');
  let at = from();
  s.type('/he');
  expect(since(at)).toContain('\x1b[38;2;138;134;128m/he\x1b[0m');
  at = from();
  s.type('lp');
  expect(since(at)).toContain('\x1b[1;38;2;122;162;204m/help\x1b[0m');
  at = from();
  s.type('x');
  expect(since(at)).toContain('\x1b[38;2;222;110;88m/helpx\x1b[0m');
  at = from();
  s.type(`${CTRL_U}/image ~/日本語.png`);
  expect(since(at)).toContain('\x1b[1;38;2;122;162;204m/image\x1b[0m ~/日本語.png');
  at = from();
  s.type(`${CTRL_U}/home/owner/a.png and /help`);
  expect(since(at)).toContain('/home/owner/a.png and /help');
  expect(since(at)).not.toMatch(/\x1b\[[1-9][0-9;]*m\/h/);
  // Without colours the command is still set apart, by weight; and there is still not one colour code.
  const plain = stage(90, 30, { caps: { depth: 'none' } });
  settled(plain);
  plain.type('/help');
  expect(plain.term.written.join('')).toContain('\x1b[1m/help\x1b[0m');
  expect(plain.term.written.join('')).not.toMatch(/\x1b\[[0-9;]*38;/);
});

// --- the screen ---

test('at 40, 80 and 120 columns the list fits the width, its rows cut with a mark, and nothing reaches the last column', () => {
  for (const cols of [40, 80, 120]) {
    const s = stage(cols, 30);
    settled(s);
    s.type('/');
    if (cols !== 80) expectFrame(`commands-listed-${cols}x30`, s.all());
    const live = rows(s.live());
    expect(listed(s)).toEqual(['[/help]', '/image', '/stop', '/accept', '/tools', '/generations']);
    for (const row of live) expect([...row].length).toBeLessThanOrEqual(cols - 1);
    expect(live.at(-1)).toMatch(/^ Tab completes · Enter runs.* {3,}1 of 12$/);
    expect(live[7]).toBe(cols === 40 ? '    /accept [commit]   accept the spec…' : cols === 80 ? '    /accept [commit]   accept the species commit the agent asked about, or the…' : '    /accept [commit]   accept the species commit the agent asked about, or the one named');
    s.type(`a${TAB}`);
    expect(typed(s)).toEqual(['› /accept']);
  }
});

test('resize while the list is open: it is drawn anew at each size with the same choice, and nothing of the old one is left behind, in a terminal that cuts rows and in one that wraps them again', () => {
  for (const reflow of [false, true]) {
    const s = stage(100, 30, { reflow });
    settled(s);
    s.type(`/${DOWN}${DOWN}`);
    const sizes = reflow ? [[80, 30], [60, 26], [44, 24], [72, 24], [120, 40], [80, 24]] as const : [[60, 24], [40, 10], [120, 40], [40, 24], [30, 6], [80, 24]] as const;
    for (const [cols, height] of sizes) {
      s.term.resize(cols, height);
      const live = rows(s.live());
      if (cols === 60) expectFrame(reflow ? 'commands-resized-rewrapped-60x26' : 'commands-resized-60x24', s.term.vt.all());
      expect(live.length).toBeLessThanOrEqual(Math.max(3, height / 2));
      for (const row of live) expect([...row].length).toBeLessThanOrEqual(cols - 1);
      // One list, with the command that was chosen still chosen, and the row typed on with its cursor.
      expect(listed(s).filter((name) => name.startsWith('['))).toEqual(['[/stop]']);
      expect(s.term.vt.block).not.toBeNull();
      if (height >= 24) {
        expect(listed(s)).toEqual(['/help', '/image', '[/stop]', '/accept', '/tools', '/generations']);
        expect(live.filter((row) => row.startsWith('╭'))).toEqual([`╭${'─'.repeat(cols - 3)}╮`]);
        expect(live.filter((row) => row.includes('Tab completes'))).toHaveLength(1);
      }
      // Above the live region, from where the conversation begins: nothing that was ever part of one.
      const whole = rows(s.term.vt.all()).slice(0, -live.length);
      const above = whole.slice(whole.findIndex((row) => row.includes('the birth letter')));
      expect(above.length).toBeGreaterThan(3);
      expect(above.filter((row) => /▸|\/[a-z]{4}|Tab completes|^╭|^╰|^│/.test(row))).toEqual([]);
      expect(s.term.vt.cursor.col).toBe(0);
    }
    // And the list still answers the keys.
    s.type(ENTER);
    expect(flowed(s)).toContain('The agent is not in the middle of anything: there is nothing to interrupt.');
    expect(listed(s)).toEqual([]);
    expect(s.term.vt.all()).not.toMatch(/▸|Tab completes/);
  }
});

test('on a low screen fewer commands are shown and the list still follows the choice', () => {
  const s = stage(60, 10);
  settled(s);
  s.type('/');
  expect(rows(s.live())).toEqual([
    `╭${'─'.repeat(57)}╮`,
    `│ › /${' '.repeat(53)}│`,
    `╰${'─'.repeat(57)}╯`,
    '  ▸ /help              the keys and commands',
    '    /image <path>      attach an image file from your mach…',
  ]);
  for (let i = 1; i < COMMANDS.length; i++) {
    s.type(DOWN);
    expect(listed(s)).toHaveLength(2);
    expect(listed(s)).toContain(`[${COMMANDS[i]!.name}]`);
  }
  s.type(ENTER);
  expect(s.app.closed).toBe(true);
});

test('with images attached the list stands under the box that holds them, and a command run leaves them attached', () => {
  const s = stage(90, 30);
  settled(s);
  const file = join(s.p.root, 'plan.png');
  writeFileSync(file, png(640, 480));
  s.type(`/image ${file}${ENTER}`);
  expect(typed(s)).toEqual([expect.stringMatching(/^\[image 1 · png · 640×480 · \d+ B\]$/), '›']);
  s.type('/to');
  expectFrame('commands-with-image-90x30', s.all());
  expect(rows(s.live()).slice(1)).toEqual([
    `╭${'─'.repeat(87)}╮`,
    expect.stringMatching(/^│ \[image 1 · png · 640×480 · \d+ B\] +│$/),
    `│ › /to${' '.repeat(81)}│`,
    `╰${'─'.repeat(87)}╯`,
    '  ▸ /tools  show or hide what each tool call returned',
    ' Tab completes · Enter runs · Esc closes · Up/Down choose',
  ]);
  s.type(ENTER);
  expect(flowed(s)).toContain('From now on each tool call is shown');
  expect(typed(s)).toEqual([expect.stringMatching(/^\[image 1/), '›']);
  expect(rows(s.live()).at(-1)).toMatch(/ attached: image 1/);
});

test('a locale that is not UTF-8 gets the list in ASCII', () => {
  const s = stage(80, 24, { caps: { utf8: false } });
  settled(s);
  s.type('/h');
  expect(s.live()).toMatch(/^[\x20-\x7e\n]*$/);
  expect(rows(s.live()).slice(-3)).toEqual([
    '  > /help     the keys and commands',
    '    /history  print the earlier conversation that was read from the journal',
    ' Tab completes | Enter runs | Esc closes | Up/Down choose',
  ]);
});
