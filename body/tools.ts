import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ENVELOPE_VERSION, MAX_HOPS, deliver, findSeen, parseEnvelope, type Envelope } from '../kernel/envelope';
import { git } from '../kernel/gates';
import { appendEvent } from '../kernel/journal';
import type { ToolSpec } from './provider';
import { Clipped, clip } from './text';

export interface ToolContext {
  /** The candidate worktree: the only copy of the code the agent edits. */
  workspace: string;
  journal: string;
  gen: string;
  /** Set by `molt`; the process exits with 75 once the turn ends. */
  moltCommit: string | null;
  /** This individual's id, used as `from` on what it sends. */
  id: string;
  /** This agent's own inbox directory. */
  inbox: string;
  /** JSON file mapping a peer's name to its inbox directory. Kept by the owner. */
  peers: string;
}

export interface Tool {
  spec: ToolSpec;
  run(args: unknown, ctx: ToolContext): Promise<string>;
}

const OUTPUT_CAP = 20_000;

export function cap(text: string): string {
  return clip(text, OUTPUT_CAP);
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
    const bytes = readFileSync(path);
    const text = bytes.toString('utf8');
    // Decoding puts a replacement character where the bytes are not text; writing that back would damage the file.
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('the file is not UTF-8 text; edit cannot change it safely');
    const first = text.indexOf(old);
    if (first === -1) throw new Error('`old` was not found in the file');
    // From first + 1, so matches that overlap count too: 'aa' is not unique in 'aaa'.
    let count = 1;
    for (let at = text.indexOf(old, first + 1); at !== -1; at = text.indexOf(old, at + 1)) count += 1;
    if (count > 1) throw new Error(`\`old\` occurs ${count} times; give more context so it is unique`);
    writeFileSync(path, text.slice(0, first) + replacement + text.slice(first + old.length));
    return `edited ${str(args, 'path')}`;
  },
};

const BASH_LIMIT_MS = 120_000;

/** How long the pipes may stay open after bash itself is gone. */
const DRAIN_MS = 500;

/** Reads a pipe whatever its size, so the writer never blocks; `into` decides what is kept. `stop` ends the reading early. */
function drain(pipe: ReadableStream<Uint8Array>, into: Clipped): { done: Promise<void>; stop: () => void } {
  const reader = pipe.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      into.add(decoder.decode(value, { stream: true }));
    }
    into.add(decoder.decode());
  })().catch(() => {});
  return { done, stop: () => { void reader.cancel().catch(() => {}); } };
}

/** What a command may see of the agent's environment: all of it but the provider key. */
export function bashEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const { TENERAL_API_KEY: _key, ...rest } = env;
  return rest;
}

/**
 * Runs without blocking the process, so sensors keep working while a command runs.
 * `detached` makes bash the leader of its own process group; at the limit the whole group is killed.
 * The call ends when bash does. Something bash started may still hold the pipes open (a background
 * job, or one that left the group and so escaped the kill): the pipes get DRAIN_MS more, then reading stops.
 */
export async function runBash(command: string, cwd: string, timeoutMs = BASH_LIMIT_MS): Promise<string> {
  const p = Bun.spawn(['bash', '-c', command], {
    cwd, env: bashEnv(process.env), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true,
  });
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
  const output = new Clipped(OUTPUT_CAP);
  const pipes = [drain(p.stdout, output), drain(p.stderr, output)];
  try {
    await p.exited;
  } finally {
    clearTimeout(timer);
  }
  let patience: ReturnType<typeof setTimeout> | undefined;
  const heldOpen = await Promise.race([
    Promise.all(pipes.map((pipe) => pipe.done)).then(() => false),
    new Promise<boolean>((resolve) => { patience = setTimeout(() => resolve(true), DRAIN_MS); }),
  ]);
  clearTimeout(patience);
  if (heldOpen) for (const pipe of pipes) pipe.stop();
  const status = timedOut
    ? `timed out after ${timeoutMs / 1000}s and was killed`
    : p.exitCode === null ? `killed by ${p.signalCode}` : `exit ${p.exitCode}`;
  const note = heldOpen && !timedOut
    ? '\n[something this command started is still running and holds its output open; it was left running, and what it prints from now on is not read]'
    : '';
  return `${status}\n${output.text()}${note}`;
}

const bash: Tool = {
  spec: {
    name: 'bash',
    description: 'Run a bash command in your workspace. Two-minute limit, then everything it started is killed. Returns the exit code and the output; the middle of long output is dropped. It does not see your API key.',
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
      'if they pass you restart on the new code, otherwise you restart on the current code with the reason. ' +
      'Everything in the workspace is committed, untracked files included, unless .gitignore names it.',
    parameters: params({ motive: 'One line: what changed and how you will know it helped' }),
  },
  async run(args, ctx) {
    const motive = str(args, 'motive');
    try {
      git(ctx.workspace, 'merge-base', '--is-ancestor', ctx.gen, 'HEAD');
    } catch {
      throw new Error(
        `the workspace is on a different line of history: its HEAD does not descend from the running generation ${ctx.gen}. ` +
        `See it with \`git log --oneline --graph HEAD ${ctx.gen}\`. Nothing was committed.`,
      );
    }
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
    // Shown so that a file committed by accident is noticed now, not at the gates.
    const changed = clip(git(ctx.workspace, 'diff', '--name-status', '--no-renames', ctx.gen, commit), 4000);
    return `Molt requested for ${commit}. The kernel runs the gates when this turn ends.\nChanged from the running generation:\n${changed}`;
  },
};

const send: Tool = {
  spec: {
    name: 'send',
    description:
      'Send a message to another agent. Peers are the names in soul/peers.json, kept by your owner. ' +
      'Give `replyTo` when you are answering a message you received.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Peer name' },
        text: { type: 'string', description: 'The message' },
        replyTo: { type: 'string', description: 'Id of the message you are answering, if any' },
      },
      required: ['to', 'text'],
    },
  },
  async run(args, ctx) {
    const to = str(args, 'to');
    const text = str(args, 'text');
    const rawReply = (args as Record<string, unknown>).replyTo;
    const replyTo = typeof rawReply === 'string' && rawReply !== '' ? rawReply : null;

    let peers: Record<string, unknown> = {};
    if (existsSync(ctx.peers)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(ctx.peers, 'utf8'));
      } catch (err) {
        throw new Error(`the peers file ${ctx.peers} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`the peers file ${ctx.peers} must hold one JSON object mapping peer names to inbox directories`);
      }
      peers = parsed as Record<string, unknown>;
    }
    const target = peers[to];
    if (typeof target !== 'string') {
      throw new Error(`unknown peer "${to}". Known peers: ${Object.keys(peers).join(', ') || 'none'}`);
    }

    let hops = 0;
    if (replyTo !== null) {
      const original = findSeen(ctx.inbox, replyTo);
      if (original === null) throw new Error(`no received message with id ${replyTo}`);
      hops = original.hops + 1;
    }
    if (hops > MAX_HOPS) throw new Error(`this exchange has reached ${MAX_HOPS} replies; ask your owner before going on`);

    const envelope: Envelope = { v: ENVELOPE_VERSION, id: randomUUID(), from: ctx.id, to, replyTo, ts: new Date().toISOString(), hops, text };
    // Refuse here what the receiver would refuse, so the sender hears about it.
    parseEnvelope(JSON.stringify(envelope));
    deliver(target, envelope);
    return `sent ${envelope.id} to ${to}`;
  },
};

export const TOOLS: Tool[] = [read, write, edit, bash, molt, send];
