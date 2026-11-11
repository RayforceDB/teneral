import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_NAME, REGISTRATION_CLIENT, SCOPE, SignInNeeded, accessToken, apiBase, authorizeUrl, challengeOf, hostId, listenForCallback,
  pkce, readCredentials, redirectUri, saveCredentials, signIn, signedIn, verifyIdToken, type Credentials,
} from '../../kernel/signin';
import { startFakeOpenAi, type FakeOpenAi } from './fakeopenai';

let fake: FakeOpenAi;
let dir: string;
beforeEach(async () => {
  fake = await startFakeOpenAi();
  dir = join(mkdtempSync(join(tmpdir(), 'teneral-auth-')), 'auth');
});
afterEach(() => fake.stop());

/** A port nothing listens on, for a callback listener of the test's own. */
function freePort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const { port } = probe;
  void probe.stop(true);
  return port!;
}

/** Signs in against the fake, with the test playing the owner's browser. Returns what was stored and the address shown. */
async function signInHere(o: { fresh?: boolean; browser?: (url: string) => Promise<void> } = {}): Promise<{ cred: Credentials; shown: string }> {
  let shown = '';
  const cred = await signIn({
    dir, id: 'chatgpt', issuer: fake.url, apiBase: fake.api, port: freePort(), fresh: o.fresh, timeoutMs: 5000,
    show: (url) => {
      shown = url;
      void (o.browser ?? (async (address) => { await fetch(await fake.consent(address)); }))(url);
    },
  });
  return { cred, shown };
}

const mode = (file: string): number => statSync(file).mode & 0o777;

// --- the pure pieces ---

