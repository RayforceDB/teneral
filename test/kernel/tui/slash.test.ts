import { expect, test } from 'bun:test';
import { COMMANDS, commandNamed } from '../../../kernel/commands';
import { pathsIn } from '../../../kernel/tui/images';
import { complete, entered, mark, matching, offer, typed, windowStart } from '../../../kernel/tui/slash';

// --- what is typed, read as a command or as words ---

const names = (text: string, cursor = text.length): string[] | null => offer(text, cursor)?.matches.map((c) => c.name) ?? null;

test('a command line is a slash, letters, and what follows a blank on the same line; a path, two slashes, capitals or a second line make it words', () => {
  expect(typed('/')).toEqual({ from: 0, to: 1, name: '/', rest: null });
  expect(typed('/he')).toEqual({ from: 0, to: 3, name: '/he', rest: null });
  expect(typed('/image ')).toEqual({ from: 0, to: 6, name: '/image', rest: '' });
  expect(typed('/image  ~/a b.png  ')).toEqual({ from: 0, to: 6, name: '/image', rest: '~/a b.png' });
  expect(typed('  /stop')).toEqual({ from: 2, to: 7, name: '/stop', rest: null });
  expect(typed('/help\n')).toEqual({ from: 0, to: 5, name: '/help', rest: null });
  for (const words of ['', 'hello', 'look at /help', 'a/b', '/home/owner/file.png', '/home/owner/My Pictures/a.png', '~/a.png', '/a.png', '//help', '/Help', '/a1', '/help\nplease', '/image a.png\nand this', 'x\n/help', '/помощь', '/-']) {
    expect(typed(words)).toBeNull();
  }
});

test('commands are offered while the cursor is in the word that names one: all of them after the slash, fewer with each letter, none once the word is over', () => {
  expect(names('/')).toEqual(COMMANDS.map((c) => c.name));
  expect(names('/h')).toEqual(['/help', '/history']);
  expect(names('/hi')).toEqual(['/history']);
  expect(names('/a')).toEqual(['/accept', '/approve']);
  expect(names('/help')).toEqual(['/help']);
  expect(names('  /q')).toEqual(['/quit']);
  // No command begins so; the word is finished; the cursor has left it.
  expect(names('/x')).toBeNull();
  expect(names('/help ')).toBeNull();
  expect(names('/image ~/a.png')).toBeNull();
  expect(names('/he', 0)).toBeNull();
  expect(names('  /he', 2)).toBeNull();
  expect(names('/he', 1)).toEqual(['/help']);
  expect(names('/help\n', 6)).toBeNull();
  // What is no command line offers nothing, wherever the cursor is.
  for (const words of ['hello /', '/home/owner/a.png', '//h', '/h\nmore', '/H']) for (let at = 0; at <= words.length; at++) expect(names(words, at)).toBeNull();
  expect(matching('/')).toHaveLength(COMMANDS.length);
});

test('completing puts the whole name where the word was, with a blank after it only when something may follow, and the cursor after that', () => {
  const done = (text: string, name: string) => complete(text, typed(text)!, commandNamed(name)!);
  expect(done('/h', '/help')).toEqual({ text: '/help', cursor: 5 });
  expect(done('/', '/image')).toEqual({ text: '/image ', cursor: 7 });
  expect(done('/ac', '/accept')).toEqual({ text: '/accept ', cursor: 8 });
  expect(done('  /ap', '/approve')).toEqual({ text: '  /approve ', cursor: 11 });
  expect(done('/q\n', '/quit')).toEqual({ text: '/quit\n', cursor: 5 });
});

test('the command word is marked for colouring: a command in the owner\'s colour, one still being typed set back, what Enter would refuse as a mistake, and words not at all', () => {
  const style = (text: string) => mark(text)?.style ?? null;
  expect(mark('/help')).toEqual({ from: 0, to: 5, style: { fg: 'accent', bold: true } });
  expect(mark('  /image ~/a.png')).toEqual({ from: 2, to: 8, style: { fg: 'accent', bold: true } });
  expect(style('/accept')).toEqual({ fg: 'accent', bold: true });
  expect(style('/accept abc1234')).toEqual({ fg: 'accent', bold: true });
  expect(style('/help ')).toEqual({ fg: 'accent', bold: true });
  expect(style('/')).toEqual({ fg: 'dim' });
  expect(style('/he')).toEqual({ fg: 'dim' });
  expect(style('/hx')).toEqual({ fg: 'warn' });
  expect(style('/he me')).toEqual({ fg: 'warn' });
  expect(style('/help me')).toEqual({ fg: 'warn' });
  for (const words of ['hello', 'see /help', '/home/owner/a.png', '//help', '/help\nme', '/ a', '/ ', '']) expect(mark(words)).toBeNull();
});

