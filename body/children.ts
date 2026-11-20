import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendEvent, readEvents, type JournalEvent } from '../brain/journal';
import { runTurn } from '../brain/loop';
import type { Provider } from '../brain/provider';
import { ROUND_LIMIT_REPLY } from '../brain/quiet';
import { stopCurrentJobs } from './jobs';
import type { Stimulus } from './sensors';
import type { Tool, ToolContext } from './tools';

// A subagent is a child of this agent: the same loop of turns (brain/loop.ts) over a journal of
// its own, started with a task the agent wrote and nothing else of the conversation. It has the
// agent's hands (read, write, edit, look, bash) and none of its voice or standing: it cannot
// mutate, speak in a chat, touch the agent's memory or agenda, or start a child of its own.
//
// It never works in the agent's workspace. Each child gets a copy of it as it stands when the
// child starts, uncommitted work included, and what it changed comes back as a branch that the
// agent looks at and takes or leaves. Two children, or a child and the agent, can then never
// write over each other, which is how other agents lose work without a word.
//
// A child runs beside the agent's turns and outlives the turn that started it. That it has ended
// is a note in the agent's journal; the heart tells the agent (heart/coordinator.ts, `arrived`),
// as it does for a job. What it says is a worker's word, never the owner's.

/** What the agent's journal holds of a child: one note when it starts, one when it ends, one when the agent has been told. */
export const CHILD_KIND = 'body.child.v1';

export type ChildOutcome = 'returned' | 'step_limit' | 'timed_out' | 'out_of_budget' | 'stopped' | 'failed' | 'interrupted';

export interface ChildRecord {
  name: string;
  id: string;
  gen: string;
  task: string;
  /** Where its journal is, and its copy of the workspace while it runs. */
  dir: string;
  state: 'running' | 'ended' | 'told';
  outcome?: ChildOutcome;
  /** Its last words, cut to size. */
  report?: string;
  /** The branch in the agent's repository that holds what it changed, when it changed anything. */
  branch?: string;
  /** `git diff --stat` of that. */
  changed?: string;
  usage?: { input: number; output: number };
}

export interface ChildLimits {
  /** How many run at a time. */
  max: number;
  /** Rounds of one child: a request to the model and the calls it asked for. */
  steps: number;
  /** How long one child may run. */
  ms: number;
  /** Tokens one child may be charged, in and out together. */
  tokens: number;
}

export const CHILD_LIMITS: ChildLimits = { max: 3, steps: 30, ms: 15 * 60_000, tokens: 2_000_000 };

/** The limits as `.env` has them: a setting that is not a positive number leaves the default. */
export function childLimits(env: Record<string, string | undefined>): ChildLimits {
  const set = (name: string, unit = 1): number | undefined => {
    const n = Number(env[name]);
    return env[name] !== undefined && n > 0 ? Math.floor(n * unit) : undefined;
  };
  return {
    max: set('TENERAL_SUBAGENTS') ?? CHILD_LIMITS.max,
    steps: set('TENERAL_SUBAGENT_STEPS') ?? CHILD_LIMITS.steps,
    ms: set('TENERAL_SUBAGENT_MINUTES', 60_000) ?? CHILD_LIMITS.ms,
    tokens: set('TENERAL_SUBAGENT_TOKENS') ?? CHILD_LIMITS.tokens,
  };
}

const REPORT_CHARS = 12_000;
const TASK_CHARS = 8000;
/** A child's tools, by name, of those the agent has. Hands only. */
export const CHILD_TOOLS = ['read', 'write', 'edit', 'look', 'bash'];

export const CHILD_SYSTEM = [
  'You are a subagent: a worker started by an agent for one task. The task is the first message. You know nothing else of the agent\'s conversation, and it sees nothing of your work but your last reply.',
  'You work in a copy of the agent\'s workspace, made when you were started. Change what the task needs there; what you change is handed back as a branch for the agent to look at. Nothing outside that copy is yours to change.',
  'You cannot ask anyone anything. Where the task leaves a choice open, make the sensible one and say which you made.',
  'When you are done, reply without a tool call. That reply is your report and the only thing the agent reads: say what you did, what you found, what you changed and where, what you checked and how, and what you did not finish. Say plainly what you are not sure of. Do not address the owner; you have none.',
].join('\n');

const LIMIT_TEXT = 'You have reached the limit set for a subagent and cannot take another step. Reply now, with no tool call, with your report: what you did, what you found, what you changed and where, and exactly where you stopped.';

