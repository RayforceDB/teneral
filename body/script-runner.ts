// The process a script of the agent runs in (body/script.ts). It knows nothing but the script and
// the names of the tools it may call; a call goes to the body, which checks it, journals it and
// runs it, and the script is given what the tool returned.

type Answer = { call: number; ok: boolean; output: string };

const waiting = new Map<number, { resolve: (output: string) => void; reject: (err: Error) => void }>();
let calls = 0;

const tools = new Proxy({}, {
  // Not a promise, whatever asks: a script that returns `tools` itself must not be waited on for ever.
  get: (_target, name) => typeof name !== 'string' || name === 'then' ? undefined : (args: unknown = {}): Promise<string> => new Promise((resolve, reject) => {
    const call = ++calls;
    waiting.set(call, { resolve, reject });
    process.send!({ call, name: String(name), args });
  }),
}) as Record<string, (args?: unknown) => Promise<string>>;

const shown = (value: unknown): string => {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? String(v) : v), 2) ?? String(value); } catch { return String(value); }
};

process.on('message', (message: unknown) => {
  const m = message as { script?: unknown } & Partial<Answer>;
  if (typeof m.call === 'number') {
    const asked = waiting.get(m.call);
    waiting.delete(m.call);
    if (m.ok) asked?.resolve(String(m.output)); else asked?.reject(new Error(String(m.output)));
    return;
  }
  if (typeof m.script !== 'string') return;
  const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (tools: unknown) => Promise<unknown>;
  let run: (tools: unknown) => Promise<unknown>;
  try {
    // One expression is what it comes to; anything longer returns what it says to return.
    // An expression is often written with a semicolon after it.
    try { run = new AsyncFunction('tools', `return (\n${m.script.replace(/[\s;]+$/, '')}\n);`); } catch { run = new AsyncFunction('tools', m.script); }
  } catch (err) {
    process.send!({ done: true, ok: false, value: `it is not JavaScript that can be run: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  // Said, and then ended by itself once what it printed has gone out: the body waits a moment for that.
  const end = (ok: boolean, value: string): void => {
    process.send!({ done: true, ok, value });
    let left = 2;
    const gone = (): void => { if (--left === 0) process.exit(0); };
    process.stdout.write('', gone);
    process.stderr.write('', gone);
  };
  run(tools).then(
    (value) => end(true, shown(value)),
    (err) => end(false, err instanceof Error ? (err.stack ?? err.message) : shown(err)),
  );
});

// The body is gone, killed perhaps: nothing is left to answer a call or to read what is returned.
// The script ends with everything it started (it leads a process group of its own).
process.on('disconnect', () => {
  try { process.kill(-process.pid, 'SIGKILL'); } catch { /* not a group of its own */ }
  process.exit(1);
});

process.send!({ ready: true });
