import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The model providers an owner can choose from. One table: the setup offers its entries, the
// kernel checks a configuration against it, and the body picks its wire protocol from it. A new
// provider is a new entry here.

/** `chat`: chat-completions. `responses`: the Responses API, streamed. */
export type Wire = 'chat' | 'responses';
/** `key`: a key in `.env`. `chatgpt-signin`: the owner signs in at OpenAI; tokens are kept in the auth directory. */
export type Auth = 'key' | 'chatgpt-signin';

export interface ProviderEntry {
  /** What `TENERAL_PROVIDER` holds. */
  id: string;
  /** What the owner is shown. */
  name: string;
  wire: Wire;
  auth: Auth;
  /** Where requests go; null when the owner types it in. */
  baseUrl: string | null;
  /** Offered when the endpoint's own list of models cannot be had. The owner may always type another. */
  models: readonly string[];
  /**
   * How function tools are declared on the Responses wire: as they are (`flat`), or grouped in one
   * namespace, which is what the ChatGPT plan route asks for.
   */
  tools: 'flat' | 'namespace';
  /** Shown during setup, before anything is asked. */
  notes: readonly string[];
}

/** Where the owner reviews what an app used of their ChatGPT plan. */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

export const PROVIDERS: readonly ProviderEntry[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT plan (Continue with ChatGPT)',
    wire: 'responses',
    auth: 'chatgpt-signin',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-6.1-sol'],
    tools: 'namespace',
    notes: [
      'Uses your ChatGPT Plus or Pro plan for the agent\'s requests, through OpenAI\'s sign-in for open-source apps that run locally.',
      'You sign in on a page at OpenAI in your own browser. teneral never sees your password.',
      'The tokens OpenAI issues are stored in .teneral/auth/, readable only by you, and by the agent\'s own shell.',
      `What the agent uses counts against your plan; review and limit it at ${CHATGPT_USAGE_URL}`,
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI API key',
    wire: 'responses',
    auth: 'key',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-6.1-sol'],
    tools: 'flat',
    notes: ['Pay as you go, with a key from your OpenAI account. The key is stored in .env.'],
  },
  {
    id: 'compatible',
    name: 'Another OpenAI-compatible endpoint',
    wire: 'chat',
    auth: 'key',
    baseUrl: null,
    models: [],
    tools: 'flat',
    notes: ['Any chat-completions endpoint: you give its base URL, a key and a model that supports tool calls. All three are stored in .env.'],
  },
  {
    // As Kimi Code's own page for third-party tools gives it: https://www.kimi.com/code/docs/en/third-party-tools/codex.html, read 2026-11-13.
    // "The Kimi Code server natively supports the OpenAI Responses API (streaming and non-streaming, reasoning, and function calling all work)."
    id: 'kimi',
    name: 'Kimi Code plan (API key from the Kimi Code Console)',
    wire: 'responses',
    auth: 'key',
    baseUrl: 'https://api.kimi.ai/coding/v1',
    models: ['k3.1-pro', 'k3.1-pro-highspeed', 'k3', 'kimi-for-coding'],
    tools: 'flat',
    notes: [
      'Uses your Kimi membership with Kimi Code benefits for the agent\'s requests, with an API key you create in the Kimi Code Console. The key is stored in .env.',
      'Which models your key may use depends on your plan; the Console and Kimi Code\'s "Membership Benefits" page say which.',
      'Requests go to https://api.kimi.ai/coding/v1. In mainland China the address is https://api.kimi.com/coding/v1: set TENERAL_BASE_URL in .env to it after the setup.',
    ],
  },
];

/** What a configuration without `TENERAL_PROVIDER`, or with one this table does not know, is taken as. */
export const DEFAULT_PROVIDER = 'compatible';

export function findProvider(id: string | undefined): ProviderEntry | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

export function providerFor(id: string | undefined): ProviderEntry {
  return findProvider(id) ?? findProvider(DEFAULT_PROVIDER)!;
}

/** The directory sign-in credentials live in. Never committed, never inside the agent's workspace. */
export function authDir(root: string): string {
  return join(root, '.teneral', 'auth');
}