/** The last thing a child said in words, or '' when it has said nothing. */
function lastWords(events: JournalEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'assistant' && e.text.trim() !== '' && e.text !== ROUND_LIMIT_REPLY) return e.text;
  }
  return '';
}

function record(value: unknown): ChildRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const c = value as Partial<ChildRecord>;
  if (typeof c.name !== 'string' || typeof c.id !== 'string' || typeof c.gen !== 'string' || typeof c.task !== 'string' || typeof c.dir !== 'string'
    || (c.state !== 'running' && c.state !== 'ended' && c.state !== 'told')) return null;
  return c as ChildRecord;
}

/** Every child the journal knows, by name, as it last stood. */
export function childHistory(events: JournalEvent[]): Map<string, ChildRecord> {
  const children = new Map<string, ChildRecord>();
  for (const e of events) {
    if (e.type !== 'note' || e.kind !== CHILD_KIND) continue;
    const c = record(e.data);
    if (c !== null) children.set(c.name, c);
  }
  return children;
}

function childName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value)) throw new Error('a subagent\'s name must be 1 to 32 characters: a-z, 0-9 or dash, not beginning with a dash');
  return value;
}

function git(dir: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-c', 'user.name=subagent', '-c', 'user.email=subagent@teneral.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.status === 0 ? '' : r.stderr ?? ''}`.trim() };
}

/**
 * A copy of `workspace` as it stands, in `into`, on a branch of its own: the commit it is on, its
 * uncommitted changes and its untracked files, set down as one commit that the child's work then
 * stands on. The objects are shared with the agent's repository, so this costs a checkout and no more.
 */
export function copyWorkspace(workspace: string, into: string, branch: string): string {
  const head = git(workspace, 'rev-parse', 'HEAD');
  if (!head.ok) throw new Error('the workspace is not a git checkout with a commit, so no copy of it can be made for a subagent');
  // A commit of the tracked changes that touches neither the index nor the files; empty when there are none.
  const dirty = git(workspace, 'stash', 'create').out;
  const cloned = git(dirname(into), 'clone', '--quiet', '--shared', '--no-checkout', workspace, into);
  if (!cloned.ok) throw new Error(`the workspace could not be copied for a subagent: ${cloned.out.slice(0, 300)}`);
  const at = git(into, 'checkout', '--quiet', '-b', branch, head.out);
  if (!at.ok) throw new Error(`the copy could not be checked out: ${at.out.slice(0, 300)}`);
  if (dirty !== '') git(into, 'checkout', dirty, '--', '.');
  for (const path of git(workspace, 'ls-files', '--others', '--exclude-standard', '-z').out.split('\0')) {
    if (path === '') continue;
    try { cpSync(join(workspace, path), join(into, path), { recursive: true }); } catch { /* gone meanwhile */ }
  }
  // What the checks need and git does not hold.
  if (existsSync(join(workspace, 'node_modules')) && !existsSync(join(into, 'node_modules'))) {
    try { symlinkSync(join(workspace, 'node_modules'), join(into, 'node_modules')); } catch { /* the child installs its own if it needs them */ }
  }
  git(into, 'add', '-A');
  git(into, 'commit', '--quiet', '--allow-empty', '-m', 'The workspace as it stood when the subagent started');
  const base = git(into, 'rev-parse', 'HEAD');
  if (!base.ok) throw new Error('the copy of the workspace could not be committed');
  return base.out;
}

/**
 * What the child changed, as a branch in the agent's repository: everything it did since `base`,
 * the copy's first commit, as one commit on top of it, fetched across. Null when it changed nothing.
 */
export function handBack(workspace: string, copy: string, branch: string, name: string, base: string): { branch: string; changed: string } | null {
  git(copy, 'add', '-A');
  if (git(copy, 'status', '--porcelain').out !== '') git(copy, 'commit', '--quiet', '-m', `Subagent ${name}: its work`);
  if (git(copy, 'diff', '--quiet', base, 'HEAD').ok) return null;
  // Whatever commits it made of its own become one, so that one cherry-pick takes all of it.
  git(copy, 'checkout', '--quiet', '-B', branch);
  git(copy, 'reset', '--quiet', '--soft', base);
  if (!git(copy, 'commit', '--quiet', '-m', `Subagent ${name}: its work`).ok) return null;
  const fetched = git(workspace, 'fetch', '--quiet', '--force', copy, `${branch}:refs/heads/${branch}`);
  if (!fetched.ok) return null;
  return { branch, changed: git(copy, 'diff', '--stat', base, 'HEAD').out.slice(0, 2000) };
}

export interface ChildrenOptions {
  /** The agent's journal, where the notes of a child go. */
  journal: string;
  gen: string;
  /** The agent's workspace, which each child gets a copy of. */
  workspace: string;
  /** Where children keep their journals and copies. */
  dir: string;
  provider: Provider;
  /** The agent's tools; a child gets those named in CHILD_TOOLS. */
  tools: Tool[];
  ctx: ToolContext;
  limits?: ChildLimits;
  budgetChars?: number;
  /** Called when a child has ended and its note is written: the body wakes, and the heart finds it. */
  onEnded?: () => void;
}

/** The children of one body: started, looked at, spoken to and stopped here; they die with the process. */
export class Children {
  private running = new Map<string, { record: ChildRecord; controller: AbortController; why: ChildOutcome | null }>();
  private limits: ChildLimits;
  constructor(private o: ChildrenOptions) { this.limits = o.limits ?? CHILD_LIMITS; }

  private history(): Map<string, ChildRecord> { return childHistory(readEvents(this.o.journal)); }
  private note(c: ChildRecord): void { appendEvent(this.o.journal, this.o.gen, { type: 'note', kind: CHILD_KIND, data: c }); }

  start(nameArg: unknown, taskArg: unknown): string {
    const name = childName(nameArg);
    if (typeof taskArg !== 'string' || taskArg.trim() === '' || taskArg.length > TASK_CHARS) throw new Error(`a subagent needs a task of 1 to ${TASK_CHARS} characters: it is all it will know`);
    if (this.running.has(name)) throw new Error(`a subagent named ${name} is running already`);
    if (this.running.size >= this.limits.max) throw new Error(`${this.running.size} subagents run already (${[...this.running.keys()].join(', ')}), which is the most at a time: wait for one to end, or stop one`);
    const id = randomUUID().slice(0, 8);
    const dir = join(this.o.dir, `${name}-${id}`);
    mkdirSync(dir, { recursive: true });
    const branch = `child/${name}-${id}`;
    const base = copyWorkspace(this.o.workspace, join(dir, 'work'), branch);
    const c: ChildRecord = { name, id, gen: this.o.gen, task: taskArg, dir, state: 'running' };
    appendEvent(join(dir, 'journal.jsonl'), this.o.gen, { type: 'stimulus', source: 'terminal', text: taskArg });
    this.note(c);
    const entry = { record: c, controller: new AbortController(), why: null as ChildOutcome | null };
    this.running.set(name, entry);
    void this.run(entry, branch, base);
    return `Started subagent ${name}. It works in a copy of your workspace as it stands now, uncommitted changes included, and knows only the task you wrote: nothing of this conversation. You are woken when it ends, so end your turn or go on with other work; do not wait for it in a loop. subagent action=peek name=${name} shows its last steps, action=message sends it a line, action=stop ends it.`;
  }

  private async run(entry: { record: ChildRecord; controller: AbortController; why: ChildOutcome | null }, branch: string, base: string): Promise<void> {
    const c = entry.record;
    const journal = join(c.dir, 'journal.jsonl');
    const work = join(c.dir, 'work');
    const spent = { input: 0, output: 0 };
    const counted: Provider = async (messages, specs, options) => {
      const reply = await this.o.provider(messages, specs, options);
      spent.input += reply.usage?.input ?? 0;
      spent.output += reply.usage?.output ?? 0;
      if (spent.input + spent.output >= this.limits.tokens && entry.why === null) {
        entry.why = 'out_of_budget';
        queueMicrotask(() => entry.controller.abort());
      }
      return reply;
    };
    const names = new Set(CHILD_TOOLS);
    const tools = this.o.tools.filter((t) => names.has(t.spec.name));
    const ctx: ToolContext = { workspace: work, journal, gen: this.o.gen, mutationCommit: null, id: this.o.ctx.id, inbox: join(c.dir, 'inbox'), peers: join(c.dir, 'peers.json'), soul: join(c.dir, 'notes') };
    const timer = setTimeout(() => { entry.why ??= 'timed_out'; entry.controller.abort(); }, Math.min(this.limits.ms, 2 ** 31 - 1));
    const last = (): string => lastWords(readEvents(journal));
    let outcome: ChildOutcome = 'failed';
    let report = '';
    try {
      const turn = { journal, gen: this.o.gen, ctx, system: () => CHILD_SYSTEM, budgetChars: this.o.budgetChars };
      const ended = await runTurn({ ...turn, provider: counted, tools, maxRounds: this.limits.steps, signal: entry.controller.signal });
      const final = readEvents(journal).findLast((e) => e.type === 'assistant');
      const cut = final?.type === 'assistant' && final.text === ROUND_LIMIT_REPLY;
      outcome = ended === 'interrupted' ? entry.why ?? 'stopped' : cut ? 'step_limit' : 'returned';
      if (outcome !== 'returned' && outcome !== 'stopped') {
        // It is asked once more, with no tools, for what it has: a child that ran out must not come back with nothing.
        appendEvent(journal, this.o.gen, { type: 'stimulus', source: 'terminal', text: LIMIT_TEXT });
        try { await runTurn({ ...turn, provider: this.o.provider, tools: [], maxRounds: 1, signal: AbortSignal.timeout(120_000) }); } catch { /* its earlier words stand */ }
      }
      report = last();
    } catch (err) {
      outcome = entry.why ?? 'failed';
      report = [last(), `The subagent could not go on: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`].filter((s) => s !== '').join('\n\n');
    } finally {
      clearTimeout(timer);
    }
    let handed: ReturnType<typeof handBack> = null;
    try { stopCurrentJobs(journal, this.o.gen); } catch { /* nothing it left running is known */ }
    try { handed = handBack(this.o.workspace, work, branch, c.name, base); } catch { /* reported below as no branch */ }
    try { rmSync(work, { recursive: true, force: true }); } catch { /* the copy stays; nothing reads it */ }
    this.running.delete(c.name);
    try {
      this.note({
        ...c, state: 'ended', outcome, report: (report === '' ? '(it said nothing)' : report).slice(0, REPORT_CHARS).toWellFormed(),
        ...(handed === null ? {} : handed), usage: spent,
      });
    } catch { /* the journal could not be written: the next start closes it as lost */ }
    this.o.onEnded?.();
  }

  message(nameArg: unknown, text: unknown): string {
    const name = childName(nameArg);
    if (typeof text !== 'string' || text.trim() === '' || text.length > TASK_CHARS) throw new Error(`a message to a subagent is 1 to ${TASK_CHARS} characters`);
    const entry = this.running.get(name);
    if (entry === undefined) throw new Error(this.history().has(name) ? `subagent ${name} has ended and cannot be spoken to; start another, and give it what this one found` : `no subagent named ${name}`);
    appendEvent(join(entry.record.dir, 'journal.jsonl'), this.o.gen, { type: 'stimulus', source: 'terminal', text });
    return `Sent to ${name}. It reads it with its next step.`;
  }

  stop(nameArg: unknown): string {
    const name = childName(nameArg);
    const entry = this.running.get(name);
    if (entry === undefined) throw new Error(this.history().has(name) ? `subagent ${name} has ended already` : `no subagent named ${name}`);
    entry.why ??= 'stopped';
    entry.controller.abort();
    return `Stopping ${name}. What it changed so far is handed back as a branch, and you are told when it has ended.`;
  }

  /** The last steps of a child, from its own journal. */
  peek(nameArg: unknown): string {
    const name = childName(nameArg);
    const c = this.running.get(name)?.record ?? this.history().get(name);
    if (c === undefined) throw new Error(`no subagent named ${name}`);
    let events: JournalEvent[] = [];
    try { events = readEvents(join(c.dir, 'journal.jsonl')); } catch { return `${name}: its journal cannot be read.`; }
    const lines = events.flatMap((e) => (
      e.type === 'tool.intent' ? [`  [${e.name}] ${JSON.stringify(e.args).slice(0, 200)}`]
      : e.type === 'assistant' && e.text.trim() !== '' ? [`  said: ${e.text.replace(/\s+/g, ' ').slice(0, 400)}`]
      : e.type === 'stimulus' ? [`  told: ${e.text.replace(/\s+/g, ' ').slice(0, 200)}`] : []));
    const steps = events.filter((e) => e.type === 'assistant').length;
    return [`${name}: ${this.running.has(name) ? 'running' : c.outcome ?? c.state}; ${steps} of ${this.limits.steps} steps. Its journal: ${join(c.dir, 'journal.jsonl')}`, ...lines.slice(-12)].join('\n');
  }

  list(): string {
    const all = [...this.history().values()];
    if (all.length === 0) return 'No subagents recorded.';
    return all.map((c) => `${c.name}: ${this.running.has(c.name) ? 'running' : c.outcome ?? c.state}${c.branch === undefined ? '' : `; branch ${c.branch}`}; ${c.task.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n');
  }

  /** At the body's end: nothing of a child outlives the process that ran it. */
  stopAll(): void {
    for (const entry of this.running.values()) { entry.why ??= 'interrupted'; entry.controller.abort(); }
  }
}

