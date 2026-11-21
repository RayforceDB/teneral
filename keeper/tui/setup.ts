import { CHATGPT_USAGE_URL, PROVIDERS, type ProviderEntry } from '../../brain/providers';
import type { GithubAccount } from '../github';
import { GITHUB_HOW, GITHUB_OWN, GITHUB_WHY, NEEDS_CALLBACK, NEXT_STEP, PLAN_NOTICE, accountFacts, githubLine, setup, type Dialogue, type GithubOutcome, type ModelChoice, type SetupOptions, type TestResult, type TestStep } from '../setup';
import { EMPTY, edit, layout, type Edit } from './editor';
import { KeyParser, type Key } from './keys';
import { Lifeline, Screen, flowHeight, terminal, type Row, type Term } from './screen';
import { clean, clip, width as cells, wrap, type Line } from './text';
import { SPIN_MS, glyphs, type Glyphs, type Style } from './theme';
import { duration, elapsed } from './view';

// The setup as screens: the steps of keeper/setup.ts, one page at a time. The dialogue itself,
// its order and every decision in it, stays in keeper/setup.ts; this file only shows a step and
// brings back the owner's answer. A key or a token is never drawn.

const DIM: Style = { fg: 'dim' };
const WARN: Style = { fg: 'warn' };
const BOLD: Style = { bold: true };
const GOOD: Style = { fg: 'good' };
const ACCENT: Style = { fg: 'accent', bold: true };

/** The stages of the setup, as the top of every page names them. */
type Stage = 'model' | 'github' | 'ready';
const STAGE_NAME: Record<Stage, string> = { model: 'Model', github: 'GitHub', ready: 'Ready' };
/** Text is not set wider than this, however wide the terminal. */
const MEASURE = 78;

interface Page {
  rows: Row[];
  /** The keys that matter, the most needed first. On a narrow screen the later ones go, never the first. */
  hint: string[];
  cursor?: { row: number; col: number };
  /** The row that must stay in view when the page is taller than the screen. Default: the cursor's, else the first. */
  focus?: number;
}

interface Option {
  label: string;
  /** Shown under the option while it is the one pointed at. */
  detail?: readonly string[];
  /** A letter that chooses it at once. */
  key?: string;
}

/**
 * A line of the test's result with the provider's answer made readable: where it ends in the JSON
 * of an error, the message in it (and its code) stands in for the JSON. Anything else stays as it is.
 */
export function readable(line: string): string {
  const m = /^(.*?)(\{.*\})\s*$/s.exec(line);
  if (!m) return line;
  try {
    const body = JSON.parse(m[2]!) as { error?: unknown; message?: unknown };
    const inner = typeof body.error === 'object' && body.error !== null ? body.error as { message?: unknown; code?: unknown } : null;
    const said = inner?.message ?? body.message ?? (typeof body.error === 'string' ? body.error : undefined);
    if (typeof said !== 'string' || said === '') return line;
    return `${m[1]}${said}${typeof inner?.code === 'string' ? ` (${inner.code})` : ''}`;
  } catch {
    return line;
  }
}

const isCtrl = (key: Key, name: string): boolean => key.kind === 'key' && key.ctrl === true && key.name === name;
const isKey = (key: Key, name: string): boolean => key.kind === 'key' && key.name === name && !key.ctrl && !key.alt;

export interface SetupScreenOptions {
  /** `one` starts the agent right after this setup: the last page says so instead of naming the command. */
  thenStart?: boolean;
  /** The stages this run goes through, for the trail at the top. Default: the model, then ready. */
  stages?: readonly Stage[];
  now?: () => number;
  /**
   * Ctrl-C while nothing is asked, in the middle of a request, or the terminal gone for good:
   * there is no answer to give back, so the caller ends the program.
   */
  abort?: () => void;
  /** How often the terminal is asked whether it is still there. Default 15 s. */
  lifelineMs?: number;
}

export class SetupScreens implements Dialogue {
  private readonly screen: Screen;
  private readonly parser = new KeyParser();
  private readonly now: () => number;
  private readonly g: Glyphs;
  private readonly lifeline: Lifeline;
  private render: () => Page = () => ({ rows: [], hint: [] });
  /** Whoever waits for the next key. */
  private pending: ((key: Key | null) => void) | null = null;
  /** A question is being asked; keys that arrive faster than it takes them wait here. */
  private asking = false;
  private queue: Key[] = [];
  /** Takes keys while nothing is asked: the wait for the sign-in. */
  private background: ((key: Key) => void) | null = null;
  private ended = false;
  private open = false;
  private stops: (() => void)[] = [];
  private escape: ReturnType<typeof setTimeout> | undefined;
  /** Lines for the ordinary screen, printed once this one is left. */
  private after: string[] = [];