export function credentialFile(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

/** What `env` still lacks before an agent can be started from `root`; empty when nothing. */
export function missingConfig(
  env: Record<string, string | undefined>, root: string, exists: (path: string) => boolean = existsSync,
): string[] {
  const entry = providerFor(env.TENERAL_PROVIDER);
  const missing = (names: string[]) => names.filter((name) => !env[name]);
  if (entry.auth === 'key') return missing(['TENERAL_BASE_URL', 'TENERAL_API_KEY', 'TENERAL_MODEL']);
  const file = credentialFile(authDir(root), entry.id);
  return [...missing(['TENERAL_MODEL']), ...(exists(file) ? [] : [`the sign-in stored in ${file}`])];
}

/**
 * The line the owner is shown while their ChatGPT plan pays for the agent's requests, with where to
 * manage that; null for a provider that is paid for some other way.
 */
export function planNotice(env: Record<string, string | undefined>): string | null {
  return providerFor(env.TENERAL_PROVIDER).auth === 'chatgpt-signin' ? `Using ChatGPT plan. Manage usage: ${CHATGPT_USAGE_URL}` : null;
}

/**
 * Context windows in tokens, as each model's own page states them ("Model details", the line
 * "context window"): https://developers.openai.com/api/docs/models/<model id>, read 2026-11-12.
 * Only what a page says is here. The pages warn that a window can differ between snapshots of a
 * model, so a name is matched whole and a snapshot not listed is not guessed at.
 */
const WINDOWS: Readonly<Record<string, number>> = {
  'gpt-6.1-sol': 1_050_000, 'gpt-6.1-terra': 1_050_000,
  'gpt-6-astra': 1_050_000, 'gpt-6-sol': 1_050_000, 'gpt-6-luna': 1_050_000, 'gpt-6-cyber': 1_050_000,
  'gpt-5.6-sol': 1_050_000, 'gpt-5.6-terra': 1_050_000, 'gpt-5.6-luna': 1_050_000, 'gpt-5.6-cyber': 400_000,
  'gpt-5.5': 1_050_000, 'gpt-5.5-pro': 1_050_000, 'gpt-5.4': 1_050_000, 'gpt-5.4-pro': 1_050_000, 'gpt-5.4-mini': 400_000,
  'gpt-5.2': 400_000, 'gpt-5.2-pro': 400_000,
  // Kimi Code, from the table of plans on https://www.kimi.com/code/docs/en/third-party-tools/codex.html, read 2026-11-13.
  // Where a model's window depends on the plan, the smaller is taken, as the one that does not promise room that may not be there.
  'k3.1-pro': 262_144, 'k3.1-pro-highspeed': 1_048_576, 'k3': 262_144, 'k3-256k': 262_144, 'kimi-for-coding': 1_048_576, 'kimi-for-coding-highspeed': 262_144,
};

/**
 * Where a ChatGPT plan pays, the window can be smaller than the API's. The page of gpt-6.1-sol says:
 * "GPT-6.1 Sol uses a default context window of 500K tokens in Codex and ChatGPT Work." It does not
 * name the sign-in route teneral uses; the smaller number is taken for it, as the one that does not
 * promise room that may not be there.
 */
const PLAN_WINDOWS: Readonly<Record<string, number>> = { 'gpt-6.1-sol': 500_000 };

/**
 * The model's context window in tokens, or null when it is not known: a model the table does not
 * hold, or the hand-typed endpoint, where a model's name says nothing certain about who serves it.
 */
export function contextWindow(provider: string, model: string): number | null {
  const entry = findProvider(provider);
  if (entry === null || entry.baseUrl === null) return null;
  const known = (table: Readonly<Record<string, number>>): number | null => (Object.hasOwn(table, model) ? table[model]! : null);
  return (entry.auth === 'chatgpt-signin' ? known(PLAN_WINDOWS) : null) ?? known(WINDOWS);
}

let agent: string | null = null;
/**
 * Who is asking, on every request teneral makes of a provider or a sign-in server: its own name
 * and the version in its package.json. Never another program's.
 */
export function userAgent(): string {
  if (agent === null) {
    let version = '0.0.0';
    try {
      version = String((JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as { version?: unknown }).version ?? version);
    } catch { /* no package.json beside the kernel: the default stands */ }
    agent = `teneral/${version}`;
  }
  return agent;
}
