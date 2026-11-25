// The process a script of the agent runs in (body/script.ts). It knows nothing but the script and
// the names of the tools it may call; a call goes to the body, which checks it, journals it and
// runs it, and the script is given what the tool returned.

type Answer = { call: number; ok: boolean; output: string };

const waiting = new Map<number, { resolve: (output: string) => void; reject: (err: Error) => void }>();
let calls = 0;

const tools = new Proxy({}, {
  get: (_target, name) => (args: unknown = {}): Promise<string> => new Promise((resolve, reject) => {
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
    try { run = new AsyncFunction('tools', `return (\n${m.script}\n);`); } catch { run = new AsyncFunction('tools', m.script); }
  } catch (err) {
    process.send!({ done: true, ok: false, value: `it is not JavaScript that can be run: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  run(tools).then(
    (value) => process.send!({ done: true, ok: true, value: shown(value) }),
    (err) => process.send!({ done: true, ok: false, value: err instanceof Error ? (err.stack ?? err.message) : shown(err) }),
  );
});

process.send!({ ready: true });