  private readonly stages: readonly Stage[];
  private stage: Stage;
  private welcomed = false;
  /** Why the last answer could not be used. Shown with the question when it comes again. */
  private trouble = '';
  /** What is settled so far and worth keeping in view: who is signed in, whose plan pays. */
  private facts: string[] = [];
  private offered: ModelChoice[] = [];
  private listed = 0;
  private test: { provider: string; model: string; steps: Record<TestStep, { state: 'waiting' | 'asking' | 'ok' | 'failed'; ms: number; since: number }>; result: TestResult | null } | null = null;

  constructor(private readonly term: Term, private readonly o: SetupScreenOptions = {}) {
    this.screen = new Screen(term);
    this.stages = o.stages ?? ['model', 'ready'];
    this.stage = this.stages[0]!;
    this.now = o.now ?? Date.now;
    this.g = glyphs(term.caps.utf8);
    // A setup nobody can answer any more must not sit there holding the sign-in's port.
    this.lifeline = new Lifeline(term, () => this.o.abort?.(), o.lifelineMs);
  }

  /** Take the screen. */
  start(): void {
    if (this.open) return;
    this.open = true;
    this.screen.enter();
    const ticker = setInterval(() => this.paint(), SPIN_MS);
    this.stops.push(
      this.term.listen((text) => this.input(text), () => { this.ended = true; this.pending?.(null); }),
      this.term.onResize(() => this.paint()),
      () => clearInterval(ticker),
      () => this.lifeline.stop(),
    );
    this.lifeline.start();
    this.working('one moment');
  }

  /** Give the terminal back, and say on it what is worth keeping. `keep`: stay on the alternate screen for the run that follows at once. */
  close(keep = false): void {
    if (!this.open) return;
    this.open = false;
    clearTimeout(this.escape);
    for (const stop of this.stops) stop();
    this.screen.leave(keep);
    // With a carriage return of its own: whether the terminal adds one is not this program's to rely on.
    if (this.after.length > 0) this.term.write(`${this.after.join('\r\n')}\r\n`);
    this.after = [];
  }

  // --- keys ---

  private input(text: string): void {
    clearTimeout(this.escape);
    for (const key of this.parser.feed(text)) this.dispatch(key);
    if (this.parser.pending) this.escape = setTimeout(() => this.settle(), 40);
  }

  /** What the key parser still holds back counts as pressed: a lone ESC is the Escape key. */
  settle(): void {
    clearTimeout(this.escape);
    for (const key of this.parser.flush()) this.dispatch(key);
  }

  private dispatch(key: Key): void {
    if (key.kind === 'alive') return this.lifeline.heard();
    if (this.pending !== null) {
      const waiter = this.pending;
      this.pending = null;
      waiter(key);
    } else if (this.asking) {
      this.queue.push(key);
    } else if (this.background !== null) {
      this.background(key);
    } else if (isCtrl(key, 'c')) {
      this.o.abort?.();
    }
  }

