import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { git } from '../kernel/gates';
import { appendEvent } from '../kernel/journal';
import type { ToolSpec } from './provider';

export interface ToolContext {
  /** The candidate worktree: the only copy of the code the agent edits. */
  workspace: string;
  journal: string;
  gen: string;
  /** Set by `molt`; the process exits with 75 once the turn ends. */
  moltCommit: string | null;
}

export interface Tool {
  spec: ToolSpec;
  run(args: unknown, ctx: ToolContext): Promise<string>;
}

const OUTPUT_CAP = 20_000;

/**
 * Text that arrives in pieces and may be endless. Keeps the beginning and the end, half the cap
 * each, and only counts what falls between: the end is where a command usually says what went wrong.
 */
class Clipped {
  private head = '';
  private tail = '';
  private total = 0;

  add(piece: string): void {
    this.total += piece.length;
    const room = OUTPUT_CAP / 2 - this.head.length;
    this.head += piece.slice(0, room);
    this.tail = (this.tail + piece.slice(room)).slice(-OUTPUT_CAP / 2);
  }

  text(): string {
    const dropped = this.total - this.head.length - this.tail.length;
    if (dropped === 0) return this.head + this.tail;
    return `${this.head}\n[${dropped} characters dropped here]\n${this.tail}`;
  }
}

export function cap(text: string): string {
  const clipped = new Clipped();
  clipped.add(text);
  return clipped.text();
}

function str(args: unknown, key: string): string {
  const value = typeof args === 'object' && args !== null ? (args as Record<string, unknown>)[key] : undefined;
  if (typeof value !== 'string') throw new Error(`missing string argument: ${key}`);
  return value;
}

function params(properties: Record<string, string>): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(properties).map(([k, description]) => [k, { type: 'string', description }])),
    required: Object.keys(properties),
  };
}

const read: Tool = {
  spec: { name: 'read', description: 'Read a file. Paths are relative to your workspace.', parameters: params({ path: 'File path' }) },
  async run(args, ctx) {
    return cap(readFileSync(resolve(ctx.workspace, str(args, 'path')), 'utf8'));
  },
};

const write: Tool = {
  spec: {
    name: 'write',
    description: 'Create or overwrite a file, creating parent directories.',
    parameters: params({ path: 'File path', content: 'Full file content' }),
  },
  async run(args, ctx) {
    const path = resolve(ctx.workspace, str(args, 'path'));
    const content = str(args, 'content');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return `wrote ${content.length} characters to ${str(args, 'path')}`;
  },
};

const edit: Tool = {
  spec: {
    name: 'edit',
    description: 'Replace one exact occurrence of `old` with `new` in a file. Fails unless `old` occurs exactly once.',
    parameters: params({ path: 'File path', old: 'Exact text to replace', new: 'Replacement text' }),
  },
  async run(args, ctx) {
    const path = resolve(ctx.workspace, str(args, 'path'));
    const old = str(args, 'old');
    const replacement = str(args, 'new');
    if (old === '') throw new Error('`old` is empty; give the exact text to replace');
    const text = readFileSync(path, 'utf8');
    const count = text.split(old).length - 1;
    if (count === 0) throw new Error('`old` was not found in the file');
    if (count > 1) throw new Error(`\`old\` occurs ${count} times; give more context so it is unique`);
    // A function, so `$&` and friends in the new text are written as they are.
    writeFileSync(path, text.replace(old, () => replacement));
    return `edited ${str(args, 'path')}`;
  },
};

const BASH_LIMIT_MS = 120_000;

/** Reads a pipe to its end whatever its size, so the writer never blocks; `into` decides what is kept. */
async function drain(pipe: ReadableStream<Uint8Array>, into: Clipped): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of pipe) into.add(decoder.decode(chunk, { stream: true }));
  into.add(decoder.decode());
}

/**
 * Runs without blocking the process, so sensors keep working while a command runs.
 * `detached` makes bash the leader of its own process group; at the limit the whole group is
 * killed, so nothing the command started outlives it holding the pipes.
 */
export async function runBash(command: string, cwd: string, timeoutMs = BASH_LIMIT_MS): Promise<string> {
  const p = Bun.spawn(['bash', '-c', command], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-p.pid, 'SIGKILL');
    } catch {
      p.kill('SIGKILL');
    }
  }, timeoutMs);
  // One buffer for both pipes, in the order the output arrived.
  const output = new Clipped();
  try {
    await Promise.all([drain(p.stdout, output), drain(p.stderr, output), p.exited]);
  } finally {
    clearTimeout(timer);
  }
  const status = timedOut
    ? `timed out after ${timeoutMs / 1000}s and was killed`
    : p.exitCode === null ? `killed by ${p.signalCode}` : `exit ${p.exitCode}`;
  return `${status}\n${output.text()}`;
}

const bash: Tool = {
  spec: {
    name: 'bash',
    description: 'Run a bash command in your workspace. Two-minute limit, then everything it started is killed. Returns the exit code and the output; the middle of long output is dropped.',
    parameters: params({ command: 'The command' }),
  },
  async run(args, ctx) {
    return runBash(str(args, 'command'), ctx.workspace);
  },
};

const molt: Tool = {
  spec: {
    name: 'molt',
    description:
      'Commit your workspace and ask the kernel to switch you onto it. The kernel runs the gates when this turn ends; ' +
      'if they pass you restart on the new code, otherwise you restart on the current code with the reason.',
    parameters: params({ motive: 'One line: what changed and how you will know it helped' }),
  },
  async run(args, ctx) {
    const motive = str(args, 'motive');
    if (git(ctx.workspace, 'status', '--porcelain') !== '') {
      git(ctx.workspace, 'add', '-A');
      // The owner's hooks and signing setup are not the agent's to satisfy; the gates judge the commit.
      git(
        ctx.workspace,
        '-c', 'user.name=teneral', '-c', 'user.email=teneral@localhost', '-c', 'commit.gpgsign=false',
        'commit', '-q', '--no-verify', '-m', `molt: ${motive}`,
      );
    }
    const commit = git(ctx.workspace, 'rev-parse', 'HEAD');
    if (commit === ctx.gen) throw new Error('nothing to molt: the workspace matches the running generation');
    appendEvent(ctx.journal, ctx.gen, { type: 'molt.requested', commit, motive });
    ctx.moltCommit = commit;
    return `Molt requested for ${commit}. The kernel runs the gates when this turn ends.`;
  },
};

export const TOOLS: Tool[] = [read, write, edit, bash, molt];
