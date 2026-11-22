import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** A host-owned profile. The model chooses its name, never an executable or project flag. */
export interface LspProfile {
  command: string;
  args?: string[];
  cwd: string;
  /** LSP language id for didOpen; defaults to c for the first C profile. */
  language?: string;
  env?: Record<string, string>;
  readRoots?: string[];
}
export interface LspRequest {
  profile: LspProfile;
  operation: 'definition' | 'references' | 'hover' | 'symbols' | 'diagnostics';
  path: string;
  text: string;
  version?: number;
  line?: number;
  character?: number;
  limit?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
type Message = { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
type Pending = { resolve: (message: Message) => void; reject: (error: Error) => void };
const OPERATIONS = new Set(['definition', 'references', 'hover', 'symbols', 'diagnostics']);
const FRAME_MAX = 4 * 1024 * 1024;
const BUFFER_MAX = FRAME_MAX + 1024;
const LOG_MAX = 4000;

/** Real paths are checked before reading or returning them, including symlink targets. */
function inside(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(root + '/'));
}
function locationPath(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const uri = (value as { uri?: unknown; targetUri?: unknown }).uri ?? (value as { targetUri?: unknown }).targetUri;
  if (typeof uri !== 'string') return null;
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:') return null;
    return realpathSync(fileURLToPath(url));
  } catch { return null; }
}
function boundedLocations(value: unknown, roots: string[], limit: number): { locations: unknown[]; truncated: boolean; rejected: number } {
  if (!Array.isArray(value)) return { locations: [], truncated: false, rejected: 0 };
  const locations: unknown[] = []; let rejected = 0;
  for (const item of value) {
    const path = locationPath(item);
    if (path === null || !inside(path, roots)) { rejected++; continue; }
    if (locations.length < limit) locations.push(item);
  }
  return { locations, truncated: value.length > limit || rejected > 0, rejected };
}
function trim(value: unknown, limit: number): { value: unknown; truncated: boolean } {
  if (!Array.isArray(value)) return { value, truncated: false };
  return { value: value.slice(0, limit), truncated: value.length > limit };
}

/** One short-lived JSON-RPC session. Late or foreign responses can never resolve another request. */
export class LspSession {
  private child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private serial = 0;
  private pending = new Map<number, Pending>();
  private notifications: Message[] = [];
  private logs = '';
  private finished: Error | null = null;
  readonly generation = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  readonly language: string;
  constructor(profile: LspProfile, timeoutMs: number, signal?: AbortSignal) {
    this.language = profile.language ?? 'c';
    if (!isAbsolute(profile.command) || !isAbsolute(profile.cwd)) throw new Error('LSP command and cwd must be absolute host configuration');
    const args = profile.args ?? [];
    if (args.some((arg) => arg.startsWith('--query-driver'))) throw new Error('LSP query-driver execution is not allowed by this client');
    this.child = spawn(profile.command, args, {
      cwd: profile.cwd,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...profile.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => { this.logs = (this.logs + chunk.toString()).slice(-LOG_MAX); });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', () => this.fail(new Error('LSP server exited')));
    this.stopTimer = setTimeout(() => this.fail(new Error('LSP session timed out')), timeoutMs);
    this.abort = () => this.fail(new Error('LSP operation interrupted'));
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }
  private stopTimer: ReturnType<typeof setTimeout>;
  private abort: () => void;
  private fail(error: Error): void {
    if (this.finished !== null) return;
    this.finished = error;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.child.kill('SIGKILL');
  }
  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > BUFFER_MAX) return this.fail(new Error('LSP response buffer limit exceeded'));
    for (;;) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const match = /Content-Length: (\d+)/i.exec(this.buffer.subarray(0, end).toString());
      const length = match === null ? -1 : Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > FRAME_MAX) return this.fail(new Error('invalid or oversized LSP frame'));
      if (this.buffer.length < end + 4 + length) return;
      let message: Message;
      try { message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString()) as Message; }
      catch { this.buffer = this.buffer.subarray(end + 4 + length); return this.fail(new Error('invalid LSP JSON')); }
      this.buffer = this.buffer.subarray(end + 4 + length);
      // What the server asks of its client (to create a progress token, to read configuration) is granted with nothing, so that it goes on.
      if (typeof message.id === 'number' && typeof message.method === 'string') { this.send({ id: message.id, result: null }); continue; }
      if (typeof message.id !== 'number') {
        if (message.method === 'textDocument/publishDiagnostics' && this.notifications.length < 100) this.notifications.push(message);
        this.listener?.(message);
        continue;
      }
      const pending = this.pending.get(message.id);
      if (pending === undefined) continue; // A late response is retired, never rebound.
      this.pending.delete(message.id);
      pending.resolve(message);
    }
  }
  private send(message: Message): void {
    if (this.finished !== null) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  request(method: string, params: unknown): Promise<Message> {
    if (this.finished !== null) return Promise.reject(this.finished);
    const id = ++this.serial;
    return new Promise<Message>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }
  notify(method: string, params: unknown): void { this.send({ method, params }); }
  private listener: ((message: Message) => void) | null = null;
  /** Every notification the server sends from now on is handed to `listener`: its progress, its diagnostics. */
  onNotify(listener: (message: { method?: string; params?: unknown }) => void): void { this.listener = listener; }
  diagnostics(): Message[] { return this.notifications.filter((message) => message.method === 'textDocument/publishDiagnostics'); }
  log(): string { return this.logs; }
  close(): void {
    if (this.finished === null) { this.notify('exit', null); this.child.kill('SIGKILL'); }
    this.finished = new Error('LSP session closed');
    this.pending.clear();
    clearTimeout(this.stopTimer);
  }
}