test('PKCE: the challenge is the unpadded base64url SHA-256 of a verifier of the allowed shape', () => {
  const a = pkce();
  expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  expect(a.challenge).toBe(createHash('sha256').update(a.verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  expect(pkce().verifier).not.toBe(a.verifier);
  // RFC 7636, appendix B.
  expect(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('the authorize address registers a new client under teneral\'s own name, with everything the docs list', () => {
  const url = new URL(authorizeUrl({
    issuer: 'https://auth.openai.com', clientId: REGISTRATION_CLIENT, redirectUri: redirectUri(), resource: 'https://api.openai.com/v1',
    hostId: 'urn:uuid:11111111-2222-4333-8444-555555555555', state: 'st', nonce: 'no', challenge: 'ch',
  }));
  expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
  expect(Object.fromEntries(url.searchParams.entries())).toEqual({
    client_id: 'dynamic_agent_client',
    agent_name_hint: 'teneral',
    ext_agent_host_id: 'urn:uuid:11111111-2222-4333-8444-555555555555',
    response_type: 'code',
    redirect_uri: 'http://127.0.0.1:1455/auth/callback',
    scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    resource: 'https://api.openai.com/v1',
    state: 'st',
    nonce: 'no',
    code_challenge_method: 'S256',
    code_challenge: 'ch',
  });
  expect(AGENT_NAME).toBe('teneral');
  expect(SCOPE).toContain('chatgpt.tokens.use.direct');
});

test('signing in again uses the issued client id, drops the name hint and names the account by its last ID token', () => {
  const q = new URL(authorizeUrl({
    issuer: 'https://auth.openai.com', clientId: 'oaiapp_abc', redirectUri: redirectUri(54321), resource: 'https://api.openai.com/v1',
    hostId: 'urn:uuid:x', state: 's', nonce: 'n', challenge: 'c', idTokenHint: 'old.id.token',
  })).searchParams;
  expect(q.get('client_id')).toBe('oaiapp_abc');
  expect(q.has('agent_name_hint')).toBe(false);
  expect(q.get('id_token_hint')).toBe('old.id.token');
  expect(q.get('redirect_uri')).toBe('http://127.0.0.1:54321/auth/callback');
});

test('the host id is an opaque urn:uuid, made once and kept', () => {
  const first = hostId(dir);
  expect(first).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(hostId(dir)).toBe(first);
  expect(mode(join(dir, 'host-id'))).toBe(0o600);
});

test('the callback listener takes only the request that carries this attempt\'s state', async () => {
  const port = freePort();
  const listener = listenForCallback({ port, hostname: '127.0.0.1', state: 'right' });
  try {
    expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/auth/callback?code=stolen&state=wrong&client_id=oaiapp_evil`)).status).toBe(400);
    const res = await fetch(`http://127.0.0.1:${port}/auth/callback?code=c1&state=right&client_id=oaiapp_1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Signed in');
    expect(await listener.done).toEqual({ code: 'c1', clientId: 'oaiapp_1' });
  } finally {
    listener.stop();
  }
});

test('a declined sign-in ends the attempt and says so', async () => {
  const port = freePort();
  const listener = listenForCallback({ port, hostname: '127.0.0.1', state: 's' });
  try {
    await fetch(`http://127.0.0.1:${port}/auth/callback?error=access_denied&state=s`);
    await expect(listener.done).rejects.toThrow(/declined.*access_denied/);
  } finally {
    listener.stop();
  }
});

// --- the whole sign-in, against a local authorization server ---

test('a first sign-in registers, exchanges the code with PKCE and no secret, and stores the result for the owner only', async () => {
  const { cred, shown } = await signInHere();
  expect(new URL(shown).searchParams.get('client_id')).toBe('dynamic_agent_client');

  const exchange = fake.seen.find((r) => r.path === '/api/accounts/oauth/token')!;
  expect(exchange.headers['content-type']).toContain('application/x-www-form-urlencoded');
  // Every request to the sign-in server says who is asking.
  for (const r of fake.seen.filter((seen) => seen.path !== '/api/accounts/authorize')) expect(r.headers['user-agent']).toMatch(/^teneral\/\d/);
  expect(fake.seen.map((r) => r.path)).toEqual(['/api/accounts/authorize', '/api/accounts/oauth/token', '/.well-known/jwks.json']);
  const form = exchange.body as Record<string, string>;
  expect(Object.keys(form).sort()).toEqual(['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri', 'resource']);
  expect(form.grant_type).toBe('authorization_code');
  // The issued id, never the registration entry point.
  expect(form.client_id).toMatch(/^oaiapp_/);
  expect(form.resource).toBe(fake.api);
  expect(form.redirect_uri).toBe(new URL(shown).searchParams.get('redirect_uri')!);
  expect(challengeOf(form.code_verifier!)).toBe(new URL(shown).searchParams.get('code_challenge')!);

  const file = join(dir, 'chatgpt.json');
  expect(mode(file)).toBe(0o600);
  expect(mode(dir)).toBe(0o700);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(cred);
  expect(cred).toMatchObject({
    email: 'owner@example.com', issuer: fake.url, subject: 'user-fake-1', client_id: form.client_id, ext_agent_host_id: hostId(dir),
    token_type: 'Bearer', expires_in: 3600, api_base: fake.api,
  });
  expect(cred.access_token).toMatch(/^at-fake-/);
  expect(cred.refresh_token).toMatch(/^rt-fake-/);
  expect(cred.scopes).toContain('chatgpt.tokens.use.direct');
  expect(cred.expires_at).toBeGreaterThan(Date.now() + 3_000_000);
  // No temp file is left beside it, and the lock is not held.
  expect(readdirSync(dir).sort()).toEqual(['chatgpt.json', 'host-id']);
  expect(signedIn(dir, 'chatgpt')).toBe(true);
  expect(apiBase(dir)).toBe(fake.api);
});

test('a later sign-in reuses the registered client and the host id; a fresh one registers anew', async () => {
  const first = (await signInHere()).cred;
  const again = await signInHere();
  const q = new URL(again.shown).searchParams;
  expect(q.get('client_id')).toBe(first.client_id);
  expect(q.has('agent_name_hint')).toBe(false);
  expect(q.get('id_token_hint')).toBe(first.id_token);
  expect(q.get('ext_agent_host_id')).toBe(first.ext_agent_host_id);
  expect(again.cred.client_id).toBe(first.client_id);
  expect(again.cred.access_token).not.toBe(first.access_token);

  const other = await signInHere({ fresh: true });
  expect(new URL(other.shown).searchParams.get('client_id')).toBe('dynamic_agent_client');
  expect(other.cred.client_id).not.toBe(first.client_id);
  expect(other.cred.ext_agent_host_id).toBe(first.ext_agent_host_id);
});

test('nothing is stored when the registration issues no client id, the plan is not granted, or the owner declines', async () => {
  fake.knobs.omitClientId = true;
  await expect(signInHere()).rejects.toThrow(/registration is incomplete/);
  fake.knobs.omitClientId = false;
  fake.knobs.scope = 'email offline_access openid profile';
  await expect(signInHere()).rejects.toThrow(/without permission to use the ChatGPT plan/);
  fake.knobs.deny = true;
  await expect(signInHere()).rejects.toThrow(/declined/);
  expect(existsSync(join(dir, 'chatgpt.json'))).toBe(false);
  expect(signedIn(dir, 'chatgpt')).toBe(false);
});

test('an ID token with another nonce or a signature from an unpublished key is refused, and nothing is stored', async () => {
  fake.knobs.nonce = 'someone-elses';
  await expect(signInHere()).rejects.toThrow(/does not answer this sign-in attempt/);
  fake.knobs.nonce = null;
  fake.knobs.wrongKey = true;
  await expect(signInHere()).rejects.toThrow(/signature does not match/);
  expect(existsSync(join(dir, 'chatgpt.json'))).toBe(false);
});

test('verifyIdToken checks issuer, audience and expiry', async () => {
  const { cred } = await signInHere();
  const keys = (await (await fetch(`${fake.url}/.well-known/jwks.json`)).json() as { keys: JsonWebKey[] }).keys;
  const nonce = JSON.parse(Buffer.from(cred.id_token.split('.')[1]!, 'base64url').toString()).nonce as string;
  const ok = { keys, issuer: fake.url, audience: cred.client_id, nonce };
  expect((await verifyIdToken(cred.id_token, ok)).sub).toBe('user-fake-1');
  await expect(verifyIdToken(cred.id_token, { ...ok, issuer: 'https://elsewhere.example' })).rejects.toThrow(/issued by someone else/);
  await expect(verifyIdToken(cred.id_token, { ...ok, audience: 'oaiapp_other' })).rejects.toThrow(/another client/);
  await expect(verifyIdToken(cred.id_token, { ...ok, now: Date.now() + 2 * 3600_000 })).rejects.toThrow(/expired/);
  const [h, , s] = cred.id_token.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ iss: fake.url, aud: cred.client_id, sub: 'attacker', nonce, exp: 9999999999 })).toString('base64url')}.${s}`;
  await expect(verifyIdToken(forged, ok)).rejects.toThrow(/signature does not match/);
  const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${cred.id_token.split('.')[1]}.`;
  await expect(verifyIdToken(unsigned, ok)).rejects.toThrow(/not RS256/);
});

test('a callback that names a different client than the registered one changes nothing', async () => {
  const first = (await signInHere()).cred;
  await expect(signInHere({
    browser: async (url) => {
      const back = new URL(await fake.consent(url));
      back.searchParams.set('client_id', 'oaiapp_someone_else');
      await fetch(back);
    },
  })).rejects.toThrow(/different client/);
  expect(readCredentials(dir, 'chatgpt')).toEqual(first);
});

// --- access tokens ---

test('a token that is not near its expiry is returned as it is, without asking anyone', async () => {
  const { cred } = await signInHere();
  const before = fake.seen.length;
  expect(await accessToken(dir)).toBe(cred.access_token);
  expect(fake.seen.length).toBe(before);
});

test('near expiry the token is renewed with the issued client id, and the rotated refresh token is stored with it', async () => {
  const { cred } = await signInHere();
  const later = () => cred.expires_at - 60_000;
  const token = await accessToken(dir, { now: later });
  expect(token).not.toBe(cred.access_token);
  const form = fake.seen.at(-1)!.body as Record<string, string>;
  expect(form).toEqual({ grant_type: 'refresh_token', client_id: cred.client_id, refresh_token: cred.refresh_token, resource: fake.api });
  const stored = readCredentials(dir, 'chatgpt')!;
  expect(stored.access_token).toBe(token);
  expect(stored.refresh_token).not.toBe(cred.refresh_token);
  expect(stored.client_id).toBe(cred.client_id);
  expect(stored.expires_at).toBe(later() + 3600_000);
  expect(mode(join(dir, 'chatgpt.json'))).toBe(0o600);
  expect(readdirSync(dir).sort()).toEqual(['chatgpt.json', 'host-id']);
  // The new refresh token works in its turn; the old one would not.
  await accessToken(dir, { now: () => stored.expires_at });
  expect(fake.refreshes).toBe(2);
});

test('two callers at once make exactly one refresh, and both get its token', async () => {
  const { cred } = await signInHere();
  fake.knobs.refreshDelayMs = 150;
  const now = () => cred.expires_at + 1000;
  const tokens = await Promise.all([accessToken(dir, { now }), accessToken(dir, { now }), accessToken(dir, { now })]);
  expect(fake.refreshes).toBe(1);
  expect(new Set(tokens).size).toBe(1);
  expect(tokens[0]).toBe(readCredentials(dir, 'chatgpt')!.access_token);
});

test('two processes at once make exactly one refresh', async () => {
  const { cred } = await signInHere();
  fake.knobs.refreshDelayMs = 300;
  const script = join(dir, '..', 'refresh.ts');
  writeFileSync(script, `import { accessToken } from ${JSON.stringify(join(import.meta.dir, '..', '..', 'kernel', 'signin'))};\n`
    + `console.log(await accessToken(${JSON.stringify(dir)}, { now: () => ${cred.expires_at + 1000} }));\n`);
  const run = () => Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'inherit' });
  const [a, b] = [run(), run()];
  const [outA, outB] = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text()]);
  expect(fake.refreshes).toBe(1);
  expect(outA.trim()).toBe(outB.trim());
  expect(outA.trim()).toBe(readCredentials(dir, 'chatgpt')!.access_token);
}, 20_000);