test('Enter: a command with what follows it; words as they are; and a line shaped like a command that is none is refused, with the nearest name', () => {
  expect(entered('/help')).toEqual({ kind: 'command', command: commandNamed('/help')!, arg: '' });
  expect(entered('/image  ~/My Pictures/a.png')).toEqual({ kind: 'command', command: commandNamed('/image')!, arg: '~/My Pictures/a.png' });
  expect(entered('/image')).toEqual({ kind: 'command', command: commandNamed('/image')!, arg: '' });
  expect(entered('/accept abc1234')).toEqual({ kind: 'command', command: commandNamed('/accept')!, arg: 'abc1234' });
  for (const words of ['hello', 'what is in /help?', '/teneral/body is where you live', '/home/owner/a.png', '/Help', '/help\nplease', '/ a', '/']) {
    expect(entered(words)).toEqual({ kind: 'words', text: words });
  }
  const why = (line: string) => {
    const e = entered(line);
    return e.kind === 'refused' ? e.why : e.kind;
  };
  const escape = 'To send the line to the agent as your words, begin it with two slashes.';
  expect(why('/hlep')).toBe(`/hlep is not a command here, and was not sent. The nearest is /help. ${escape}`);
  expect(why('/imag ~/a.png')).toBe(`/imag is not a command here, and was not sent. The nearest is /image <path>. ${escape}`);
  expect(why('/nonsense at all')).toBe(`/nonsense is not a command here, and was not sent. /help lists them. ${escape}`);
  expect(why('/stop doing that')).toBe(`/stop takes nothing after it, so it was not run, and the line was not sent. ${escape}`);
});

test('two slashes send the line with one, whatever it would have been: a command\'s name, a mistake, or a path', () => {
  expect(entered('//help')).toEqual({ kind: 'words', text: '/help' });
  expect(entered('//stop doing that')).toEqual({ kind: 'words', text: '/stop doing that' });
  expect(entered('//nonsense')).toEqual({ kind: 'words', text: '/nonsense' });
  expect(entered('//home/owner/a.png')).toEqual({ kind: 'words', text: '/home/owner/a.png' });
  expect(entered('// a comment')).toEqual({ kind: 'words', text: '/ a comment' });
});

test('a file\'s path, as a terminal types it when a file is dragged in, is never a command line, so what attaches images still sees it', () => {
  for (const path of ['/home/owner/photo.png', '\'/home/owner/My Pictures/photo 1.jpg\' ', '/home/owner/My\\ Pictures/a.png', 'file:///home/owner/anim.gif', '~/a.png', '/tmp/a.png /tmp/b.png']) {
    expect(pathsIn(path)).not.toBeNull();
    expect(typed(path)).toBeNull();
    expect(mark(path)).toBeNull();
    for (let at = 0; at <= path.length; at++) expect(offer(path, at)).toBeNull();
    expect(entered(path.trim())).toEqual({ kind: 'words', text: path.trim() });
  }
});

test('of more commands than there are rows, the ones around the chosen one are shown, and the first and the last stay at the edges', () => {
  expect(windowStart(11, 0, 6)).toBe(0);
  expect(windowStart(11, 3, 6)).toBe(0);
  expect(windowStart(11, 4, 6)).toBe(1);
  expect(windowStart(11, 7, 6)).toBe(4);
  expect(windowStart(11, 10, 6)).toBe(5);
  expect(windowStart(2, 1, 6)).toBe(0);
  expect(windowStart(11, 10, 1)).toBe(10);
  for (let rows = 1; rows <= 12; rows++) {
    for (let chosen = 0; chosen < 11; chosen++) {
      const start = windowStart(11, chosen, rows);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(chosen).toBeGreaterThanOrEqual(start);
      expect(chosen).toBeLessThan(start + rows);
    }
  }
});
