import { createHash } from 'node:crypto';

// A stand-in for OpenAI, for tests: the sign-in endpoints, the list of models, the Responses API
// as a stream and chat-completions. It is as strict as the documentation of the ChatGPT plan route
// reads, so a request that the fake takes is one the documentation allows; whether the real
// service agrees in every detail cannot be shown here.

export interface FakeReply {
  /** Plain text for the model to say. */
  text?: string;
  /** Tool calls for the model to make. */
  calls?: { name: string; args: unknown }[];
  /** Answer with this HTTP status and JSON body instead of a stream. */
  status?: number;
  body?: unknown;
  /** Start the stream, then end it with `response.failed` carrying this error code. */
  fail?: string;
  /** Start the stream and stop in the middle, with no final event. */
  cut?: boolean;
}

export interface FakeOpenAi {
  /** The issuer: what the sign-in endpoints hang off. */
  url: string;
  /** The API base, `<url>/v1`. */
  api: string;
  stop: () => void;
  /** API keys the fake accepts. */
  keys: Set<string>;
  /** Answers for the next model requests, first in, first out. With none waiting, the fake decides by itself. */
  replies: FakeReply[];
  /** Every request received: method, path, headers and the parsed body. */
  seen: { method: string; path: string; headers: Record<string, string>; body: unknown }[];
  /** How often a refresh token was exchanged successfully. */
  refreshes: number;
  knobs: {
    /** Seconds an access token lives. */
    expiresIn: number;
    /** What the consent page grants. */
    scope: string;
    /** The owner declines at the consent page. */
    deny: boolean;
    /** The callback of a new registration leaves out the issued client id. */
    omitClientId: boolean;
    /** Refuse every refresh with this OAuth error code. */
    refreshError: string | null;
    /** Answer every refresh with this status and no error code. */
    refreshStatus: number | null;
    /** Milliseconds a refresh takes, so two callers overlap. */
    refreshDelayMs: number;
    /** The `nonce` put in ID tokens instead of the one asked for. */
    nonce: string | null;
    /** Sign ID tokens with a key the fake does not publish. */
    wrongKey: boolean;
  };
  /** Makes every access token issued so far invalid at the API, as a disconnect in the account settings would. */
  revokeAccess: () => void;
  /** Follows the authorize address as a browser would, up to the redirect back to the app. Returns where that points. */
  consent: (authorizeUrl: string) => Promise<string>;
}

const b64 = (value: unknown): string => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/** The fields the documentation lists as not accepted on the ChatGPT plan route. */
const UNSUPPORTED = [
  'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt',
  'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id',
];

