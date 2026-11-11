import { existsSync } from 'node:fs';
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