test('a token the API refused is replaced, unless another process already replaced it', async () => {
  const { cred } = await signInHere();
  const renewed = await accessToken(dir, { rejected: cred.access_token });
  expect(renewed).not.toBe(cred.access_token);
  expect(fake.refreshes).toBe(1);
  // A second process that was refused the same old token finds the new one in the file.
  expect(await accessToken(dir, { rejected: cred.access_token })).toBe(renewed);
  expect(fake.refreshes).toBe(1);
});

test('a refresh token that has ended gives a clear error, and the tokens go while the registration stays', async () => {
  const { cred } = await signInHere();
  for (const code of ['invalid_grant', 'refresh_token_expired', 'refresh_token_reused']) {
    saveCredentials(dir, 'chatgpt', cred);
    fake.knobs.refreshError = code;
    const err = await accessToken(dir, { now: () => cred.expires_at }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignInNeeded);
    expect((err as Error).message).toContain('sign in again with ./box setup');
    expect((err as Error).message).toContain(code);
    expect((err as Error).message).not.toContain(cred.refresh_token);
    const left = readCredentials(dir, 'chatgpt')!;
    expect(left).toMatchObject({ access_token: '', refresh_token: '', client_id: cred.client_id, id_token: cred.id_token });
    expect(signedIn(dir, 'chatgpt')).toBe(false);
    // And from then on without asking the server again.
    const asked = fake.seen.length;
    await expect(accessToken(dir)).rejects.toThrow(/sign in again with \.\/box setup/);
    expect(fake.seen.length).toBe(asked);
  }
});

