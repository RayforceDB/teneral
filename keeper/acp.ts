import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { eventName, journalSize, readEventsFrom, type JournalEvent } from '../brain/journal';
import { quietReply } from '../brain/quiet';
import { ownerCommand } from '../species/offer';
import { installRoot, paths } from '../stem/supervisor';
import { interrupt, tell } from './owner';
import { pairingLine } from './pairing';
import { AT_REST, Follower, track, type Turn } from './talk';

// The agent as an agent of the Agent Client Protocol: `./one acp` runs this inside the agent's
// container, and an editor or a workbench that speaks the protocol (JSON-RPC 2.0, one message a
// line, on standard input and output) talks to the agent through it.
//
// It is a window, not a process of the agent's own. The agent is one being that lives on whether
// anything is attached: a client does not start it, and a session here does not begin a second
// one. What a client sends is said to the agent as its owner's words, the way the terminal says
// them (keeper/owner.ts), and what the agent then says and does is read back from the journal and
// passed on. Any number of sessions, here and in terminals, look at the same conversation.
//
// So nothing of the protocol that would move the agent's hands out of its own place is offered:
// no files read or written through the client, no commands run in its terminal, no permission
// asked of it. The agent works where it lives, and what it does there is shown as it happens.
//
// Like the terminal, this is the owner's tool and trusts nothing about the shape of what the
// body journaled.

/** The protocol's version this speaks. */
export const PROTOCOL = 1;

/** How much of a tool's output is passed on: enough to see how it went. */
const OUTPUT_CHARS = 4000;
const TITLE_CHARS = 120;

const asText = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value) ?? '');
/** Without control characters, which a client's screen would act on; line breaks and tabs stay. */
const plain = (text: string): string => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const clip = (text: string, most: number): string => (text.length > most ? `${text.slice(0, most - 1)}…` : text);

/** What a tool does, in the protocol's words, so that a client can show it fittingly. */
function kindOf(name: string): string {
  if (name === 'bash' || name === 'jobs' || name === 'work') return 'execute';
  if (name === 'read' || name === 'look' || name === 'open' || name === 'skill_show') return 'read';
  if (name === 'write' || name === 'edit') return 'edit';
  if (name === 'recall' || name === 'timeline' || name === 'skill_search' || /_history$/.test(name)) return 'search';
  return 'other';
}

function titleOf(name: string, args: unknown): string {
  const said = typeof args === 'object' && args !== null && !Array.isArray(args)
    ? Object.entries(args).map(([key, value]) => `${key}: ${asText(value)}`).join(', ') : asText(args);
  return clip(plain(`${name}${said === '' ? '' : `: ${said}`}`).replace(/\s+/g, ' '), TITLE_CHARS);
}

/** The words of a prompt: its text, and for what is attached by reference, where it is. Nothing else is taken (see `promptCapabilities`). */
export function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return '';
  return prompt.flatMap((block): string[] => {
    const b = (typeof block === 'object' && block !== null ? block : {}) as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') return [b.text];
    if (b.type === 'resource_link' && typeof b.uri === 'string') return [`[${typeof b.name === 'string' ? b.name : 'attached'}: ${b.uri}]`];
    if (b.type === 'resource' && typeof b.resource === 'object' && b.resource !== null) {
      const r = b.resource as Record<string, unknown>;
      return typeof r.text === 'string' ? [`[${asText(r.uri)}]\n${r.text}`] : [`[${asText(r.uri)}]`];
    }
    return [];
  }).join('\n').trim();
}

export interface AcpOptions {
  journal: string;
  /** The owner's directory: what is said goes there as a file (keeper/owner.ts). */
  owner: string;
  /** One message of the protocol, as a line. */
  send: (line: string) => void;
  /** An owner's command typed as a prompt (`/update take`, `/approve`): its answer as lines, or null when it is none. */
  command?: (line: string) => string[] | null;
  /** The agent's name for the client, and the version of what runs. */
  name?: string;
  version?: string;
  pollMs?: number;
}

interface Asked {
  id: string | number;
  session: string;
  /** The line as it was said, until it is seen in the journal: only what follows it is this prompt's. */
  line: string | null;
  cancelled: boolean;
}

