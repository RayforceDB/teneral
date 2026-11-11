import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent, readEvents } from '../kernel/journal';
import { needsTurn } from './context';
import { runTurn } from './loop';
import { openAiProvider } from './provider';
import { clock, inbox, terminal, type Sensor, type Stimulus } from './sensors';
import { birth, composeSystem } from './soul';
import { TOOLS, type ToolContext } from './tools';

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set`);
    process.exit(1);
  }
  return value;
}

const gen = env('TENERAL_GEN');
const journal = env('TENERAL_JOURNAL');
const workspace = env('TENERAL_WORKSPACE');
const provider = openAiProvider({ baseUrl: env('TENERAL_BASE_URL'), apiKey: env('TENERAL_API_KEY'), model: env('TENERAL_MODEL') });
const heartbeatMinutes = Number(process.env.TENERAL_HEARTBEAT_MINUTES ?? '30');
const prompt = readFileSync(join(import.meta.dir, 'prompt.md'), 'utf8');
const letter = readFileSync(join(import.meta.dir, '..', 'BIRTH.md'), 'utf8');
const soulDir = env('TENERAL_SOUL');
const inboxDir = env('TENERAL_INBOX');
const ctx: ToolContext = { workspace, journal, gen, moltCommit: null, id: env('TENERAL_ID'), inbox: inboxDir, peers: env('TENERAL_PEERS') };

let quitting = false;
let wake: (() => void) | null = null;

// A stimulus is on disk before anything reacts to it, so a crash right after cannot lose it.
function emit(s: Stimulus): void {
  appendEvent(journal, gen, { type: 'stimulus', source: s.source, text: s.text });
  wake?.();
}

const sensors: Sensor[] = [
  terminal(console, () => { quitting = true; wake?.(); }),
  clock(heartbeatMinutes * 60_000),
  inbox(inboxDir),
];

/** One turn. False when it failed, so the caller waits for the next stimulus instead of spinning. */
async function turn(): Promise<boolean> {
  try {
    // The soul is read again each turn: the agent may have just rewritten it.
    const system = composeSystem(prompt, soulDir);
    const outcome = await runTurn({ journal, gen, provider, tools: TOOLS, system, ctx, onText: (t) => console.log(`\n${t}\n`) });
    if (outcome === 'molt') process.exit(75);
    return true;
  } catch (err) {
    console.error(`[turn failed] ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// Everything above loaded and parsed: this generation can start.
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
// A journal with no stimulus yet means this individual was never born: the letter goes first.
const firstWords = birth(readEvents(journal), letter);
if (firstWords !== null) emit(firstWords);
const stops = sensors.map((start) => start(emit));

for (;;) {
  // Also true right after a restart: an unfinished turn or a kernel note is picked up here.
  while (!quitting && needsTurn(readEvents(journal))) {
    if (!(await turn())) break;
  }
  if (quitting) break;
  process.stdout.write('> ');
  await new Promise<void>((resolve) => { wake = resolve; });
  wake = null;
}

for (const stop of stops) stop();
process.exit(0);