/** `publicUrl` is the address clients know the fake by, when that is not the one it listens on. */
export async function startFakeOpenAi(o: { port?: number; hostname?: string; expiresIn?: number; publicUrl?: string } = {}): Promise<FakeOpenAi> {
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  const pair = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const other = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'fake-key-1', use: 'sig', alg: 'RS256' };

  /** Pending authorization codes. */
  const codes = new Map<string, { client: string; challenge: string; redirect: string; nonce: string; resource: string }>();
  /** Issued client ids. */
  const clients = new Set<string>();
  /** The one refresh token each client's session currently accepts. */
  const sessions = new Map<string, string>();
  /** Access tokens and when each expires. */
  const access = new Map<string, number>();
  let serial = 0;

  const fake: FakeOpenAi = {
    url: '', api: '', stop: () => {}, keys: new Set(['sk-fake-key']), replies: [], seen: [], refreshes: 0,
    knobs: {
      expiresIn: o.expiresIn ?? 3600, scope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke',
      deny: false, omitClientId: false, refreshError: null, refreshStatus: null, refreshDelayMs: 0, nonce: null, wrongKey: false,
    },
    revokeAccess: () => { access.clear(); },
    consent: async (authorizeUrl) => {
      const res = await fetch(authorizeUrl, { redirect: 'manual' });
      const to = res.headers.get('location');
      if (res.status !== 302 || to === null) throw new Error(`the fake refused the authorize request: ${res.status} ${await res.text()}`);
      return to;
    },
  };

  const idToken = async (client: string, nonce: string): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: 'RS256', typ: 'JWT', kid: jwk.kid });
    const claims = b64({
      iss: fake.url, aud: client, sub: 'user-fake-1', email: 'owner@example.com', nonce: fake.knobs.nonce ?? nonce, iat: now, exp: now + 3600,
    });
    const key = fake.knobs.wrongKey ? other.privateKey : pair.privateKey;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claims}`));
    return `${head}.${claims}.${Buffer.from(signature).toString('base64url')}`;
  };

  const issue = async (client: string, nonce: string) => {
    serial += 1;
    const token = `at-fake-${serial}`;
    const refresh = `rt-fake-${serial}`;
    access.set(token, Date.now() + fake.knobs.expiresIn * 1000);
    sessions.set(client, refresh);
    return {
      access_token: token, refresh_token: refresh, id_token: await idToken(client, nonce), token_type: 'Bearer',
      expires_in: fake.knobs.expiresIn, scope: fake.knobs.scope,
    };
  };

  const oauthError = (status: number, code: string) => Response.json({ error: code, error_description: `fake: ${code}` }, { status });
  const apiError = (status: number, code: string, message: string, param: string | null = null) => (
    Response.json({ error: { message, type: 'invalid_request_error', param, code } }, { status })
  );

  /** `key` for an API key, `plan` for a live access token, else null. */
  const who = (req: Request): 'key' | 'plan' | null => {
    const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
    if (fake.keys.has(bearer)) return 'key';
    return (access.get(bearer) ?? 0) > Date.now() ? 'plan' : null;
  };

  /** What the model does when no reply is waiting: follow an instruction in the newest user text, else say something short. */
  const decide = (lastUser: string, afterToolResult: boolean, toolNames: string[]): FakeReply => {
    if (afterToolResult) return { text: 'The fake model saw the tool result.' };
    const asked = /\[\[call (\w+) (\{.*?\})\]\]/s.exec(lastUser);
    if (asked) return { calls: [{ name: asked[1]!, args: JSON.parse(asked[2]!) }] };
    if (toolNames.includes('ping') && /ping/i.test(lastUser)) return { calls: [{ name: 'ping', args: {} }] };
    return { text: 'ready' };
  };

  const sse = (events: unknown[], open = false): Response => new Response(
    events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('') + (open ? 'event: response.output_text.delta\ndata: {"type":"response.output_te' : ''),
    { headers: { 'content-type': 'text/event-stream' } },
  );

  const responses = (req: Request, body: Record<string, unknown>): Response => {
    const caller = who(req);
    if (caller === null) return apiError(401, 'invalid_api_key', 'Incorrect API key or token provided.');
    if (body.store !== false || body.stream !== true) return apiError(400, 'subscription_sharing_unsupported_capability', 'store must be false and stream true', 'store');
    if (typeof body.model !== 'string' || body.model === '') return apiError(400, 'missing_required_parameter', 'model is required', 'model');
    if (!Array.isArray(body.input)) return apiError(400, 'invalid_type', 'input must be an array of items', 'input');
    const tools = Array.isArray(body.tools) ? body.tools as Record<string, unknown>[] : [];
    if (caller === 'plan') {
      const field = UNSUPPORTED.find((name) => name in body);
      if (field) return apiError(400, 'subscription_sharing_unsupported_capability', `${field} is not supported`, field);
      if (tools.some((t) => t.type !== 'namespace')) return apiError(400, 'subscription_sharing_unsupported_capability', 'function tools must be grouped in a namespace', 'tools');
    }
    const flat = tools.flatMap((t) => (t.type === 'namespace' ? (t.tools as Record<string, unknown>[]).map((inner) => ({ ...inner, namespace: t.name })) : [t]));
    if (flat.some((t) => t.type !== 'function' || typeof t.name !== 'string' || typeof t.parameters !== 'object')) return apiError(400, 'invalid_type', 'a tool is not a function tool', 'tools');
    const open = new Set<unknown>();
    let lastUser = '';
    const items = body.input as Record<string, unknown>[];
    for (const [i, item] of items.entries()) {
      if ('id' in item) return apiError(400, 'invalid_request_error', `input[${i}] names an item id, which nothing stored can resolve`, `input[${i}].id`);
      if (item.role === 'system') return apiError(400, 'subscription_sharing_unsupported_capability', 'system messages are rejected; use instructions', `input[${i}]`);
      if (item.type === 'function_call') {
        if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') return apiError(400, 'invalid_type', 'a function_call lacks call_id, name or arguments', `input[${i}]`);
        open.add(item.call_id);
      } else if (item.type === 'function_call_output') {
        if (!open.delete(item.call_id)) return apiError(400, 'invalid_request_error', `No tool call found for function call output with call_id ${String(item.call_id)}.`, `input[${i}]`);
        if (typeof item.output !== 'string') return apiError(400, 'invalid_type', 'output must be text', `input[${i}].output`);
      } else if (item.role === 'user' || item.role === 'assistant' || item.role === 'developer') {
        if (typeof item.content !== 'string' || item.content === '') return apiError(400, 'invalid_type', 'a message has no text', `input[${i}].content`);
        if (item.role === 'user') lastUser = item.content;
      } else {
        return apiError(400, 'invalid_type', 'an input item is of no known kind', `input[${i}]`);
      }
    }
    if (open.size > 0) return apiError(400, 'invalid_request_error', `No tool output found for function call ${String([...open][0])}.`, 'input');

    const reply = fake.replies.shift() ?? decide(lastUser, items.at(-1)?.type === 'function_call_output', flat.map((t) => t.name as string));
    if (reply.status !== undefined) return Response.json(reply.body ?? {}, { status: reply.status });
    serial += 1;
    const head = { id: `resp_fake_${serial}`, object: 'response', model: body.model, store: false };
    const created = { type: 'response.created', response: { ...head, status: 'in_progress', output: [] } };
    if (reply.cut) return sse([created], true);
    if (reply.fail !== undefined) {
      return sse([created, { type: 'response.failed', response: { ...head, status: 'failed', output: [], error: { code: reply.fail, message: `fake: ${reply.fail}` } } }]);
    }
    // A reasoning item comes first, as a reasoning model sends one; a client that does not carry reasoning forward must cope with it.
    const output: Record<string, unknown>[] = [{ type: 'reasoning', id: `rs_fake_${serial}`, summary: [], encrypted_content: 'opaque' }];
    if (reply.text !== undefined) {
      output.push({ type: 'message', id: `msg_fake_${serial}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply.text, annotations: [] }] });
    }
    for (const [n, call] of (reply.calls ?? []).entries()) {
      const tool = flat.find((t) => t.name === call.name);
      output.push({
        type: 'function_call', id: `fc_fake_${serial}_${n}`, call_id: `call_fake_${serial}_${n}`, name: call.name,
        arguments: JSON.stringify(call.args), status: 'completed', ...(tool?.namespace ? { namespace: tool.namespace } : {}),
      });
    }
    return sse([
      created,
      ...output.flatMap((item, output_index) => [
        ...(item.type === 'message' ? [{ type: 'response.output_text.delta', output_index, delta: reply.text }] : []),
        { type: 'response.output_item.done', output_index, item },
      ]),
      { type: 'response.completed', response: { ...head, status: 'completed', output } },
    ]);
  };

  const chat = (req: Request, body: Record<string, unknown>): Response => {
    if (who(req) !== 'key') return apiError(401, 'invalid_api_key', 'Incorrect API key provided.');
    const messages = Array.isArray(body.messages) ? body.messages as { role: string; content: string | null }[] : [];
    const lastUser = messages.findLast((m) => m.role === 'user')?.content ?? '';
    const tools = (Array.isArray(body.tools) ? body.tools : []) as { function: { name: string } }[];
    const reply = fake.replies.shift() ?? decide(lastUser, messages.at(-1)?.role === 'tool', tools.map((t) => t.function.name));
    if (reply.status !== undefined) return Response.json(reply.body ?? {}, { status: reply.status });
    serial += 1;
    const tool_calls = (reply.calls ?? []).map((call, n) => ({
      id: `call_fake_${serial}_${n}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) },
    }));
    return Response.json({
      id: `chatcmpl-fake-${serial}`, object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: reply.text ?? null, ...(tool_calls.length > 0 ? { tool_calls } : {}) }, finish_reason: 'stop' }],
    });
  };

  const server = Bun.serve({
    hostname: o.hostname ?? '127.0.0.1',
    port: o.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = req.method === 'POST' ? await req.text() : '';
      const form = new URLSearchParams(text);
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* a form, or nothing */ }
      const isForm = (req.headers.get('content-type') ?? '').includes('x-www-form-urlencoded');
      fake.seen.push({
        method: req.method, path: url.pathname, headers: Object.fromEntries(req.headers.entries()),
        body: req.method !== 'POST' ? Object.fromEntries(url.searchParams.entries()) : isForm ? Object.fromEntries(form.entries()) : json,
      });

      if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') return Response.json({ keys: [jwk] });

      if (req.method === 'GET' && url.pathname === '/api/accounts/authorize') {
        const q = url.searchParams;
        const need = ['client_id', 'ext_agent_host_id', 'redirect_uri', 'scope', 'resource', 'state', 'nonce', 'code_challenge'];
        const absent = need.filter((name) => !q.get(name));
        if (absent.length > 0) return new Response(`missing ${absent.join(', ')}`, { status: 400 });
        if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256') return new Response('not a PKCE code request', { status: 400 });
        const redirect = q.get('redirect_uri')!;
        if (!/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(redirect)) return new Response('redirect_uri is not the loopback callback', { status: 400 });
        if (!/^(urn:uuid:|urn:ietf:params:oauth:jwk-thumbprint:|did:key:)/.test(q.get('ext_agent_host_id')!)) return new Response('bad host id', { status: 400 });
        let client = q.get('client_id')!;
        const registering = client === 'dynamic_agent_client';
        if (registering) {
          if (!q.get('agent_name_hint')) return new Response('a registration needs agent_name_hint', { status: 400 });
          serial += 1;
          client = `oaiapp_fake${serial}`;
          clients.add(client);
        } else {
          if (!clients.has(client)) return new Response('unknown client', { status: 400 });
          if (q.get('agent_name_hint')) return new Response('agent_name_hint belongs to a registration only', { status: 400 });
        }
        const back = new URL(redirect);
        back.searchParams.set('state', q.get('state')!);
        if (fake.knobs.deny) {
          back.searchParams.set('error', 'access_denied');
          return Response.redirect(back.toString(), 302);
        }
        serial += 1;
        const code = `code-fake-${serial}`;
        codes.set(code, { client, challenge: q.get('code_challenge')!, redirect, nonce: q.get('nonce')!, resource: q.get('resource')! });
        back.searchParams.set('code', code);
        back.searchParams.set('scope', fake.knobs.scope);
        if (registering && !fake.knobs.omitClientId) back.searchParams.set('client_id', client);
        return Response.redirect(back.toString(), 302);
      }

      if (req.method === 'POST' && url.pathname === '/api/accounts/oauth/token') {
        if (!isForm) return oauthError(400, 'invalid_request');
        if (form.has('client_secret')) return oauthError(400, 'invalid_client');
        const client = form.get('client_id') ?? '';
        if (!clients.has(client)) return oauthError(401, 'invalid_client');
        if (form.get('grant_type') === 'authorization_code') {
          const code = form.get('code') ?? '';
          const pending = codes.get(code);
          codes.delete(code);
          const verifier = form.get('code_verifier') ?? '';
          if (!pending || pending.client !== client || pending.redirect !== form.get('redirect_uri') || pending.resource !== form.get('resource')
            || createHash('sha256').update(verifier).digest('base64url') !== pending.challenge) return oauthError(400, 'invalid_grant');
          return Response.json(await issue(client, pending.nonce));
        }
        if (form.get('grant_type') === 'refresh_token') {
          if (fake.knobs.refreshDelayMs > 0) await new Promise((resolve) => { setTimeout(resolve, fake.knobs.refreshDelayMs); });
          if (fake.knobs.refreshStatus !== null) return new Response('upstream trouble', { status: fake.knobs.refreshStatus });
          if (fake.knobs.refreshError !== null) return oauthError(400, fake.knobs.refreshError);
          if (form.has('scope') || !form.get('resource')) return oauthError(400, 'invalid_request');
          // Rotation: only the newest refresh token of a session works; an older one was already used.
          if (sessions.get(client) !== form.get('refresh_token')) return oauthError(400, 'refresh_token_reused');
          fake.refreshes += 1;
          return Response.json(await issue(client, ''));
        }
        return oauthError(400, 'unsupported_grant_type');
      }

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const caller = who(req);
        if (caller === null) return apiError(401, 'invalid_api_key', 'Incorrect API key or token provided.');
        if (caller === 'plan') {
          return Response.json({ models: [
            { slug: 'fake-plan-large', display_name: 'Fake Large', visibility: 'list' },
            { slug: 'fake-plan-hidden', display_name: 'Hidden', visibility: 'hide' },
            { slug: 'fake-plan-small', display_name: 'Fake Small', visibility: 'list' },
          ] });
        }
        return Response.json({ object: 'list', data: [{ id: 'fake-key-large', object: 'model' }, { id: 'fake-key-small', object: 'model' }] });
      }

      if (req.method === 'POST' && url.pathname === '/v1/responses') return responses(req, json);
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return chat(req, json);
      // Nothing of ChatGPT's own lives here, and a client that asks for it is wrong.
      return new Response('not found', { status: 404 });
    },
  });
  fake.url = o.publicUrl ?? `http://${o.hostname === '0.0.0.0' ? '127.0.0.1' : server.hostname}:${server.port}`;
  fake.api = `${fake.url}/v1`;
  fake.stop = () => { void server.stop(true); };
  return fake;
}