/** One connection of a client. `receive` takes a line it sent; `close` ends the watching of the journal. */
export function acp(o: AcpOptions): { receive: (line: string) => void; close: () => void } {
  let initialized = false;
  const sessions = new Set<string>();
  const asked: Asked[] = [];
  const size = journalSize(o.journal);
  let turn: Turn = AT_REST;
  try { turn = readEventsFrom(o.journal, Math.max(0, size - 256_000)).reduce(track, AT_REST); } catch { /* a journal that cannot be read: taken to be at rest */ }
  const follower = new Follower(o.journal, size);

  const out = (message: Record<string, unknown>): void => o.send(JSON.stringify({ jsonrpc: '2.0', ...message }));
  const result = (id: unknown, value: unknown): void => out({ id, result: value });
  const error = (id: unknown, code: number, message: string, data?: unknown): void => out({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  const update = (session: string, body: Record<string, unknown>): void => out({ method: 'session/update', params: { sessionId: session, update: body } });
  const say = (session: string, text: string): void => update(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

  /** What one journal event is to the sessions that have asked and are waiting. */
  function pass(e: JournalEvent): void {
    const kind = eventName(e.type);
    const r = e as Record<string, unknown>;
    // A prompt's own line, seen: from here on what the agent does is its answer.
    if (kind === 'stimulus' && r.source === 'terminal') {
      const mine = asked.find((a) => a.line !== null && a.line === asText(r.text));
      if (mine !== undefined) mine.line = null;
    }
    const waiting = asked.filter((a) => a.line === null);
    for (const a of waiting) {
      if (kind === 'assistant') {
        const text = plain(asText(r.text));
        if (text.trim() !== '' && !quietReply(text)) say(a.session, text);
      } else if (kind === 'tool.intent') {
        const name = plain(asText(r.name));
        update(a.session, { sessionUpdate: 'tool_call', toolCallId: `${e.id}`, title: titleOf(name, r.args), kind: kindOf(name), status: 'in_progress', rawInput: r.args ?? {} });
        started.set(asText(r.callId), `${e.id}`);
      } else if (kind === 'tool.result') {
        const call = started.get(asText(r.callId));
        if (call !== undefined) {
          update(a.session, { sessionUpdate: 'tool_call_update', toolCallId: call, status: r.ok === true ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: clip(plain(asText(r.output)), OUTPUT_CHARS) } }] });
        }
      } else if (kind === 'turn.interrupted') a.cancelled = true;
    }
    if (kind === 'tool.result') started.delete(asText(r.callId));
    turn = track(turn, e);
    // The turn is over: everything asked and seen is answered.
    if (!turn.busy) {
      for (const a of waiting) {
        result(a.id, { stopReason: a.cancelled ? 'cancelled' : 'end_turn' });
        asked.splice(asked.indexOf(a), 1);
      }
    }
  }
  /** The calls begun and not yet answered, by the id the model gave them: a result names its call by that. */
  const started = new Map<string, string>();
  const timer = setInterval(() => { for (const e of follower.poll()) { try { pass(e); } catch { /* an event that cannot be read is passed over */ } } }, o.pollMs ?? 200);

  function prompt(id: string | number, params: Record<string, unknown>): void {
    const session = asText(params.sessionId);
    if (!sessions.has(session)) return error(id, -32002, 'no such session', { sessionId: session });
    const text = promptText(params.prompt);
    if (text === '') return error(id, -32602, 'a prompt needs some text');
    // An owner's command is answered here, as the terminal answers it: it is not said to the agent.
    if (text.startsWith('/') && !text.includes('\n')) {
      if (text === '/stop') { try { interrupt(o.owner); } catch { /* nothing to stop */ } say(session, 'Asked the agent to stop the turn it is in.'); return result(id, { stopReason: 'end_turn' }); }
      let lines: string[] | null = null;
      try { lines = o.command?.(text) ?? null; } catch (err) { lines = [err instanceof Error ? err.message : String(err)]; }
      if (lines !== null) { say(session, lines.join('\n')); return result(id, { stopReason: 'end_turn' }); }
    }
    try { tell(o.owner, text); } catch (err) { return error(id, -32603, `the agent could not be told: ${err instanceof Error ? err.message : String(err)}`); }
    asked.push({ id, session, line: text, cancelled: false });
  }

  function receive(line: string): void {
    if (line.trim() === '') return;
    let m: Record<string, unknown>;
    try { m = JSON.parse(line) as Record<string, unknown>; } catch { return error(null, -32700, 'not JSON'); }
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return error(null, -32600, 'not a message');
    const id = m.id as string | number | undefined;
    const method = m.method;
    // An answer to something asked of the client: nothing is ever asked of it.
    if (typeof method !== 'string') return;
    const params = (typeof m.params === 'object' && m.params !== null ? m.params : {}) as Record<string, unknown>;
    const isRequest = id !== undefined && id !== null;
    if (method === 'initialize') {
      initialized = true;
      if (!isRequest) return;
      return result(id, {
        protocolVersion: PROTOCOL,
        // Words only, and nothing through the client: the agent works where it lives.
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
        agentInfo: { name: 'teneral', title: o.name ?? 'teneral', version: o.version ?? '0.0.0' },
        authMethods: [],
      });
    }
    if (!initialized) { if (isRequest) error(id, -32600, 'initialize first'); return; }
    if (method === 'session/cancel') {
      // A notification: the turn is stopped as the owner stops it, and the prompt is answered when the journal shows it stopped.
      const session = asText(params.sessionId);
      const mine = asked.filter((a) => a.session === session);
      for (const a of mine) a.cancelled = true;
      if (mine.length > 0) { try { interrupt(o.owner); } catch { /* answered below all the same */ } }
      // A line not yet taken up by a turn is not waited for: nothing will say that it stopped.
      for (const a of mine.filter((one) => one.line !== null && !turn.busy)) { result(a.id, { stopReason: 'cancelled' }); asked.splice(asked.indexOf(a), 1); }
      return;
    }
    if (!isRequest) return;
    if (method === 'session/new') {
      // Every session is the same conversation with the one agent: its id only tells the client's windows apart.
      const session = `sess_${randomUUID()}`;
      sessions.add(session);
      return result(id, { sessionId: session });
    }
    if (method === 'session/prompt') return prompt(id, params);
    if (method === 'authenticate') return result(id, {});
    return error(id, -32601, `no such method: ${method}`);
  }

  return { receive, close: () => clearInterval(timer) };
}

if (import.meta.main) {
  const p = paths(installRoot(import.meta.dir));
  let version = '0.0.0';
  try { version = String((await Bun.file(`${p.root}/package.json`).json() as { version?: unknown }).version ?? version); } catch { /* as it stands */ }
  const server = acp({
    journal: p.journal, owner: p.owner, version,
    name: process.env.TENERAL_NAME?.trim() || 'teneral',
    // Standard output carries the protocol and nothing else.
    send: (line) => { process.stdout.write(`${line}\n`); },
    command: (line) => ownerCommand(p.root, line) ?? pairingLine(p.root, line),
  });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => server.receive(line));
  // The client closed its end: this window is gone, and the agent goes on.
  lines.on('close', () => { server.close(); process.exit(0); });
  process.on('SIGINT', () => process.exit(0));
}
