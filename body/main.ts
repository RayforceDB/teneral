import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent, readEvents } from '../kernel/journal';
import { needsTurn } from './context';
import { runTurn } from './loop';
import { openAiProvider } from './provider';
import { describeDelay, retryDelayMs } from './retry';
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
// Characters per request. Not a positive number, or not set: the default in body/context.ts.
const contextChars = Number(process.env.TENERAL_CONTEXT_CHARS);
const budgetChars = contextChars > 0 ? Math.floor(contextChars) : undefined;
const prompt = readFileSync(join(import.meta.dir, 'prompt.md'), 'utf8');
const letter = readFileSync(join(import.meta.dir, '..', 'BIRTH.md'), 'utf8');
const soulDir = env('TENERAL_SOUL');
const inboxDir = env('TENERAL_INBOX');
const ctx: ToolContext = { workspace, journal, gen, moltCommit: null, id: env('TENERAL_ID'), inbox: inboxDir, peers: env('TENERAL_PEERS') };

let quitting = false;
let wake: (() => void) | null = null;
/** Stimuli journaled by this process, so a failed turn can tell that one came in while it ran. */
let arrived = 0;

// A stimulus is on disk before anything reacts to it, so a crash right after cannot lose it.
function emit(s: Stimulus): void {
  appendEvent(journal, gen, { type: 'stimulus', source: s.source, text: s.text });
  arrived += 1;
  wake?.();
}

const sensors: Sensor[] = [
  terminal(console, () => { quitting = true; wake?.(); }),
  clock(heartbeatMinutes * 60_000),
  inbox(inboxDir),
];

/** One turn. Returns what went wrong, or null when it ran to its end. */
async function turn(): Promise<string | null> {
  // To stderr, so the terminal is not silent for the minutes a reply or a tool can take.
  console.error('[thinking]');
  try {
    const outcome = await runTurn({
      journal, gen, provider, tools: TOOLS, ctx, budgetChars,
      // Composed again every round: the agent may have just rewritten its soul.
      system: () => composeSystem(prompt, soulDir),
      onText: (t) => console.log(`\n${t}\n`),
      onTool: (name) => console.error(`[tool] ${name}`),
    });
    if (outcome === 'molt') process.exit(75);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Sleeps until a sensor emits or the agent is told to quit, or for `ms` when given. */
function idle(ms?: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = ms === undefined ? undefined : setTimeout(resolve, ms);
    wake = () => { clearTimeout(timer); resolve(); };
  }).then(() => { wake = null; });
}

// Everything above loaded and parsed: this generation can start.
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
// A journal with no stimulus yet means this individual was never born: the letter goes first.
const firstWords = birth(readEvents(journal), letter);
if (firstWords !== null) emit(firstWords);
const stops = sensors.map((start) => start(emit));

// Failed turns in a row. Nothing is journaled for a failure: the turn stays owed and is tried again.
let failures = 0;
for (;;) {
  // Also true right after a restart: an unfinished turn or a kernel note is picked up here.
  while (!quitting && needsTurn(readEvents(journal))) {
    const before = arrived;
    const error = await turn();
    if (error === null) {
      failures = 0;
      continue;
    }
    failures += 1;
    const delay = retryDelayMs(failures);
    console.error(`[turn failed] ${error}`);
    if (arrived !== before) {
      // Nobody was listening for it while the turn ran; it gets its try now, once.
      console.error(`[retry] ${failures} in a row; something arrived meanwhile, trying again now`);
      continue;
    }
    console.error(`[retry] ${failures} in a row; trying again in ${describeDelay(delay)}, or at once when something arrives`);
    await idle(delay);
  }
  if (quitting) break;
  process.stdout.write('> ');
  await idle();
}

for (const stop of stops) stop();
process.exit(0);