  private nextKey(): Promise<Key | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => { this.pending = resolve; });
  }

  /** Show a page and take keys until one of them settles it. Null: the owner stopped, or is gone. */
  private async ask<T>(render: () => Page, onKey: (key: Key) => T | undefined, then = 'one moment'): Promise<T | null> {
    this.background = null;
    this.asking = true;
    try {
      for (;;) {
        this.show(render);
        const key = await this.nextKey();
        if (key === null || isCtrl(key, 'c')) return null;
        const answer = onKey(key);
        if (answer !== undefined) {
          this.working(then);
          return answer;
        }
      }
    } finally {
      // What was typed ahead of the next question is not an answer to it.
      this.asking = false;
      this.queue = [];
    }
  }

  // --- drawing ---

  private show(render: () => Page): void {
    this.render = render;
    this.paint();
  }

  private paint(): void {
    if (!this.open) return;
    const { cols, rows } = this.term.size();
    const page = this.render();
    const head = this.head(cols);
    const rule: Line = [{ text: ` ${this.g.rule.repeat(Math.max(1, Math.floor((cols - 2) / cells(this.g.rule))))}`, style: DIM }];
    // The name, a rule and a blank row above the page; a rule and the keys under it. A small window keeps its rows for the page.
    const framed = rows >= 24;
    const room = Math.max(1, rows - (framed ? 5 : 3));
    const height = (row: Row): number => (Array.isArray(row) ? 1 : flowHeight(row, cols));
    const tall = (list: { row: Row }[]): number => list.reduce((sum, { row }) => sum + height(row), 0);
    // A page taller than the screen first gives up its blank rows, then shows the part around its focus.
    let kept = page.rows.map((row, at) => ({ row, at }));
    if (tall(kept) > room) kept = kept.filter(({ row }) => !Array.isArray(row) || row.length > 0);
    if (tall(kept) > room) {
      const focus = page.focus ?? page.cursor?.row ?? 0;
      const last = Math.max(0, kept.findLastIndex(({ at }) => at <= focus));
      if (tall(kept.slice(0, last + 1)) > room) {
        // The title stays; under it, the rows that end at the focus.
        let from = last;
        while (from > 1 && tall(kept.slice(from - 1, last + 1)) < room) from -= 1;
        kept = [kept[0]!, ...kept.slice(Math.max(1, from))];
      }
    }
    const body: Row[] = [];
    let used = 0;
    let cursor: { row: number; col: number } | null = null;
    for (const { row, at } of kept) {
      if (used + height(row) > room) break;
      if (page.cursor && page.cursor.row === at) cursor = { row: used + (framed ? 3 : 2), col: page.cursor.col };
      body.push(row);
      used += height(row);
    }
    const pad: Line[] = Array.from({ length: room - used }, () => []);
    let parts = page.hint;
    while (parts.length > 1 && parts.join(` ${this.g.sep} `).length + 2 > cols) parts = parts.slice(0, -1);
    const hint = clip([{ text: ` ${parts.join(` ${this.g.sep} `)}`, style: DIM }], cols, { text: this.g.ellipsis, style: DIM });
    this.screen.paint({ rows: framed ? [head, rule, [], ...body, ...pad, rule, hint] : [head, [], ...body, ...pad, hint], cursor });
  }

  /** The first row: whose setup this is and, where there is room, the stages with the one in hand marked. */
  private head(cols: number): Line {
    const name: Line = [{ text: ' teneral', style: ACCENT }, { text: '  setup', style: DIM }];
    const at = this.stages.indexOf(this.stage);
    const trail: Line = [];
    this.stages.forEach((stage, i) => {
      if (i > 0) trail.push({ text: ` ${this.g.rule.repeat(Math.max(1, Math.floor(2 / cells(this.g.rule))))} `, style: DIM });
      if (i < at) trail.push({ text: `${this.g.ok} `, style: GOOD }, { text: STAGE_NAME[stage], style: DIM });
      else if (i === at) trail.push({ text: `${this.g.reply} `, style: ACCENT }, { text: STAGE_NAME[stage], style: BOLD });
      else trail.push({ text: `${this.g.reasoning} ${STAGE_NAME[stage]}`, style: DIM });
    });
    const wide = (line: Line): number => line.reduce((sum, span) => sum + cells(span.text), 0);
    const gap = cols - wide(name) - wide(trail) - 1;
    return gap >= 3 && at !== -1 ? [...name, { text: ' '.repeat(gap) }, ...trail] : name;
  }

  private width(): number {
    return Math.max(8, Math.min(MEASURE, this.term.size().cols - 2));
  }

  private para(text: string, style?: Style, indent = 2): Line[] {
    const lead: Line = [{ text: ' '.repeat(indent) }];
    return clean(text).split('\n').flatMap((line) => wrap([{ text: line, style }], this.width(), lead));
  }

  private spinner(): Line {
    return [{ text: `  ${this.g.spinner[Math.floor(this.now() / SPIN_MS) % this.g.spinner.length]} `, style: { fg: 'accent' } }];
  }

  /** The top of every page: its title, and under it what is settled so far. */
  private top(title: string): Row[] {
    const rows: Row[] = [[{ text: `  ${title}`, style: BOLD }], []];
    // The first is what was done; what follows it is said about it.
    this.facts.forEach((fact, i) => rows.push(...(i === 0 ? this.marked(fact) : this.para(fact, DIM, 4)), []));
    return rows;
  }

  /** A paragraph with a check mark before it: something that is settled. */
  private marked(text: string, mark = this.g.ok, tone: Style = GOOD): Line[] {
    const lines = this.para(text, DIM, 4);
    if (lines.length > 0) lines[0] = [{ text: `  ${mark} `, style: tone }, ...lines[0]!.slice(1)];
    return lines;
  }

  /** The rows under the option pointed at, set off by a bar down their left. */
  private aside(text: readonly string[], indent: number): Line[] {
    const lead: Line = [{ text: `${' '.repeat(indent)}${this.g.bar} `, style: DIM }];
    return text.flatMap((line) => wrap([{ text: clean(line), style: DIM }], this.width(), lead));
  }

  /** A few characters to be read and typed elsewhere, in a frame of their own. */
  private boxed(text: string): Line[] {
    const [tl, tr, bl, br] = this.g.corners;
    const inner = `   ${text}   `;
    const side = this.g.rule.repeat(Math.ceil(cells(inner) / cells(this.g.rule)));
    return [
      [{ text: `  ${tl}${side}${tr}`, style: DIM }],
      [{ text: `  ${this.g.bar}`, style: DIM }, { text: inner, style: ACCENT }, { text: this.g.bar, style: DIM }],
      [{ text: `  ${bl}${side}${br}`, style: DIM }],
    ];
  }

  private problemRows(): Row[] {
    return this.trouble === '' ? [] : [...this.para(`${this.trouble}; once more.`, WARN), []];
  }

  /** Between two questions, while a request is under way. */
  private working(what: string): void {
    const since = this.now();
    this.background = null;
    this.show(() => ({ rows: [...this.top('One moment'), [...this.spinner(), { text: what }, { text: ` ${this.g.sep} ${elapsed(this.now() - since)}`, style: DIM }]], hint: ['Ctrl-C stops'] }));
  }

  private choose(title: string, intro: string[], options: Option[], initial = 0, then?: string): Promise<number | null> {
    let at = initial;
    const render = (): Page => {
      const rows: Row[] = [...this.top(title)];
      for (const text of intro) rows.push(...this.para(text), []);
      let focus = 0;
      options.forEach((option, i) => {
        const here = i === at;
        rows.push([
          { text: here ? `  ${this.g.pointer} ` : '    ', style: { fg: 'accent', bold: true } },
          { text: `${i + 1}  `, style: DIM },
          { text: option.label, style: here ? BOLD : undefined },
        ]);
        if (here && option.detail) rows.push(...this.aside(option.detail, 7), []);
        if (here) focus = rows.length - 1;
      });
      const letters = options.filter((option) => option.key).map((option) => option.key).join(', ');
      return { rows, focus, hint: ['Enter confirms', 'Up/Down choose', 'Ctrl-C stops', `or press ${letters === '' ? `1-${options.length}` : letters}`] };
    };
    return this.ask(render, (key) => {
      if (isKey(key, 'up')) at = Math.max(0, at - 1);
      else if (isKey(key, 'down')) at = Math.min(options.length - 1, at + 1);
      else if (isKey(key, 'enter')) return at;
      else if (key.kind === 'text') {
        const n = Number(key.text);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
        const byKey = options.findIndex((option) => option.key === key.text.toLowerCase());
        if (byKey !== -1) return byKey;
      }
      return undefined;
    }, then);
  }

  /** One line of text from the owner. `hidden`: a mark per character is shown, never the characters. */
  private type(title: string, intro: string[], hidden: boolean, then?: string): Promise<string | null> {
    let line: Edit = EMPTY;
    const render = (): Page => {
      const rows: Row[] = [...this.top(title)];
      for (const text of intro) rows.push(...this.para(text), []);
      rows.push(...this.problemRows());
      const cols = this.term.size().cols;
      const mark: Line = [{ text: `  ${this.g.prompt} `, style: { fg: 'accent', bold: true } }];
      if (hidden) {
        const dots = Math.min([...line.text].length, Math.max(1, cols - 6));
        rows.push([...mark, { text: this.g.hidden.repeat(dots), style: DIM }]);
        return { rows, hint: ['Enter confirms', 'Ctrl-C stops', 'what you type is not shown'], cursor: { row: rows.length - 1, col: 4 + dots } };
      }
      const laid = layout(line.text, line.cursor, Math.max(2, cols - 5), 1);
      rows.push([...mark, { text: laid.rows[0] ?? '' }]);
      return { rows, hint: ['Enter confirms', 'Ctrl-C stops'], cursor: { row: rows.length - 1, col: 4 + laid.col } };
    };
    return this.ask(render, (key) => {
      if (isKey(key, 'enter')) {
        this.trouble = '';
        return line.text;
      }
      // One line only: a pasted line break ends nothing and is not kept.
      const flat: Key = key.kind === 'paste' ? { kind: 'paste', text: key.text.replace(/\n/g, '') } : key;
      if (flat.kind === 'key' && (flat.name === 'up' || flat.name === 'down' || flat.name === 'j')) return undefined;
      line = edit(line, flat) ?? line;
      return undefined;
    }, then);
  }

  // --- the steps of the dialogue ---

  welcome(): void {
    this.welcomed = true;
  }

  /** What the first page opens with. */
  private greeting(): string[] {
    if (!this.welcomed) return [];
    this.welcomed = false;
    return ['This sets up where the agent\'s model comes from: you choose a provider, give it a key or sign in, and two test requests are made. Nothing is written until they have worked.'];
  }

  async replace(provider: string, model: string): Promise<boolean | null> {
    const intro = [...this.greeting(), `There is a configuration already (.env): ${provider}, model ${model}.`];
    const chosen = await this.choose('Welcome', intro, [
      { label: 'Keep it', key: 'n' },
      { label: 'Replace it', key: 'y', detail: ['Its other settings are kept. Nothing changes until the new one has passed its test.'] },
    ]);
    return chosen === null ? null : chosen === 1;
  }

  kept(): void {
    this.after.push('Left as it is.');
    this.close();
  }

  async provider(): Promise<ProviderEntry | null> {
    const intro = this.greeting();
    const chosen = await this.choose(intro.length > 0 ? 'Welcome' : 'Where the model comes from', [...intro, ...(intro.length > 0 ? ['Where does the model come from?'] : [])],
      PROVIDERS.map((p) => ({ label: p.name, detail: p.notes })));
    return chosen === null ? null : PROVIDERS[chosen]!;
  }

  baseUrl(): Promise<string | null> {
    return this.type('The endpoint', ['Base URL of the endpoint, such as https://host/v1'], false);
  }

  key(baseUrl: string): Promise<string | null> {
    return this.type('The key', [`API key for ${baseUrl}`, 'It is stored in .env, readable only by you. What you type is not shown.'], true, 'asking the endpoint which models it lists');
  }

  problem(why: string): void {
    this.trouble = why;
  }

  handOver(): void {
    // `one` runs the setup again at once, with the port for the browser's way back open. This page stays up in between.
    this.show(() => ({
      rows: [...this.top('Continue with ChatGPT'), [...this.spinner(), { text: 'opening the way back from your browser' }], [], ...this.para('For the time of the sign-in, one port is opened on this machine\'s loopback address.', DIM)],
      hint: [],
    }));
    this.close(true);
  }

  async sameAccount(email: string): Promise<boolean | null> {
    const chosen = await this.choose('Continue with ChatGPT', [`This install was signed in before${email ? `, as ${email}` : ''}.`], [
      { label: 'Sign in to that account again', key: 'y' },
      { label: 'A different account', key: 'n' },
    ]);
    return chosen === null ? null : chosen === 0;
  }

  signIn(url: string, giveUp: () => void): void {
    const since = this.now();
    this.background = (key) => {
      if (isCtrl(key, 'c') || isKey(key, 'escape')) giveUp();
    };
    const waiting = (): Line => [...this.spinner(), { text: 'waiting for you to come back from that page' }, { text: ` ${this.g.sep} ${elapsed(this.now() - since)}`, style: DIM }];
    this.show(() => {
      const { cols, rows } = this.term.size();
      const head = [...this.top('Continue with ChatGPT'), ...this.para('Open this address in your browser, sign in at OpenAI and approve teneral there.'), []];
      const needed = flowHeight({ flow: url }, cols);
      if (needed + 3 > rows - 3) {
        // Shown in part, the address could not be copied. It is said what would show it, and where the terminal knows links it can still be followed.
        return {
          rows: [
            ...this.top('Continue with ChatGPT'),
            ...this.para(`The address to open is too long for a window this small: it takes ${needed} rows. Make the window larger and it is shown whole, to select and copy.`), [],
            ...(this.term.caps.links ? [{ flow: 'Or follow this link: the sign-in page at OpenAI', link: url }, [] as Line] : []),
            waiting(),
          ],
          hint: ['Esc gives up'],
        };
      }
      return {
        // On a small screen the address is what must stay in view, then the line that says what is being waited for.
        focus: head.length + 2,
        rows: [
          ...head,
          // In one piece from the first column: the terminal wraps it, and copying it gives one line back.
          { flow: url, link: url }, [],
          waiting(), [],
          ...this.para('The page is OpenAI\'s: it asks you to sign in, then whether an app called teneral may use your ChatGPT plan. Your browser is then sent back to this machine and says "Signed in".', DIM), [],
          ...this.para('The address is for you alone; do not pass it on.', DIM),
        ],
        hint: ['Esc gives up'],
      };
    });
  }

  signedIn(email: string, file: string, first: boolean): void {
    this.facts = [`Signed in${email ? ` as ${email}` : ''}. The sign-in is stored in ${file}, readable only by you and by the agent's own shell.`];
    if (first) this.facts.push(PLAN_NOTICE);
    this.working('asking which models your plan lists');
  }

  async signInFailed(why: string): Promise<'choose' | 'quit' | null> {
    this.facts = [];
    const chosen = await this.choose('The sign-in did not work', [why], [{ label: 'Choose a provider again', key: 'c' }, { label: 'Quit', key: 'q' }]);
    return chosen === null ? null : chosen === 0 ? 'choose' : 'quit';
  }

  models(offered: ModelChoice[], listed: number): void {
    this.offered = offered;
    this.listed = listed;
  }

  model(fallback: string | undefined): Promise<string | null> {
    const offered = this.offered;
    if (offered.length === 0) return this.type('The model', ['Model name (it must support tool calls)'], false, 'starting the test');
    let at = 0;
    let line: Edit = EMPTY;
    const render = (): Page => {
      const rows: Row[] = [...this.top('The model')];
      rows.push(...this.para(this.listed > 0 ? 'Models this endpoint lists for you:' : 'The endpoint gave no list of models. A usual one:'), []);
      rows.push(...this.problemRows());
      // As many of the list as the screen has room for, around the one pointed at.
      const room = Math.max(1, this.term.size().rows - 3 - rows.length - 5);
      const from = Math.max(0, Math.min(at - Math.floor(room / 2), offered.length - room));
      const more = (n: number, where: string): Row => [{ text: `      ${this.g.ellipsis} ${n} more ${where}`, style: DIM }];
      if (from > 0) rows.push(more(from, 'above'));
      offered.slice(from, from + room).forEach((m, i) => {
        const here = from + i === at;
        rows.push([
          { text: here ? `  ${this.g.pointer} ` : '    ', style: { fg: 'accent', bold: true } },
          { text: clean(m.id), style: here ? BOLD : undefined },
          { text: m.label ? `  ${clean(m.label)}` : '', style: DIM },
          { text: m.id === fallback ? '  (the usual choice)' : '', style: DIM },
        ]);
      });
      const below = offered.length - from - room + (this.listed - offered.length);
      if (below > 0) rows.push(more(below, this.listed > offered.length ? 'below; any of them can be typed by name' : 'below'));
      const laid = layout(line.text, line.cursor, Math.max(2, this.term.size().cols - 24), 1);
      rows.push([], [{ text: '  or type a name: ', style: DIM }, { text: laid.rows[0] ?? '' }]);
      return { rows, hint: ['Enter confirms', 'Up/Down choose', 'Ctrl-C stops', 'or type a name'], cursor: { row: rows.length - 1, col: 18 + laid.col } };
    };
    return this.ask(render, (key) => {
      if (isKey(key, 'enter')) {
        this.trouble = '';
        // The number of the one pointed at, as the plain dialogue would be answered.
        return line.text.trim() === '' ? String(at + 1) : line.text;
      }
      if (line.text === '' && isKey(key, 'up')) at = Math.max(0, at - 1);
      else if (line.text === '' && isKey(key, 'down')) at = Math.min(offered.length - 1, at + 1);
      else if (isKey(key, 'pageup')) at = Math.max(0, at - 8);
      else if (isKey(key, 'pagedown')) at = Math.min(offered.length - 1, at + 8);
      else if (!(key.kind === 'key' && (key.name === 'up' || key.name === 'down' || key.name === 'j'))) {
        line = edit(line, key.kind === 'paste' ? { kind: 'paste', text: key.text.replace(/\n/g, '') } : key) ?? line;
      }
      return undefined;
    }, 'starting the test');
  }

  testing(provider: string, model: string): void {
    const fresh = () => ({ state: 'waiting' as const, ms: 0, since: this.now() });
    this.test = { provider, model, steps: { 'a reply': fresh(), 'a tool call': fresh() }, result: null };
    this.background = null;
    this.show(() => ({ rows: [...this.top('Two test requests'), ...this.testRows()], hint: ['Ctrl-C stops'] }));
  }

  progress(step: TestStep, state: 'asking' | 'ok' | 'failed', ms: number): void {
    if (this.test === null) return;
    this.test.steps[step] = { state, ms, since: this.now() };
    this.paint();
  }

  tested(result: TestResult): void {
    if (this.test !== null) this.test.result = result;
    this.paint();
  }

  /** The two requests and how each stands, live while they run. */
  private testRows(): Row[] {
    const t = this.test;
    if (t === null) return [];
    const rows: Row[] = [...this.para(`${t.provider}, with ${t.model}: one question, then one that must come back as a tool call.`), []];
    for (const step of ['a reply', 'a tool call'] as const) {
      const s = t.steps[step];
      const lead: Line = s.state === 'asking' ? this.spinner()
        : s.state === 'ok' ? [{ text: `  ${this.g.ok} `, style: GOOD }]
          : s.state === 'failed' ? [{ text: `  ${this.g.failed} `, style: WARN }] : [{ text: `  ${this.g.reasoning} `, style: DIM }];
      const tone: Style = s.state === 'ok' ? { fg: 'good' } : s.state === 'failed' ? WARN : DIM;
      const time = s.state === 'asking' ? duration(this.now() - s.since) : s.state === 'waiting' ? '' : duration(s.ms);
      rows.push([...lead, { text: step.padEnd(14) }, { text: s.state.padEnd(9), style: tone }, { text: time, style: DIM }]);
    }
    return rows;
  }

  async testFailed(): Promise<'retry' | 'choose' | 'quit' | null> {
    // What the provider said, in its own words; the lines that passed are in the rows above already.
    const said = (this.test?.result?.lines ?? []).map((line) => readable(line.trim())).filter((line) => !/^a (reply|tool call): ok,/.test(line));
    const options: Option[] = [{ label: 'Try it again', key: 'r' }, { label: 'Choose a provider again', key: 'c' }, { label: 'Quit', key: 'q' }];
    let at = 0;
    const render = (): Page => {
      const rows: Row[] = [...this.top('The test did not pass'), ...this.testRows(), []];
      for (const line of said) rows.push(...this.para(line, WARN));
      rows.push([], ...this.para('Nothing was written.'), []);
      options.forEach((option, i) => rows.push([
        { text: i === at ? `  ${this.g.pointer} ` : '    ', style: { fg: 'accent', bold: true } }, { text: option.label, style: i === at ? BOLD : undefined },
      ]));
      return { rows, focus: rows.length - 1, hint: ['Enter confirms', 'Up/Down choose', 'or press r, c, q'] };
    };
    const chosen = await this.ask(render, (key) => {
      if (isKey(key, 'up')) at = Math.max(0, at - 1);
      else if (isKey(key, 'down')) at = Math.min(options.length - 1, at + 1);
      else if (isKey(key, 'enter')) return at;
      else if (key.kind === 'text') {
        const byKey = options.findIndex((option) => option.key === key.text.toLowerCase());
        if (byKey !== -1) return byKey;
      }
      return undefined;
    });
    if (chosen !== null && chosen === 1) this.facts = [];
    return chosen === null ? null : (['retry', 'choose', 'quit'] as const)[chosen]!;
  }

  // --- the agent's account on GitHub ---

  async github(current: GithubAccount | 'refused' | null): Promise<'signin' | 'leave' | null> {
    this.stage = 'github';
    // What the model's part settled has been said; this page is about something else.
    this.facts = [];
    const later = './one setup github does this step alone, at any time, with no restart. Until then the agent cannot publish its work on GitHub.';
    const title = 'The agent\'s GitHub account';
    if (current === null) {
      const chosen = await this.choose(title, [GITHUB_WHY], [
        { label: 'Sign it in now', key: 'y', detail: [GITHUB_HOW] },
        { label: 'Later', key: 'n', detail: [later] },
      ], 0, 'asking GitHub for a code');
      return chosen === null ? null : chosen === 0 ? 'signin' : 'leave';
    }
    const intro = current === 'refused' ? 'A token is stored for the agent, but GitHub no longer accepts it.' : `The agent is signed in as ${accountFacts(current)}.`;
    const chosen = await this.choose(title, [intro], [
      { label: current === 'refused' ? 'Leave it for now' : 'Keep it', key: 'n' },
      { label: current === 'refused' ? 'Sign in again' : 'Sign in to another account', key: 'y', detail: [GITHUB_HOW] },
    ], current === 'refused' ? 1 : 0, 'asking GitHub for a code');
    return chosen === null ? null : chosen === 1 ? 'signin' : 'leave';
  }

  githubCode(code: string, url: string, giveUp: () => void): void {
    const since = this.now();
    this.background = (key) => {
      if (isCtrl(key, 'c') || isKey(key, 'escape')) giveUp();
    };
    this.show(() => {
      const step = (n: number, text: string): Line[] => {
        const lines = this.para(text, undefined, 5);
        if (lines.length > 0) lines[0] = [{ text: `  ${n}  `, style: ACCENT }, ...lines[0]!.slice(1)];
        return lines;
      };
      const rows: Row[] = [
        ...this.top('The agent\'s GitHub account'),
        ...step(1, 'In a browser where you are logged in as the agent\'s account, not your own, open:'), [],
        [{ text: '     ' }, { text: url, style: { fg: 'accent' } }], [],
        ...step(2, 'Type this code there, and approve:'), [],
        ...this.boxed(code.split('').join(' ')),
        [],
      ];
      rows.push([...this.spinner(), { text: 'waiting for GitHub to say the code was typed' }, { text: ` ${this.g.sep} ${elapsed(this.now() - since)}`, style: DIM }], []);
      rows.push(...this.para('The code is good for a quarter of an hour and for one sign-in. It is asked for by GitHub\'s own command line program, gh, so that is the app GitHub names on the page.', DIM));
      // The code is what must stay in view on a small screen.
      return { rows, focus: rows.length - 5, hint: ['Esc gives up'] };
    });
  }

  async githubIs(account: GithubAccount): Promise<boolean | null> {
    const chosen = await this.choose('Whose account this is', [`The code was typed by ${accountFacts(account)}.`, GITHUB_OWN], [
      { label: `Yes, ${clean(account.login)} is the agent's own account`, key: 'y', detail: ['Its token is stored in .teneral/auth/github-token, readable only by you and by the agent\'s own shell.'] },
      { label: 'No, that is not the agent\'s', key: 'n', detail: ['Nothing is stored. You can sign in again, as the agent\'s account.'] },
    ]);
    return chosen === null ? null : chosen === 0;
  }

  async githubFailed(why: string): Promise<'retry' | 'leave' | null> {
    const chosen = await this.choose('The sign-in at GitHub did not work', [why], [{ label: 'Try it again', key: 'r' }, { label: 'Leave it for later', key: 'l' }], 0, 'asking GitHub for a code');
    return chosen === null ? null : chosen === 0 ? 'retry' : 'leave';
  }

  /** How the agent stands with GitHub, as one marked paragraph of the last page. */
  private githubRows(github: GithubOutcome): Line[] {
    if (github.account === null) return this.marked(githubLine(github), this.g.reasoning, DIM);
    if (github.account === 'refused') return this.marked(githubLine(github), this.g.warn, WARN);
    return this.marked(githubLine(github));
  }

  async finished(github: GithubOutcome): Promise<void> {
    this.stage = 'ready';
    this.facts = [];
    await this.ask(() => {
      const rows: Row[] = [...this.top('Ready'), ...this.githubRows(github)];
      return { rows, focus: rows.length - 1, hint: ['Enter goes on'] };
    }, () => true);
    this.after.push(githubLine(github));
    this.close();
  }

  async wrote(names: string[], entry: ProviderEntry, github?: GithubOutcome): Promise<void> {
    this.stage = 'ready';
    const where = (file: string, what: string): Line[] => [[{ text: `    ${file}`, style: BOLD }], ...this.para(what, DIM, 6)];
    const next = this.o.thenStart
      ? ['The agent starts now. ./one talk attaches to it.']
      : ['./one up starts the agent with it.', 'One that is already running takes it up within a few seconds: its body is started again.'];
    // What was settled on the way is said once more, briefly; the page has to fit a small screen.
    this.facts = [];
    // Laid out anew for every frame: the window may change size while the page is up.
    const page = (): Row[] => [
      ...this.top('Ready'), ...this.testRows().slice(-2),
      ...(github ? this.githubRows(github) : []), [],
      [{ text: '  Written', style: DIM }],
      ...where('.env', `readable only by you: ${names.join(', ')}`),
      ...(entry.auth === 'chatgpt-signin' ? where(`.teneral/auth/${entry.id}.json`, 'the sign-in, readable only by you and by the agent\'s own shell') : []),
      ...(github?.changed ? where('.teneral/auth/github-token', 'the agent\'s account on GitHub, readable only by you and by the agent\'s own shell') : []),
      ...(entry.auth === 'chatgpt-signin' ? [[], ...this.para(`Using ChatGPT plan. Manage usage: ${CHATGPT_USAGE_URL}`, DIM)] : []),
      [], [{ text: '  Next', style: DIM }],
      ...next.flatMap((line) => this.para(line, undefined, 4)),
    ];
    await this.ask(() => {
      const rows = page();
      return { rows, focus: rows.length - 1, hint: ['Enter goes on'] };
    }, () => true);
    this.after.push(`Wrote .env, readable only by you: ${names.join(', ')}.`, ...(github ? [githubLine(github)] : []), ...(this.o.thenStart ? [] : [NEXT_STEP]));
    this.close();
  }

  stopped(): void {
    this.after.push('Stopped. No configuration was written.');
    this.close();
  }
}

/** The setup at the process's own terminal. Returns the exit status. */
export async function runSetupScreens(options: Omit<SetupOptions, 'io' | 'ui'>, o: SetupScreenOptions = {}): Promise<number> {
  const stages: Stage[] = options.only === 'github' ? ['github', 'ready'] : options.github ? ['model', 'github', 'ready'] : ['model', 'ready'];
  const ui = new SetupScreens(terminal(), {
    stages,
    ...o,
    abort: () => {
      ui.stopped();
      process.exit(1);
    },
  });
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
    process.on(signal, () => {
      ui.close();
      process.exit(1);
    });
  }
  try {
    ui.start();
    const status = await setup({ ...options, ui });
    ui.close(status === NEEDS_CALLBACK);
    return status;
  } catch (err) {
    ui.close();
    console.error(`The setup failed: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}
