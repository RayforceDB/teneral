import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { credentialFile, userAgent } from './providers';

// Signing in with a ChatGPT account, so the agent's requests use the owner's ChatGPT plan. This is
// OpenAI's route for open-source apps that run locally, as documented at
// https://developers.openai.com/siwc/token-sharing-open-source : the owner signs in on a page at
// OpenAI in their own browser, which registers this install as a client of theirs and hands back
// a code on a loopback address; the code is exchanged for tokens, and those are kept in a file
// only the owner can read. teneral says who it is throughout: its own name, no secret, no other
// client's identifier.
//
// Nothing here prints or journals a token, a code or a verifier.

/** The name the owner sees when OpenAI asks whether to authorize this app. */
export const AGENT_NAME = 'teneral';
/** The entry point for registering a new client. Never the id to exchange or refresh with: that one is issued. */
export const REGISTRATION_CLIENT = 'dynamic_agent_client';
/** Identity, then what using the plan needs. */
export const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
/** Without this one among the granted scopes, the tokens do not allow requests on the owner's plan. */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const DEFAULT_ISSUER = 'https://auth.openai.com';
export const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/** The S256 challenge for a PKCE verifier. */
export function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: challengeOf(verifier) };
}

/** The loopback address OpenAI sends the browser back to. Always 127.0.0.1, never `localhost`. */
export function redirectUri(port = CALLBACK_PORT): string {
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

/**
 * This install's host id: opaque, made once and kept beside the credentials. It tells OpenAI one
 * place the app runs from another; it is not a credential and says nothing about the owner.
 */
export function hostId(dir: string): string {
  const file = join(dir, 'host-id');
  try {
    const saved = readFileSync(file, 'utf8').trim();
    if (/^urn:uuid:[0-9a-f-]{36}$/.test(saved)) return saved;
  } catch { /* none yet */ }
  const made = `urn:uuid:${randomUUID()}`;
  writePrivate(file, `${made}\n`);
  return made;
}

export interface AuthorizeRequest {
  issuer: string;
  /** `REGISTRATION_CLIENT` the first time; afterwards the id that registration issued. */
  clientId: string;
  redirectUri: string;
  /** The API the tokens are for. */
  resource: string;
  hostId: string;
  state: string;
  nonce: string;
  challenge: string;
  /** For a client that is already registered: the ID token of its last sign-in, which names the account. */
  idTokenHint?: string;
}

/** The page the owner opens. The app's name goes along only when registering, as the docs ask. */
export function authorizeUrl(a: AuthorizeRequest): string {
  const q = new URLSearchParams({ client_id: a.clientId });
  if (a.clientId === REGISTRATION_CLIENT) q.set('agent_name_hint', AGENT_NAME);
  q.set('ext_agent_host_id', a.hostId);
  if (a.clientId !== REGISTRATION_CLIENT && a.idTokenHint) q.set('id_token_hint', a.idTokenHint);
  q.set('response_type', 'code');
  q.set('redirect_uri', a.redirectUri);
  q.set('scope', SCOPE);
  q.set('resource', a.resource);
  q.set('state', a.state);
  q.set('nonce', a.nonce);
  q.set('code_challenge_method', 'S256');
  q.set('code_challenge', a.challenge);
  return `${a.issuer}/api/accounts/authorize?${q.toString()}`;
}

/** What is kept of one sign-in. The field names follow the record in OpenAI's docs; the last four are teneral's. */
export interface Credentials {
  email: string;
  issuer: string;
  subject: string;
  client_id: string;
  ext_agent_host_id: string;
  id_token: string;
  /** Empty, with `refresh_token`, once the sign-in has ended and has to be done again. */
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scopes: string[];
  saved_at: string;
  /** When the access token stops being valid, in milliseconds since 1970. */
  expires_at: number;
  /**
   * Where requests with these tokens go. Fixed when the owner signs in and read from here ever
   * after, never from the environment: tokens are only sent to the API they were issued for.
   */
  api_base: string;
}

/** Owner-only, and whole or not at all: written beside the target and renamed over it. */
function writePrivate(file: string, text: string): void {
  const dir = join(file, '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  // The mode given to open is cut down by the umask but never widened; this is for a file system that ignores it.
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function saveCredentials(dir: string, id: string, cred: Credentials): void {
  writePrivate(credentialFile(dir, id), `${JSON.stringify(cred, null, 2)}\n`);
}

/** The stored sign-in, or null when there is none or the file is not one. */
export function readCredentials(dir: string, id: string): Credentials | null {
  try {
    const c = JSON.parse(readFileSync(credentialFile(dir, id), 'utf8')) as Partial<Credentials> | null;
    const text = [c?.issuer, c?.client_id, c?.access_token, c?.refresh_token, c?.api_base];
    if (!c || text.some((value) => typeof value !== 'string') || typeof c.expires_at !== 'number') return null;
    return c as Credentials;
  } catch {
    return null;
  }
}

/** The sign-in is gone or was never made, and only the owner can make it again. */
export class SignInNeeded extends Error {
  constructor(why: string) {
    super(`${why}: sign in again with ./nest setup`);
    this.name = 'SignInNeeded';
  }
}

/** The token endpoint said no. `code` is its machine-readable reason, when it gave one. */
export class TokenError extends Error {
  constructor(message: string, readonly status: number | null, readonly code: string) {
    super(message);
    this.name = 'TokenError';
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  token_type?: string;
  expires_in: number;
  scope?: string;
}

/** One form-encoded POST to the token endpoint. No client secret: this is a public client. */
async function tokenRequest(issuer: string, form: Record<string, string>, send: typeof fetch): Promise<TokenResponse> {
  let res: Response;
  let text: string;
  try {
    res = await send(`${issuer}/api/accounts/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': userAgent() },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    text = await res.text();
  } catch (err) {
    throw new TokenError(`the sign-in server could not be reached: ${err instanceof Error ? err.message : String(err)}`, null, '');
  }
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* said below */ }
  if (!res.ok) {
    // Either OAuth's {"error": "code"} or the API's {"error": {"code": ...}}.
    const e = parsed?.error;
    const inner = typeof e === 'object' && e !== null ? e as Record<string, unknown> : null;
    const code = typeof e === 'string' ? e : typeof inner?.code === 'string' ? inner.code : '';
    const said = parsed?.error_description ?? inner?.message ?? '';
    throw new TokenError(`the sign-in server answered ${res.status}${code ? ` ${code}` : ''}${said ? `: ${String(said).slice(0, 300)}` : ''}`, res.status, code);
  }
  const t = parsed as Partial<TokenResponse> | null;
  if (!t || typeof t.access_token !== 'string' || typeof t.refresh_token !== 'string' || t.access_token === '' || t.refresh_token === '') {
    throw new TokenError('the sign-in server answered without an access token and a refresh token', res.status, '');
  }
  return { ...t, access_token: t.access_token, refresh_token: t.refresh_token, expires_in: Number(t.expires_in) > 0 ? Number(t.expires_in) : 3600 };
}

export interface CodeExchange {
  issuer: string;
  /** The issued client id, not `REGISTRATION_CLIENT`. */
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  resource: string;
  fetch?: typeof fetch;
}

export function exchangeCode(x: CodeExchange): Promise<TokenResponse> {
  return tokenRequest(x.issuer, {
    grant_type: 'authorization_code', client_id: x.clientId, code: x.code, code_verifier: x.verifier,
    redirect_uri: x.redirectUri, resource: x.resource,
  }, x.fetch ?? fetch);
}

export interface IdTokenChecks {
  /** The issuer's published keys (the `keys` of its JWKS). */
  keys: readonly JsonWebKey[];
  issuer: string;
  /** The issued client id. */
  audience: string;
  nonce: string;
  now?: number;
}

/**
 * The claims of an ID token, once its RS256 signature checks out against the issuer's keys and it
 * was issued by that issuer, for this client, in answer to this attempt, and has not expired.
 */
export async function verifyIdToken(token: string, c: IdTokenChecks): Promise<Record<string, unknown>> {
  const bad = (why: string) => new Error(`the ID token from the sign-in is not valid: ${why}`);
  const parts = token.split('.');
  if (parts.length !== 3) throw bad('it is not a signed token');
  let header: { alg?: unknown; kid?: unknown };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    throw bad('it cannot be read');
  }
  if (header.alg !== 'RS256') throw bad(`it is signed with ${String(header.alg)}, not RS256`);
  const jwk = c.keys.find((k) => (k as { kid?: string }).kid === header.kid && k.kty === 'RSA');
  if (!jwk) throw bad('no published key matches the one it names');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, Buffer.from(parts[2]!, 'base64url'), signed)) throw bad('its signature does not match');
  if (claims.iss !== c.issuer) throw bad('it was issued by someone else');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(c.audience)) throw bad('it was issued for another client');
  // A minute's difference between two clocks is allowed, no more.
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < (c.now ?? Date.now()) - 60_000) throw bad('it has expired');
  if (claims.nonce !== c.nonce) throw bad('it does not answer this sign-in attempt');
  if (typeof claims.sub !== 'string' || claims.sub === '') throw bad('it names no account');
  return claims;
}

export interface Callback {
  code: string;
  /** The client id a new registration was issued; null when the callback named none. */
  clientId: string | null;
}

const page = (title: string, text: string): Response => new Response(
  `<!doctype html><meta charset="utf-8"><title>teneral</title><h1>${title}</h1><p>${text}</p>`,
  { headers: { 'content-type': 'text/html; charset=utf-8' } },
);

/**
 * Listens on the loopback address for the browser coming back from OpenAI. Only a request that
 * carries this attempt's `state` counts; anything else is answered and ignored. `hostname` is the
 * interface to bind: 127.0.0.1, except inside a container, where the published port arrives on another.
 */
export function listenForCallback(o: { port: number; hostname: string; state: string }): { done: Promise<Callback>; stop: () => void } {
  let settle: { resolve: (c: Callback) => void; reject: (err: Error) => void };
  const done = new Promise<Callback>((resolve, reject) => { settle = { resolve, reject }; });
  // A rejection nobody waits for yet must not end the process.
  done.catch(() => {});
  const server = Bun.serve({
    hostname: o.hostname,
    port: o.port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== CALLBACK_PATH) return new Response('not found', { status: 404 });
      const q = url.searchParams;
      if (q.get('state') !== o.state) {
        const res = page('Not this sign-in', 'This page does not belong to the sign-in teneral is waiting for. Go back to the terminal and open the address shown there.');
        return new Response(res.body, { status: 400, headers: res.headers });
      }
      const error = q.get('error');
      if (error !== null) {
        settle.reject(new Error(error === 'access_denied'
          ? 'the sign-in was declined at OpenAI (access_denied); nothing was stored'
          : `the sign-in failed at OpenAI: ${error.slice(0, 100)}`));
        return page('Not signed in', 'The sign-in was not completed. You can close this page and go back to the terminal.');
      }
      const code = q.get('code');
      if (!code) {
        settle.reject(new Error('the sign-in came back without a code'));
        return page('Not signed in', 'The sign-in came back without a code. You can close this page and go back to the terminal.');
      }
      settle.resolve({ code, clientId: q.get('client_id') });
      return page('Signed in', 'teneral has what it needs. You can close this page and go back to the terminal.');
    },
  });
  return { done, stop: () => { void server.stop(true); } };
}

export interface SignInOptions {
  /** The auth directory. */
  dir: string;
  /** The provider id the credentials are stored under. */
  id: string;
  /** Where requests with the tokens will go. */
  apiBase: string;
  issuer?: string;
  /** Shown the address to open. The only output of a sign-in. */
  show: (url: string) => void;
  /** Register anew even when a client was registered before: for signing in with a different account. */
  fresh?: boolean;
  port?: number;
  /** The interface the callback listener binds. Default 127.0.0.1. */
  hostname?: string;
  fetch?: typeof fetch;
  /** How long the owner has to finish in the browser. Default 10 minutes. */
  timeoutMs?: number;
  /** Aborted when the owner gives up waiting. */
  signal?: AbortSignal;
  now?: () => number;
}

/**
 * The whole sign-in: shows the address, waits for the browser to come back, exchanges the code,
 * checks the ID token and that the plan may be used, and stores the result. Returns what was stored.
 */
export async function signIn(o: SignInOptions): Promise<Credentials> {
  const issuer = o.issuer ?? DEFAULT_ISSUER;
  const send = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const port = o.port ?? CALLBACK_PORT;
  const host = hostId(o.dir);
  const before = readCredentials(o.dir, o.id);
  // A client is registered once per account and install, and reused: only with the issuer it came from.
  const saved = !o.fresh && before !== null && before.issuer === issuer && before.client_id !== '' ? before : null;
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const { verifier, challenge } = pkce();
  const redirect = redirectUri(port);

  const listener = listenForCallback({ port, hostname: o.hostname ?? '127.0.0.1', state });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let callback: Callback;
  try {
    o.show(authorizeUrl({
      issuer, clientId: saved?.client_id ?? REGISTRATION_CLIENT, redirectUri: redirect, resource: o.apiBase, hostId: host,
      state, nonce, challenge, idTokenHint: saved?.id_token || undefined,
    }));
    const timeoutMs = o.timeoutMs ?? 600_000;
    callback = await Promise.race([
      listener.done,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`nobody came back from the sign-in page within ${Math.round(timeoutMs / 60_000)} minutes`)), timeoutMs);
        o.signal?.addEventListener('abort', () => reject(new Error('you gave up waiting for the sign-in page; nothing was stored')), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // A moment for the browser to be given its page.
    setTimeout(listener.stop, 200);
  }

  let clientId: string;
  if (saved) {
    if (callback.clientId !== null && callback.clientId !== saved.client_id) throw new Error('the sign-in came back for a different client than the one registered here; nothing was changed');
    clientId = saved.client_id;
  } else {
    if (!callback.clientId || callback.clientId === REGISTRATION_CLIENT) throw new Error('the registration is incomplete: OpenAI issued no client id; nothing was stored');
    clientId = callback.clientId;
  }

  const tokens = await exchangeCode({ issuer, clientId, code: callback.code, verifier, redirectUri: redirect, resource: o.apiBase, fetch: send });
  if (typeof tokens.id_token !== 'string') throw new Error('the sign-in server sent no ID token; nothing was stored');
  let keys: JsonWebKey[];
  try {
    const res = await send(`${issuer}/.well-known/jwks.json`, { headers: { 'user-agent': userAgent() }, signal: AbortSignal.timeout(30_000) });
    keys = (await res.json() as { keys: JsonWebKey[] }).keys;
    if (!Array.isArray(keys)) throw new Error('no keys in it');
  } catch (err) {
    throw new Error(`the sign-in server's published keys could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const claims = await verifyIdToken(tokens.id_token, { keys, issuer, audience: clientId, nonce, now: now() });
  if (saved && saved.subject !== '' && claims.sub !== saved.subject) throw new Error('the sign-in was for a different account than the one stored here; nothing was changed');
  const scopes = (tokens.scope ?? '').split(/\s+/).filter(Boolean);
  if (!scopes.includes(PLAN_SCOPE)) {
    throw new Error(`signed in, but without permission to use the ChatGPT plan (${PLAN_SCOPE} was not granted); nothing was stored`);
  }
  const cred: Credentials = {
    email: typeof claims.email === 'string' ? claims.email : '',
    issuer,
    subject: claims.sub as string,
    client_id: clientId,
    ext_agent_host_id: host,
    id_token: tokens.id_token,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type ?? 'Bearer',
    expires_in: tokens.expires_in,
    scopes,
    saved_at: new Date(now()).toISOString(),
    expires_at: now() + tokens.expires_in * 1000,
    api_base: o.apiBase,
  };
  saveCredentials(o.dir, o.id, cred);
  return cred;
}

/** Reasons a refresh token will never work again. Anything else may pass, and the tokens are kept. */
const REFRESH_IS_OVER = new Set([
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused',
]);

/** A lock older than this was left by a process that died while holding it. */
const LOCK_STALE_MS = 60_000;
const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Runs `work` while holding `file`, which exists exactly as long as someone holds it. */
async function withLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 2 * LOCK_STALE_MS;
  for (;;) {
    try {
      closeSync(openSync(file, 'wx', 0o600));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let age = 0;
      try { age = Date.now() - statSync(file).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS) {
        rmSync(file, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`the sign-in is locked by another process and stayed so (${file})`);
      await sleep(50);
    }
  }
  try {
    return await work();
  } finally {
    rmSync(file, { force: true });
  }
}

export interface TokenOptions {
  /** The provider id the credentials are stored under. Default: chatgpt. */
  id?: string;
  /** A token the API just refused: one that differs is wanted, whatever the stored expiry says. */
  rejected?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** An access token is replaced this long before it expires. */
const REFRESH_AHEAD_MS = 300_000;

/**
 * A valid access token for the sign-in stored in `dir`. Near its expiry, or when the API refused
 * the current one, it is renewed with the refresh token, which the server replaces each time. Two
 * processes must never do that at once, or one would be left holding a refresh token that was
 * already used: so it happens under a lock file, and whoever gets the lock reads the file again
 * first and takes what another process may have just stored.
 */
export async function accessToken(dir: string, o: TokenOptions = {}): Promise<string> {
  const id = o.id ?? 'chatgpt';
  const now = o.now ?? Date.now;
  const good = (c: Credentials): boolean => c.access_token !== '' && c.access_token !== o.rejected && c.expires_at - now() > REFRESH_AHEAD_MS;
  const gone = () => new SignInNeeded('there is no usable ChatGPT sign-in on this install');
  const first = readCredentials(dir, id);
  if (first === null || first.refresh_token === '') throw gone();
  if (good(first)) return first.access_token;

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withLock(join(dir, `${id}.lock`), async () => {
    const cred = readCredentials(dir, id);
    if (cred === null || cred.refresh_token === '') throw gone();
    if (good(cred)) return cred.access_token;
    let tokens: TokenResponse;
    try {
      // The issuer and the client are the stored ones: tokens are renewed only where they came from.
      tokens = await tokenRequest(cred.issuer, {
        grant_type: 'refresh_token', client_id: cred.client_id, refresh_token: cred.refresh_token, resource: cred.api_base,
      }, o.fetch ?? fetch);
    } catch (err) {
      if (err instanceof TokenError && REFRESH_IS_OVER.has(err.code)) {
        // The tokens are of no more use. The registration is kept, so the next sign-in reuses it.
        saveCredentials(dir, id, { ...cred, access_token: '', refresh_token: '', expires_at: 0 });
        throw new SignInNeeded(`the ChatGPT sign-in has ended (${err.code})`);
      }
      // Not reachable, or a fault on their side: the token in hand is still good until it expires.
      if (cred.access_token !== '' && cred.access_token !== o.rejected && cred.expires_at > now()) return cred.access_token;
      throw err;
    }
    saveCredentials(dir, id, {
      ...cred,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token ?? cred.id_token,
      token_type: tokens.token_type ?? cred.token_type,
      expires_in: tokens.expires_in,
      scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : cred.scopes,
      saved_at: new Date(now()).toISOString(),
      expires_at: now() + tokens.expires_in * 1000,
    });
    return tokens.access_token;
  });
}

/** Where requests with the stored sign-in go. */
export function apiBase(dir: string, id = 'chatgpt'): string {
  const cred = readCredentials(dir, id);
  if (cred === null) throw new SignInNeeded('there is no ChatGPT sign-in on this install');
  return cred.api_base;
}

/** Whether a sign-in is stored and still has tokens. */
export function signedIn(dir: string, id: string): boolean {
  const cred = existsSync(credentialFile(dir, id)) ? readCredentials(dir, id) : null;
  return cred !== null && cred.refresh_token !== '';
}