/** What the agent is told of how a child ended. */
const ENDED: Record<ChildOutcome, string> = {
  returned: 'has finished',
  step_limit: 'reached the limit of steps for a subagent and was asked for what it had',
  timed_out: 'ran out of time and was asked for what it had',
  out_of_budget: 'used up the tokens allowed a subagent and was asked for what it had',
  stopped: 'was stopped by you',
  failed: 'failed',
  interrupted: 'was cut off when your body was restarted, and did not finish',
};

export function childText(c: ChildRecord): string {
  const work = c.branch === undefined
    ? 'It changed nothing in its copy of your workspace.'
    : `What it changed is not in your workspace: it is on the branch ${c.branch}, as one commit on top of a commit of your workspace as it stood when it started.\n${c.changed ?? ''}\nLook at it with: git diff ${c.branch}~1 ${c.branch}\nTake it, if it is right, with: git cherry-pick ${c.branch}`;
  return [
    `Your subagent ${c.name} ${ENDED[c.outcome ?? 'failed']}. Its task was: ${c.task.replace(/\s+/g, ' ').slice(0, 300)}`,
    work,
    'Its report follows. It is the word of a worker you started, not your owner\'s and not checked by anyone: look at what matters before you rely on it, act on it or pass it on. If you told someone it was running, or that you would say how it went, tell them now, in the place where you said it.',
    '--- report ---',
    c.report ?? '(none)',
  ].join('\n');
}