export function readProfiles(path: string | undefined): Record<string, LspProfile> {
  if (path === undefined || path === '') return {};
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const profiles = typeof value === 'object' && value !== null ? (value as { profiles?: unknown }).profiles : undefined;
  if (typeof profiles !== 'object' || profiles === null || Array.isArray(profiles)) throw new Error('LSP profiles must be an object');
  return profiles as Record<string, LspProfile>;
}

/** A semantic result, not a currentness guarantee: standard LSP responses contain no snapshot proof. */
export async function lsp(request: LspRequest): Promise<Record<string, unknown>> {
  if (!OPERATIONS.has(request.operation)) throw new Error('unknown LSP operation');
  const limit = request.limit ?? 50, timeoutMs = request.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('LSP limit must be 1–100');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error('LSP timeout must be 100–60000 ms');
  const version = request.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('LSP document version must be a positive integer');
  const profile = request.profile;
  const roots = [profile.cwd, ...(profile.readRoots ?? [])].map((root) => realpathSync(resolve(root)));
  const path = realpathSync(resolve(profile.cwd, request.path));
  if (!inside(path, roots) || !existsSync(path)) throw new Error('LSP document is outside allowed read roots');
  if (request.operation !== 'symbols' && request.operation !== 'diagnostics'
    && (!Number.isSafeInteger(request.line) || !Number.isSafeInteger(request.character) || (request.line ?? -1) < 0 || (request.character ?? -1) < 0)) {
    throw new Error('LSP position requires nonnegative line and character');
  }
  let session: LspSession | null = null;
  try { session = new LspSession(profile, timeoutMs, request.signal); } catch (error) {
    return { operation: request.operation, status: request.signal?.aborted ? 'cancelled' : 'server-error', requestedVersion: version, freshness: 'unknown', completeness: 'unknown', error: error instanceof Error ? error.message : String(error) };
  }
  const started = performance.now();
  try {
    const init = await session.request('initialize', {
      processId: null, rootUri: pathToFileURL(profile.cwd).href,
      capabilities: { general: { positionEncodings: ['utf-8'] }, textDocument: {
        publishDiagnostics: { versionSupport: true }, definition: { linkSupport: true }, references: {},
        hover: { contentFormat: ['plaintext'] }, documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      } },
    });
    if (init.error) throw new Error(`LSP initialize: ${init.error.message ?? 'server error'}`);
    session.notify('initialized', {});
    const uri = pathToFileURL(path).href;
    session.notify('textDocument/didOpen', { textDocument: { uri, languageId: session.language, version, text: request.text } });
    const textDocument = { uri };
    const capabilities = (init.result as { capabilities?: Record<string, unknown> } | undefined)?.capabilities ?? {};
    const requiredCapability: Record<string, string> = { definition: 'definitionProvider', references: 'referencesProvider', hover: 'hoverProvider', symbols: 'documentSymbolProvider' };
    const capability = requiredCapability[request.operation];
    if (capability !== undefined && capabilities[capability] === undefined) {
      return { operation: request.operation, status: 'unsupported', session: session.generation, requestedVersion: version, freshness: 'unknown', completeness: 'unknown', result: null, truncated: false, rejectedLocations: 0 };
    }
    const method = request.operation === 'diagnostics' ? null : request.operation === 'symbols' ? 'textDocument/documentSymbol' : `textDocument/${request.operation}`;
    let status = request.operation === 'diagnostics' ? 'result' : 'server-error';
    let payload: unknown = null, truncated = false, rejected = 0;
    if (method === null) {
      // One event-loop turn collects what the server published in response to this open. It is
      // deliberately not a wait-for-index guarantee or a future diagnostics subscription.
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, timeoutMs)));
      const all = session.diagnostics().flatMap((message) => {
        const params = message.params as { uri?: unknown; version?: unknown; diagnostics?: unknown };
        if (params?.uri !== uri) return [];
        return (Array.isArray(params.diagnostics) ? params.diagnostics : []).map((diagnostic) => ({ version: params.version ?? null, diagnostic }));
      });
      payload = trim(all, limit).value; truncated = all.length > limit;
    } else {
      const response = await session.request(method, { textDocument, ...(request.operation === 'symbols' ? {} : { position: { line: request.line, character: request.character } }), ...(request.operation === 'references' ? { context: { includeDeclaration: true } } : {}) });
      if (response.error) status = 'server-error';
      else {
        payload = response.result;
        if (request.operation === 'definition' || request.operation === 'references') {
          const locations = boundedLocations(payload, roots, limit);
          payload = locations.locations; truncated = locations.truncated; rejected = locations.rejected;
        } else if (request.operation === 'symbols') {
          const symbols = trim(payload, limit); payload = symbols.value; truncated = symbols.truncated;
        }
        status = Array.isArray(payload) && payload.length === 0 ? 'not-found' : 'result';
      }
    }
    return { operation: request.operation, status, session: session.generation, requestedVersion: version,
      freshness: 'unknown', completeness: request.operation === 'references' || request.operation === 'definition' ? 'unknown' : 'single-document',
      result: payload, truncated, rejectedLocations: rejected, elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      ...(session.log() === '' ? {} : { serverLog: session.log() }) };
  } catch (error) {
    return { operation: request.operation, status: request.signal?.aborted ? 'cancelled' : String(error).includes('timed out') ? 'timeout' : 'server-error',
      session: session.generation, requestedVersion: version, freshness: 'unknown', completeness: 'unknown',
      error: error instanceof Error ? error.message : String(error), elapsedMs: Math.round((performance.now() - started) * 100) / 100 };
  } finally { session.close(); }
}
