import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent, readEvents } from '../kernel/journal';
import { needsTurn } from './context';
import { runTurn } from './loop';
import { ProviderError, openAiProvider } from './provider';
import { PATIENCE, describeDelay, failureKind, refusalNote, retryDelayMs, verdict, type FailureKind } from './retry';
import { clock, inbox, owner, terminal, type Sensor, type Stimulus } from './sensors';
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
const ownerDir = env('TENERAL_OWNER');
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
  // The terminal this process was started in, if any. In the background there is none: the input ends at once and the rest go on.
  terminal(console, () => { quitting = true; wake?.(); }),
  // The owner's lines from `./box talk`, which may come and go while this process lives.
  owner(ownerDir),
  clock(heartbeatMinutes * 60_000),
  inbox(inboxDir),
];

/** One turn. Returns what was thrown, or null when it ran to its end. */
async function turn(): Promise<{ error: unknown } | null> {
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
  } catch (error) {
    return { error };
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

// Failed turns in a row, and how many of the latest kind. What each kind leads to is in body/retry.ts.
let failures = 0;
let streak: { kind: FailureKind; count: number } = { kind: 'passing', count: 0 };
for (;;) {
  // Also true right after a restart: an unfinished turn or a kernel note is picked up here.
  while (!quitting && needsTurn(readEvents(journal))) {
    const before = arrived;
    const failed = await turn();
    if (failed === null) {
      failures = 0;
      streak.count = 0;
      continue;
    }
    const { error } = failed;
    const kind = failureKind(error);
    failures += 1;
    streak = { kind, count: kind === streak.kind ? streak.count + 1 : 1 };
    // The stack when it is this code's own fault: it is what the next generation needs to mend it.
    console.error(`[turn failed] ${error instanceof Error ? (kind === 'own' ? error.stack ?? error.message : error.message) : String(error)}`);
    const next = verdict(kind, streak.count);
    if (next === 'exit') {
      // Not the provider: waiting mends nothing. As a crash the kernel counts it, and rolls this generation back if it goes on.
      console.error(`[giving up] ${PATIENCE} turns in a row failed in this generation's own code; exiting so the kernel can act`);
      process.exit(1);
    }
    if (next === 'record' && error instanceof ProviderError) {
      // The one failure that is journaled: as a reply, it ends the owed turn, and it is where the owner will read it.
      const note = refusalNote(error);
      appendEvent(journal, gen, { type: 'assistant', text: note, toolCalls: [] });
      console.log(`\n${note}\n`);
      failures = 0;
      streak.count = 0;
      continue;
    }
    const delay = retryDelayMs(failures);
    if (arrived !== before) {
      // Nobody was listening for it while the turn ran; it gets its try now, once.
      console.error(`[retry] ${failures} in a row; something arrived meanwhile, trying again now`);
      continue;
    }
    console.error(`[retry] ${failures} in a row; trying again in ${describeDelay(delay)}, or at once when something arrives`);
    await idle(delay);
  }
  if (quitting) break;
  // A prompt only where someone can type at it; in the background it would be noise in the log.
  if (process.stdin.isTTY) process.stdout.write('> ');
  await idle();
}

for (const stop of stops) stop();
process.exit(0);