/**
 * A child that has ended and that the agent has not been told of, as what it is told; null when
 * there is none. Marked as told in the journal first, so once. The heart asks (heart/coordinator.ts).
 */
export function endedChild(journal: string, gen: string, events: JournalEvent[]): Stimulus | null {
  for (const c of childHistory(events).values()) {
    if (c.state !== 'ended') continue;
    appendEvent(journal, gen, { type: 'note', kind: CHILD_KIND, data: { ...c, state: 'told' } });
    return { source: 'work', text: childText(c) };
  }
  return null;
}

/**
 * At a body's start: a child the journal still has as running was running in a process that is
 * gone. It is closed as cut off, with its last words when its journal can be read, so the agent hears of it.
 */
export function closeLostChildren(journal: string, gen: string, events: JournalEvent[] = readEvents(journal)): string[] {
  const lost: string[] = [];
  for (const c of childHistory(events).values()) {
    if (c.state !== 'running') continue;
    let said = '';
    try { said = lastWords(readEvents(join(c.dir, 'journal.jsonl'))); } catch { /* no journal left */ }
    try { rmSync(join(c.dir, 'work'), { recursive: true, force: true }); } catch { /* stays */ }
    appendEvent(journal, gen, { type: 'note', kind: CHILD_KIND, data: { ...c, state: 'ended', outcome: 'interrupted', report: (said === '' ? '(it had said nothing yet)' : said).slice(0, REPORT_CHARS) } });
    lost.push(c.name);
  }
  return lost;
}

