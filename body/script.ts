import { join } from 'node:path';
import { appendEvent } from '../brain/journal';
import { mended } from '../brain/loop';
import { withCommands } from './path';
import { Clipped, clip } from './text';
import { bashEnv, drain, type Tool } from './tools';

// A script of the agent's own that calls its tools.
//
// Every call of a tool is otherwise a round: the model is asked, names one call, is shown all the
// tool returned, and is asked again. For work that is many calls whose results only decide the
// next call (read twenty files and keep the three that say something, search and open what was
// found), that is twenty rounds, and everything the tools returned is carried in every request
// after. A script does the same in one call: it runs in a process of its own, calls the tools as
// functions, and the agent is shown only what the script returns and prints.
//
// A call a script makes is a call all the same. It goes to the body, which runs the very tool the
// agent would have called, and the journal holds it under the tool's own name, marked with the
// call that ran the script (`within`): what the agent did is on record whether it did it by hand
// or by a script. What such a call returned is not shown to the agent, and so no request counts it.
//
// Only a tool that says it may be scripted can be called (`scripted`, body/tools.ts): one whose
// doing stays with the agent. Whatever speaks to someone or cannot be taken back is called by the
// agent itself, one call at a time, having seen what came before.
//
// The process is no cage. A script can do what `bash` can do, with the same environment and in
// the same directory; what it is kept from is the tools it was not given.

/** How long a script may run, with everything it calls. */
export const SCRIPT_LIMIT_MS = 300_000;
/** The calls one script may make: a loop that never ends is stopped here and not by the clock alone. */
export const SCRIPT_CALLS = 200;
const OUTPUT_CAP = 20_000;
const RUNNER = join(import.meta.dir, 'script-runner.ts');

type FromScript = { ready?: boolean; call?: number; name?: string; args?: unknown; done?: boolean; ok?: boolean; value?: string };

/** The tool that runs a script over `tools`: those of them that may be scripted are what the script can call. */
export function scriptTool(tools: Tool[], o: { limitMs?: number; calls?: number } = {}): Tool {
  const callable = tools.filter((t) => t.scripted === true);
  const names = callable.map((t) => t.spec.name);
  return {
    spec: {
      name: 'script',
      description: [
        'Run JavaScript of your own that calls your tools, in a process of its own (bun). You are shown only what it returns and prints; what the tools returned to it is not shown to you.',
        `It can call: ${names.join(', ')}. Each is \`await tools.NAME({...})\` with the arguments the tool takes, and gives the text the tool returns; a tool that fails throws. Everything else you call yourself.`,
        'Use it when several calls only decide the next ones, or when you need little of much: read many files and keep what matters, search and open what was found, do the same to each of a list. `return` what you need, shortly; a script that is one expression comes to its value.',
        'Not for a single call, and not when you need to see a result whole to judge it.',
        `It has ${Math.round((o.limitMs ?? SCRIPT_LIMIT_MS) / 60_000)} minutes and ${o.calls ?? SCRIPT_CALLS} calls, then it is killed with everything it started. Every call it made is in your journal under the tool's name.`,
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: 'The JavaScript: the body of an async function that is given `tools`' } },
        required: ['code'],
      },
    },
    async run(args, ctx, signal, call) {
      const code = typeof args === 'object' && args !== null ? (args as Record<string, unknown>).code : undefined;
      if (typeof code !== 'string' || code.trim() === '') throw new Error('code is required');
      if (signal?.aborted) return 'not run: interrupted by your owner before it started\n';
      const limitMs = o.limitMs ?? SCRIPT_LIMIT_MS, most = o.calls ?? SCRIPT_CALLS;
      const within = call?.id ?? 'script';

      let made = 0;
      let ended: { ok: boolean; value: string } | null = null;
      let finish: () => void = () => {};
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      // What stops the tools a script called when the script itself is stopped.
      const stop = new AbortController();
      // One call at a time, in the order they were made: the journal holds each with its result before the next begins.
      let queue: Promise<void> = Promise.resolve();

      const p = Bun.spawn([process.execPath, RUNNER], {
        cwd: ctx.workspace, env: withCommands(bashEnv(process.env)), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true,
        serialization: 'json',
        ipc(message: FromScript) {
          if (message.ready) { p.send({ script: code }); return; }
          if (message.done) {
            if (ended === null) ended = { ok: message.ok === true, value: String(message.value ?? '') };
            finish();
            return;
          }
          if (typeof message.call !== 'number') return;
          const n = message.call, name = String(message.name);
          queue = queue.then(async () => {
            let ok = true;
            let output: string;
            const tool = callable.find((t) => t.spec.name === name);
            if (tool === undefined) {
              // Nothing began, and nothing is journaled: the script is told, as the agent is told of a tool it does not have.
              output = tools.some((t) => t.spec.name === name) ? `${name} cannot be called from a script: call it yourself` : `unknown tool: ${name}`;
              ok = false;
            } else if (stop.signal.aborted) {
              output = 'not run: the script was stopped';
              ok = false;
            } else if (++made > most) {
              output = `not run: a script may make ${most} calls`;
              ok = false;
            } else {
              const callId = `${within}/${made}`;
              appendEvent(ctx.journal, ctx.gen, { type: 'tool.intent', callId, name, args: message.args, within });
              try {
                output = String(await tool.run(mended(tool.spec.parameters, message.args), ctx, stop.signal, call));
              } catch (err) {
                ok = false;
                output = `error: ${err instanceof Error ? err.message : String(err)}`;
              }
              appendEvent(ctx.journal, ctx.gen, { type: 'tool.result', callId, ok, output: output.toWellFormed(), within });
            }
            try { p.send({ call: n, ok, output }); } catch { /* the script is gone */ }
          });
        },
      });

      const killGroup = (): void => {
        try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch { /* gone */ } }
      };
      let why: 'time' | 'owner' | null = null;
      const end = (reason: 'time' | 'owner'): void => {
        why ??= reason;
        stop.abort();
        killGroup();
      };
      const timer = setTimeout(() => end('time'), limitMs);
      const onAbort = (): void => end('owner');
      signal?.addEventListener('abort', onAbort, { once: true });
      const printed = new Clipped(OUTPUT_CAP);
      const pipes = [drain(p.stdout, printed), drain(p.stderr, printed)];
      try {
        // It ends by saying so, or by ending: a script that exits, or is killed, says nothing.
        await Promise.race([finished, p.exited]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        stop.abort();
        killGroup();
      }
      // A call that was under way is journaled with its result before the script's own result is.
      await queue;
      await p.exited;
      await Promise.race([Promise.all(pipes.map((pipe) => pipe.done)), new Promise((resolve) => setTimeout(resolve, 500))]);
      for (const pipe of pipes) pipe.stop();

      const done = ended as { ok: boolean; value: string } | null;
      const status = why === 'owner' ? 'interrupted by your owner and killed, with everything it started'
        : why === 'time' ? `timed out after ${limitMs / 1000}s and was killed`
        : done === null ? `ended without returning (${p.exitCode === null ? `killed by ${p.signalCode}` : `exit ${p.exitCode}`})`
        : done.ok ? 'returned' : 'failed';
      const out = printed.text();
      const parts = [`${status}; it made ${Math.min(made, most)} ${Math.min(made, most) === 1 ? 'call' : 'calls'}`];
      if (done !== null && done.value !== '') parts.push(clip(done.value, OUTPUT_CAP));
      if (out.trim() !== '') parts.push(`[printed]\n${out}`);
      if (done !== null && !done.ok && why === null) throw new Error(parts.join('\n'));
      return parts.join('\n');
    },
  };
}