test('no sign-in at all gives the same clear error', async () => {
  await expect(accessToken(dir)).rejects.toThrow(/sign in again with \.\/box setup/);
  expect(() => apiBase(dir)).toThrow(SignInNeeded);
});

test('a fault on the server\'s side keeps the tokens: the current one is used while it lasts, then the fault is reported', async () => {
  const { cred } = await signInHere();
  fake.knobs.refreshStatus = 503;
  expect(await accessToken(dir, { now: () => cred.expires_at - 60_000 })).toBe(cred.access_token);
  const err = await accessToken(dir, { now: () => cred.expires_at + 1 }).catch((e: unknown) => e);
  expect(err).not.toBeInstanceOf(SignInNeeded);
  expect((err as Error).message).toMatch(/503/);
  expect(readCredentials(dir, 'chatgpt')).toEqual(cred);
});

test('a lock left by a process that died is taken over', async () => {
  const { cred } = await signInHere();
  const lock = join(dir, 'chatgpt.lock');
  writeFileSync(lock, '');
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
  expect(await accessToken(dir, { now: () => cred.expires_at })).not.toBe(cred.access_token);
  expect(existsSync(lock)).toBe(false);
});

test('tokens are renewed where they were issued, whatever the environment says', async () => {
  const { cred } = await signInHere();
  const asked: string[] = [];
  const spy = (async (url: string, init?: RequestInit) => { asked.push(String(url)); return fetch(url, init); }) as unknown as typeof fetch;
  await accessToken(dir, { now: () => cred.expires_at, fetch: spy });
  expect(asked).toEqual([`${fake.url}/api/accounts/oauth/token`]);
});