/** The agent's hand on its children. */
export function childTool(children: Children): Tool {
  return {
    spec: {
      name: 'subagent',
      description: 'Start and manage subagents: workers with your hands (read, write, edit, look, bash) that each do one task in a copy of your workspace, beside your own turns. action=start with a name and a task starts one and returns at once; the task is all it knows, so write it whole: the goal, what you already know, where to look, what done means and what to report. You are woken when it ends, with its report and the branch that holds what it changed. Use one for work that can go on without you (a long search, an independent fix, a second opinion), several for work that splits into parts that do not depend on each other. Not for something a few calls of your own would do. action=list shows all, action=peek name=… the last steps of one, action=message name=… text=… sends a running one a line, action=stop name=… ends one.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'start, list, peek, message or stop' },
          name: { type: 'string', description: 'The subagent\'s name: a-z, 0-9, dash' },
          task: { type: 'string', description: 'For start: everything the subagent needs to know' },
          text: { type: 'string', description: 'For message: the line to send' },
        },
        required: ['action'],
      },
    },
    async run(args) {
      const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
      switch (a.action) {
        case 'start': return children.start(a.name, a.task);
        case 'list': return children.list();
        case 'peek': return children.peek(a.name);
        case 'message': return children.message(a.name, a.text);
        case 'stop': return children.stop(a.name);
        default: throw new Error('action must be start, list, peek, message or stop');
      }
    },
  };
}
