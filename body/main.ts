import { watchJournal } from "./acceptance";
import { REFUSED_KIND, SENT_KIND, decideBudget, shares } from './adaptive-budget';
import { github, githubRepository, githubNotificationPoller, GITHUB_CURSOR_KIND, GITHUB_NOTIFICATION_CURSOR_KIND, type GithubCursor, type GithubNotificationCursor, GITHUB_READS, GITHUB_NOTIFICATION_READS } from './github';
import { rayboard, rayboardCa, rayboardOwnerId, rayboardToken, RAYBOARD_READS } from './rayboard';
import { workspace as workspaceSensor, WORKSPACE_CURSOR_KIND, type WorkspaceCursor, WORKSPACE_READS } from './workspace';
import { hasToken } from '../species/github';
import { speciesRef } from '../species/species';
import { githubRemote, gitRemote } from '../species/github';
import { install as speciesInstall, retireStale, retiredText } from '../species/offer';
import { repoRoot } from '../immune/gates';
import { git } from '../immune/gates';
import { SUBAGENT_KIND, Subagents, endedSubagent, limitsFrom, subagentTool } from './subagents';
import { GLANCE_SAID, decide, glance, ignoredTalk, lastSaid, setDown, waitingTalk } from '../heart/glance';
import { dueWorkOf, heldByInterrupt, importLegacyWork, workDueAtOf } from './work';
import { dueSchedule, scheduleDueAt } from './schedule';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendEvent, readEvents, readEventsFrom, type JournalEvent } from '../brain/journal';
import { PAIRED_SOURCE } from '../brain/owners';
import { contextWindow } from '../brain/providers';
import { frameFrom, turnOwed } from '../brain/frame';
import { swapped } from '../brain/logbook';
import { DEFAULT_BUDGET, assemble, needsTurn } from '../brain/memory';
import { DEFAULT_IMAGES, imageRoute, imageStore, keepImage, rootOf } from './images';
import { runTurn, mayStayQuiet } from '../brain/loop';
import { ProviderError, connect, type Provider } from '../brain/provider';
import { PATIENCE, describeDelay, failureKind, refusalNote, retryDelayMs, verdict, type FailureKind } from '../brain/retry';
import { GITHUB_ACCOUNT_KIND, githubAccount, GITHUB_ACCOUNT_READS } from './github-account';
import { TIMER_MAX_MS, clockMayTick, clockTick, inbox, owner, ownerStimulus, terminal, tickAt, type Sensor, type Stimulus } from './sensors';
import { RESULT_KIND, due, sit } from '../brain/exam';
import { BACK_KIND, noteOf, parseWord, standing, type Word } from '../brain/owned';
import { clockText } from './sensors';
import { followUps, lookedAt, offered, reportAsk, settle, tickDueOf, worthATick } from '../brain/agenda';
import { WORK_KIND, known } from '../brain/known';
import { openServedPast, sourceOf } from '../brain/past';
import { OVER_KIND, TROUBLE_KIND, teller } from '../brain/trouble';
import { REMINDED_KIND, chooseReminder, lately } from '../brain/reminded';
import { EPISODE_KIND, MERGE_KIND } from '../brain/remembered';
import { libraryAt } from '../brain/ray';
import { memoryHealth, sleep, waitingOf } from '../brain/sleep';
import { birth, composeSystem } from '../brain/soul';
import { mail, mailKey, MAIL_READS } from './mail';
import { zulipCredentials, zulipLive, ZULIP_QUEUE_CURSOR_KIND, type ZulipQueueCursor, ZULIP_READS } from './zulip';
import { confirmedZulipOwnerId } from '../brain/zulip-owner';
import { Owners, SPENT_KIND, readPairing } from './pairing';
import { TOOLS, type ToolContext } from './tools';
import { scriptTool } from './script';
import { SKILL_TOOLS, keepVerified, keptSkills, offerFor, openSkills, seedBuiltIn, skillUse } from './skill-tools';
import { JOB_KIND, endedJob, jobNotesFrom, stopCurrentJobs, stopPreviousJobs } from './jobs';
import { foregroundPrompt } from './prompt';
import { COMPARED_KIND, CONTACT_KIND, PARTICIPANT_KIND, PLACE_KIND, compareOnce, enter, meet, supposeAll, whoLines } from './participants';
import type { ChatMessage, Mode, Speaker } from './chat';
import { HEARD_KIND, communityReads, openCommunity, type Heard, type How } from './community';
import { ATTENTION_KIND, QUIET_RUN, ensureHeard, modeFrom, typingFor } from './chat-tools';
import { Heart, REST_MINUTES, agendaFor, heartCommand, restIn, restInOf } from '../heart/coordinator';

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
// The agent's past, for `recall` and `open`: asked of the database when its library is pinned and at hand, of the journal itself otherwise.
const organs = process.env.TENERAL_ORGANS ?? '';
/** Between two portions the database embeds while the agent waits, how long the agent listens for anything said to it. */
const EMBED_PAUSE_MS = 250;
// What the body says of its own working: said as ever, and what says that something failed is set down too, so that the owner sees it (brain/trouble.ts).
const say = teller(
  (data) => { appendEvent(journal, gen, { type: 'note', kind: TROUBLE_KIND, data }); }, undefined, undefined,
  // A state that has ended: the owner is not shown for a day a trouble that was over in a minute (brain/trouble.ts).
  (data) => { appendEvent(journal, gen, { type: 'note', kind: OVER_KIND, data }); },
);
const past = await openServedPast(journal, organs === '' ? null : organs, say);
// What the body reads of the journal, asked of the past: the notes of some kinds, what the owner typed, and the end of the
// journal from the latest thing said to the agent on. None of it is the journal held whole.
const noted = (...kinds: string[]): JournalEvent[] => past.notes(kinds);
const ownerTyped = (): JournalEvent[] => past.stimuli(['terminal', PAIRED_SOURCE]);
// A job is stopped by its notes, which are asked of the past.
jobNotesFrom(() => noted(JOB_KIND));
/** What a sensor reads to know where it was (its `…_READS`), asked for each time it looks. */
const read = (of: { sources: string[]; kinds: string[] }) => (): JournalEvent[] => past.picked(of.sources, of.kinds);
const sinceSaid = (): JournalEvent[] => {
  if (past.by === 'store') {
    try {
      const from = past.asked();
      const tail = from === null ? [] : readEventsFrom(journal, from);
      if (tail[0]?.type === 'stimulus') return tail;
    } catch { /* read whole, below */ }
  }
  return readEvents(journal);
};
const workspace = env('TENERAL_WORKSPACE');
// Which provider, over which protocol, with which credentials: brain/provider.ts reads that from the environment.
let provider: Provider;
try {
  provider = connect(process.env);
} catch (err) {
  say(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const heartbeatMinutes = Number(process.env.TENERAL_HEARTBEAT_MINUTES ?? '30');
// Minutes of the owner's silence after which the agent is at rest, and does what is its own: memories, looking ahead, ticks. Not a number of 0 or more, or not set: the default in heart/coordinator.ts. 0: always.
const restSet = Number(process.env.TENERAL_REST_MINUTES ?? '');
const restMs = (process.env.TENERAL_REST_MINUTES?.trim() ?? '') !== '' && restSet >= 0 ? restSet * 60_000 : REST_MINUTES * 60_000;
// Tokens a day that turns woken by a clock tick may spend. Not positive or not set: no cap.
const ownSet = Number(process.env.TENERAL_OWN_TOKENS_DAY);
const ownTokensDay = ownSet > 0 ? Math.floor(ownSet) : null;
// Hours between reports to the owner of what was done on the agent's own. Unset: 24; not positive: none.
const reportHours = process.env.TENERAL_REPORT_HOURS === undefined ? 24 : Number(process.env.TENERAL_REPORT_HOURS) > 0 ? Number(process.env.TENERAL_REPORT_HOURS) : 0;
// Characters per request. Set and positive, it is a ceiling on what the budget chooser may pick,
// never a floor: body/adaptive-budget.ts measures the provider's own feedback and decides the rest.
const contextChars = Number(process.env.TENERAL_CONTEXT_CHARS);
const budgetCeiling = contextChars > 0 ? Math.floor(contextChars) : undefined;
const budgetChars = contextChars > 0 ? Math.floor(contextChars) : undefined;
// Characters of the conversation shown as it happened. Not a positive number, or not set: the default in brain/logbook.ts.
const tailSet = Number(process.env.TENERAL_TAIL_CHARS);
// Characters the memories of older episodes may take. As above.
const logbookSet = Number(process.env.TENERAL_LOGBOOK_CHARS);
// The budget for this run, chosen from the journal's measurements against the window the provider table gives this model.
const budgetChoice = decideBudget(noted(SENT_KIND, REFUSED_KIND), contextWindow(process.env.TENERAL_PROVIDER ?? '', process.env.TENERAL_MODEL ?? ''), budgetCeiling, budgetChars ?? DEFAULT_BUDGET);
// How much of the past a request shows: the owner's word where it is given, else a share of that budget (body/adaptive-budget.ts).
const tailChars = tailSet > 0 ? Math.floor(tailSet) : shares(budgetChoice.budgetChars).tailChars;
const logbookChars = logbookSet > 0 ? Math.floor(logbookSet) : shares(budgetChoice.budgetChars).logbookChars;
// Images in one request. Not a whole number of 0 or more, or not set: the default in body/images.ts. 0 sends none.
const imagesSet = process.env.TENERAL_IMAGES_PER_REQUEST?.trim() ?? '';
// The image store is `memory/images` in the directory that holds `memory/`, which the journal's own path gives.
const sight = { load: imageStore(rootOf(journal)), max: /^\d+$/.test(imagesSet) ? Number(imagesSet) : DEFAULT_IMAGES };
// Authenticated Zulip owner uploads enter the same content-addressed store as terminal images.
// A temporary file is required only because keepImage performs the byte-level image validation.
async function keepZulipImage(bytes: Buffer): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'mica-zulip-image-'));
  const file = join(dir, 'upload');
  try { writeFileSync(file, bytes); return (await keepImage(rootOf(journal), file)).marker; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const prompt = readFileSync(join(import.meta.dir, '..', 'brain', 'prompt.md'), 'utf8');
const letter = readFileSync(join(import.meta.dir, '..', 'BIRTH.md'), 'utf8');
const soulDir = env('TENERAL_SOUL');
// Talk that addressed nobody is glanced at before it costs a turn, unless the owner turned that off; on another model when one is named.
const GLANCE = process.env.TENERAL_GLANCE !== '0';
const glanceProvider = process.env.TENERAL_GLANCE_MODEL?.trim() ? connect({ ...process.env, TENERAL_MODEL: process.env.TENERAL_GLANCE_MODEL.trim() }) : provider;
const soulHead = (): string => { try { return readFileSync(join(soulDir, 'identity.md'), 'utf8'); } catch { return ''; } };
const inboxDir = env('TENERAL_INBOX');
const ownerDir = env('TENERAL_OWNER');
// A fresh individual never inherits this install's personal accounts or agenda. These integrations
// are explicitly scoped to its workspace; the former parent-directory guesses are not a fallback.
const zulipCredentialPath = process.env.TENERAL_ZULIP_CREDENTIALS_FILE ?? join(workspace, '.teneral', 'zulip.json');
const mailConfigPath = process.env.TENERAL_MAIL_CONFIG_FILE ?? join(workspace, '.teneral', '.env');
// Optional numeric Zulip user id, explicitly configured by the owner. Absent or invalid, no
// Zulip sender may shorten provider retry backoff; ordinary conversation still works.
const zulipOwnerSetting = process.env.TENERAL_ZULIP_OWNER_ID?.trim() ?? '';
const zulipOwnerNumber = /^\d+$/.test(zulipOwnerSetting) ? Number(zulipOwnerSetting) : 0;
const zulipOwnerId = Number.isSafeInteger(zulipOwnerNumber) && zulipOwnerNumber > 0 ? zulipOwnerNumber : undefined;
// The owner's accounts in every chat service: what the settings name, what they typed, and what they paired (body/pairing.ts).
// What is known is also written beside the owner's directory, for `/owner` in their terminal to show.
const owners = new Owners({
  events: [...ownerTyped(), ...noted(SPENT_KIND)], emit: (s) => emit(s), note: (data) => { appendEvent(journal, gen, { type: 'note', kind: SPENT_KIND, data }); }, status: join(ownerDir, '..', 'owners.json'), log: say,
  settled: {
    ...(zulipOwnerId === undefined ? {} : { zulip: [String(zulipOwnerId)] }),
    ...(rayboardOwnerId(process.env.TENERAL_RAYBOARD_OWNER_ID) === undefined ? {} : { rayboard: [rayboardOwnerId(process.env.TENERAL_RAYBOARD_OWNER_ID)!] }),
  },
});
// Only commits observed on the owner's explicitly resolved species ref become update proposals.
// Other watched repositories remain ordinary untrusted activity. GitHub never grants mutation approval.
let upstream: { repository: string; branch: string } | undefined;
try {
  const species = speciesRef(workspace, process.env.TENERAL_UPSTREAM);
  if (!('problem' in species) && species.remote) {
    const repository = process.env.TENERAL_SPECIES_REPO ?? githubRemote(git(workspace, 'remote', 'get-url', species.remote.name))?.slug;
    if (repository) upstream = { repository: githubRepository(repository), branch: species.remote.branch };
  }
} catch { /* A missing local ref still leaves ordinary public repository sensing available. */ }
// Public read-only repository activity. Empty disables it; no GitHub credential is read or sent.
// A comma-separated setting preserves the old single-repository configuration.
const githubRepositories = (process.env.TENERAL_GITHUB_REPOSITORIES?.trim() || process.env.TENERAL_GITHUB_REPOSITORY?.trim() || 'RayforceDB/rayforce,RayforceDB/teneral').split(',').map(s => s.trim()).filter(Boolean);
// Who said what where, in the same database when it is at hand: made from the journal's notes at every start.
const community = openCommunity(past.ray ?? null, noted(...communityReads()));
const id = env('TENERAL_ID');
// Workers use only the base tools; the parent advertises its complete tool set to the skill registry.
const subagents = new Subagents({
  notes: () => noted(SUBAGENT_KIND),
  journal, gen, workspace, dir: join(dirname(workspace), 'subagents'), tools: TOOLS, id,
  provider: process.env.TENERAL_SUBAGENT_MODEL?.trim() ? connect({ ...process.env, TENERAL_MODEL: process.env.TENERAL_SUBAGENT_MODEL.trim() }) : provider,
  limits: limitsFrom(process.env), budgetChars: budgetChoice.budgetChars,
  // The heart finds its note at the next beat. End sleep or work at rest as an arrival would.
  onEnded: () => wake?.(),
});
const ownTools = [...TOOLS, ...SKILL_TOOLS, subagentTool(subagents)];
// Always there, like any other tool: what a script may call is said by each tool itself (body/script.ts).
const allTools = [...ownTools, scriptTool(ownTools)];
const ctx: ToolContext = { workspace, journal, gen, mutationCommit: null, id, inbox: inboxDir, peers: env('TENERAL_PEERS'), soul: soulDir, past, community, toolNames: allTools.map(t => t.spec.name) };
ctx.skills = openSkills(ctx);
try { seedBuiltIn(ctx); } catch (err) { say(`[skills] the built-in skills were not seeded: ${err instanceof Error ? err.message : String(err)}`); }
// A verification holds for one generation: the enabled skills are verified again for this one, so that they go on being found and offered.
// Of everyone already met: who bears the name of someone on another service and so may be the same one. Asked of the owner, once; nothing is joined (body/participants.ts).
try {
  const met = noted(PARTICIPANT_KIND, CONTACT_KIND, COMPARED_KIND);
  const asked = supposeAll(journal, gen, met);
  if (asked > 0) say(`[contacts] ${asked} ${asked === 1 ? 'question' : 'questions'} set down for the owner about accounts that may be one person`);
  // And what a name cannot tell is the agent's own to go over, once.
  if (compareOnce(journal, gen, met)) say('[contacts] the agent was set to go over everyone it has met for accounts that are one person');
} catch (err) { say(`[contacts] look-alikes among those met were not gone over: ${err instanceof Error ? err.message : String(err)}`); }
try { const again = keepVerified(ctx); if (again > 0) say(`[skills] verified ${again} enabled ${again === 1 ? 'skill' : 'skills'} for this generation`); } catch (err) { say(`[skills] the enabled skills could not be verified again: ${err instanceof Error ? err.message : String(err)}`); }
// A previous generation's process groups must not write into the candidate under the new gates.
// Same-generation restarts keep their registry so `jobs` can list and stop them deliberately.
const stoppedJobs = stopPreviousJobs(journal, gen);
if (stoppedJobs.length > 0) say(`[jobs] stopped previous-generation groups: ${stoppedJobs.join(', ')}`);
process.on('exit', () => stopCurrentJobs(journal, gen));
// One-time import only: after this the journal is the live agenda, and the JSON file is never rewritten.
try {
  const imported = importLegacyWork(journal, gen, process.env.TENERAL_LEGACY_WORK_FILE ?? join(workspace, '.teneral', 'work.json'));
  if (imported > 0) say(`[work] imported ${imported} active commitments into the journal agenda`);
} catch (err) {
  say(`[work] legacy agenda not imported: ${err instanceof Error ? err.message : String(err)}`);
}

let quitting = false;
let working = false;
let wake: (() => void) | null = null;
/**
 * True while a request of the agent's own is under way: settling a turn, a memory, a look ahead.
 * Such a request is given up only for something that calls for a turn. The journal grows for other
 * reasons too, a sensor's checkpoint or the stem's own records, and those must not end it.
 */
let resting = false;
/** Wakes only the sleep between beats; background requests install their own abort wake. */
let idleWake: (() => void) | null = null;
/** Owner stimuli journaled by this process: only these may shorten a failed turn's backoff. */
let ownerArrived = 0;
/** Aborts the turn in progress; null between turns. */
let current: AbortController | null = null;
/**
 * When the next try of a failed turn is due, or null when none is. After a provider-side failure
 * (a rate or usage limit) the turn is only retried at or after this time; a tick of the clock or
 * an inbox message does not hurry it. The owner's own line always does: that is in emit.
 */
let retryAt: number | null = null;
/** The already-requested mutation to hand to the stem once no foreground terminal line is unanswered. */
let handoff: string | null = null;
const terminalPrompt = foregroundPrompt(text => process.stdout.write(text));

/**
 * How the agent listens in a channel, for any service: what it chose, or what its own silence
 * there shows (body/chat-tools.ts). Asked for every message of a busy channel, so the answer is
 * kept for a minute rather than worked out from the whole journal each time.
 */
const listened = new Map<string, { at: number; mode: Mode }>();
/**
 * A channel the agent takes part in is one it hears. Some services send a channel's ordinary talk
 * only to those who asked, and an agent that was only ever mentioned there would hear nothing else
 * and never know: so it asks by itself, once for each channel while this body lives, unless it
 * chose to hear nothing there (body/chat-tools.ts). Failing is not fatal; it is tried at the next start.
 */
const askedToHear = new Set<string>();
function hearIn(service: string, channel: string): void {
  const key = `${service}:${channel}`;
  if (askedToHear.has(key)) return;
  askedToHear.add(key);
  void ensureHeard(ctx, service, channel, { muted: past.stateOf('attention', [`${service}\n${channel}`]) === 'muted' })
    .then((asked) => { if (asked) say(`[chat] ${service} was not sending the talk of ${channel}; asked it to`); })
    .catch((err) => say(`[chat] ${service} could not be asked for the talk of ${channel}: ${err instanceof Error ? err.message : String(err)}`));
}
function listening(service: string, channel: { id: string; name: string }): Mode {
  const key = `${service}:${channel.id}`;
  const kept = listened.get(key);
  if (kept !== undefined && Date.now() - kept.at < 60_000) return kept.mode;
  const now = modeFrom(past, service, channel);
  // The first message from a channel in this life of the body: it is one the agent takes part in, so it is to hear it.
  if (kept === undefined) hearIn(service, channel.name);
  if (now.why === 'quiet' && kept?.mode !== 'mentions') say(`[chat] ${channel.name} on ${service}: woken ${QUIET_RUN} times running with nothing to say; listening for mentions only`);
  listened.set(key, { at: Date.now(), mode: now.mode });
  return now.mode;
}

/**
 * Who speaks in what a chat sensor is about to show: everyone not met before is recorded, and each
 * is shown with what the agent knows of them. For any service: only its name differs.
 */
function whoSpeaks(service: string, speakers: Speaker[]): string {
  // Whom it has met, the contacts and what was heard are notes; what it knows of them is asked of the past.
  const events = noted(PARTICIPANT_KIND, ...communityReads());
  const seen = speakers.map((s) => ({ service, id: s.id, name: s.name, ...(s.bot === undefined ? {} : { bot: s.bot }), ...(s.where === undefined ? {} : { met: s.where }) }));
  community.refresh(events);
  return whoLines(events, seen, meet(journal, gen, events, seen), community, past.known().facts);
}

/**
 * Who has spoken to this agent, by service and id: a direct message, a mention, an answer to
 * something it said. Of those the service has not called people, these are the agents it has
 * dealings with, whose talk in a channel it hears (body/chat.ts). Read from the journal's own
 * notes of what was heard, so a restart forgets none of them.
 */
const SPOKE_TO_ME = new Set<How>(['dm', 'mention', 'quote']);
const dealings = new Set<string>();
for (const e of noted(HEARD_KIND)) {
  if (e.type !== 'note' || e.kind !== HEARD_KIND || typeof e.data !== 'object' || e.data === null || Array.isArray(e.data)) continue;
  const d = e.data as Partial<Heard>;
  if (typeof d.service === 'string' && typeof d.sender === 'string' && d.how !== undefined && SPOKE_TO_ME.has(d.how)) dealings.add(`${d.service}:${d.sender}`);
}
const peerOn = (service: string) => (sender: { id: string }): boolean => dealings.has(`${service}:${sender.id}`);

/** Every message a chat sensor takes is noted, for the table of who said what where (body/community.ts). Never its words: those are in the stimulus, when it was shown. */
function heardOn(service: string): (m: ChatMessage, how: How) => void {
  return (m, how) => {
    if (m.sender === undefined) return;
    if (SPOKE_TO_ME.has(how)) dealings.add(`${service}:${m.sender.id}`);
    appendEvent(journal, gen, { type: 'note', kind: HEARD_KIND, data: { service, id: m.id, place: m.place.replace(/\n/g, ' / '), where: m.where ?? m.place, sender: m.sender.id, name: m.sender.name, how } satisfies Heard });
  };
}

// A stimulus is on disk before anything reacts to it, so a crash right after cannot lose it.
// A glance reads the overheard talk and what was decided of it, what the agent last said, and its agenda: each asked of the past.
const glanceDeps = () => ({
  journal, gen, provider: glanceProvider, who: soulHead, emit, events: (): JournalEvent[] => [],
  asks: { said: saidLately, agenda: (now: number) => agendaByDay(now), waiting: () => waitingTalk(past), ignored: () => ignoredTalk(past) },
});
/** What the agent last said in words (`lastSaid` in heart/glance.ts): looked for from the journal's end, further back while too few are found. */
function saidLately(): string[] {
  const upTo = past.count();
  for (let back = 200; ; back *= 4) {
    const from = Math.max(0, upTo - back);
    const said = lastSaid(past.standingFrom(from, upTo));
    if (said.length >= GLANCE_SAID || from === 0) return said;
  }
}
/** The glance being made beside a running turn, if one is. */
let glancing: Promise<unknown> | null = null;
function glanceBeside(): Promise<unknown> {
  glancing ??= decide(glanceDeps()).then((decided) => { if (decided !== null) say(`[glance] overheard talk, beside the turn: ${decided}`); }).finally(() => { glancing = null; });
  return glancing;
}

function emit(s: Stimulus): void {
  if (s.source === 'terminal') terminalPrompt.submitted();
  if (s.source === 'terminal' && heartCommand(s.text)) {
    heart.requestPulse();
    // A pulse is work for the next beat, not a cancellation of reflection, memory or a live turn.
    idleWake?.();
    return;
  }
  if (s.overheard !== undefined && GLANCE) {
    // Talk that addressed nobody is set down and glanced at by the heart before a turn is spent on it (heart/glance.ts).
    if (setDown(journal, gen, waitingTalk(past), { ...s, overheard: s.overheard })) {
      // While a turn runs the heart is not asked: the deciding is done beside it, so that what concerns the agent reaches that turn.
      if (working && process.env.TENERAL_BACKGROUND !== 'serial') void glanceBeside();
      idleWake?.();
    }
    return;
  }
  appendEvent(journal, gen, { type: 'stimulus', source: s.source, text: s.text });
  // A typed line may name one of the owner's chat accounts, or take the accounts of a service back (brain/owners.ts).
  if (s.source === 'terminal' && / (is|account is) me$/i.test(s.text.trim())) owners.heard(ownerTyped());
  if (ownerStimulus(s)) {
    ownerArrived += 1;
    // Only the owner's own channels end a wait for a failed turn. A tick, a peer, or another
    // Zulip sender is journaled but cannot hurry a provider already at its limit.
    retryAt = null;
  }
  wake?.();
}

/**
 * The owner asked for the work in progress to stop: only the owner's channel can (body/sensors.ts).
 * A turn that is running is aborted, and journals that itself (brain/loop.ts). A turn that is owed
 * but not running, because it failed and waits to be tried again or is only about to begin, is
 * ended here. When nothing is owed there is nothing to stop and the request is dropped: it is
 * never kept for a turn that has not been asked for yet.
 */
function interrupt(): void {
  if (current !== null) return current.abort();
  if (!turnOwed(past, journal)) return;
  appendEvent(journal, gen, { type: 'turn.interrupted' });
  say('[interrupted]');
  wake?.();
}

/** The owner's words about memory that are not journaled yet (brain/owned.ts). */
const words: Word[] = [];

/**
 * The owner said something about the agent's memory. It is journaled between turns, never in the
 * middle of one, so that a note stands at a place where nothing is half done. Taking the
 * conversation back also ends the turn in progress: that turn belongs to what is taken back.
 */
function ownerWord(text: string): void {
  const word = parseWord(text);
  if (word === null) return say('[owner] a word about memory that could not be read was dropped');
  words.push(word);
  if (word.do === 'back') current?.abort();
  wake?.();
}

/** The owner asked in their terminal for one of their chat accounts to be paired (body/pairing.ts). The code is kept here and never journaled. */
function ownerPairing(text: string): void {
  const pairing = readPairing(text);
  if (pairing === null) return say('[owner] a pairing that could not be read was dropped');
  owners.offer(pairing);
}
/** The owner's accounts of one service, as a chat adapter asks about them. */
function ownersOn(service: string) {
  owners.serves(service);
  return { is: (id: string) => owners.is(service, id), claim: (m: ChatMessage) => owners.claim(service, m), any: () => owners.any(service) };
}

/** Journals the owner's words that wait. A word about something the journal does not hold is dropped. */
function settleWords(): void {
  for (const word of words.splice(0)) {
    // Only the events the word names are looked up: whether they are there, and what they are.
    const names = word.do === 'withdraw' ? word.ids : [word.do === 'back' ? word.to : word.event];
    const note = noteOf(word, names.flatMap((id) => { const found = past.around(id, 0, 0); return found === null ? [] : [found.events[found.at]!]; }));
    if (note === null) say(`[owner] nothing in the journal for the word "${word.do}"; it was dropped`);
    else appendEvent(journal, gen, note);
  }
}

/**
 * The species, heard from now and then, and the agent's own offers looked over against it: one the species has moved past can no longer
 * go out, so it is retired here and the agent is told, to make again what is still wanted. The
 * owner is asked nothing and sees only offers that can go out.
 */
const OFFERS_FIRST_MS = 60_000;
const OFFERS_EVERY_MS = 10 * 60_000;
let offersLookAt = Date.now() + OFFERS_FIRST_MS;
/** That look, when its time has come; what the agent is told when an offer was retired, or null. The heart asks (heart/coordinator.ts). */
function staleOffers(now: number): Stimulus | null {
  if (now < offersLookAt) return null;
  offersLookAt = now + OFFERS_EVERY_MS;
  try {
    const install = speciesInstall(repoRoot(import.meta.dir));
    // Hear where the species stands: the owner's screen says what it brings (/update) from this, and
    // an offer is stale against this. A fetch only moves the remote's own refs; nothing is merged.
    const species = speciesRef(workspace, process.env.TENERAL_UPSTREAM);
    if (!('problem' in species) && species.remote) gitRemote(install.root, install.auth, ['fetch', '--quiet', species.remote.name, species.remote.branch]);
    const gone = retireStale(install);
    return gone.length > 0 ? { source: 'species', text: retiredText(gone) } : null;
  } catch { return null; /* no install around this body, or no species known here: nothing to retire */ }
}

const sensors: Sensor[] = [
  // The terminal this process was started in, if any. In the background there is none: the input ends at once and the rest go on.
  terminal(console, () => {
    quitting = true;
    // Foreground /quit is an exit, unlike ./one talk's detach: abort the live provider/tool turn.
    // runTurn journals its interruption and bounded cleanup before the main loop exits normally.
    current?.abort();
    wake?.();
  }),
  // The owner's lines from `./one talk`, which may come and go while this process lives.
  owner(ownerDir, undefined, interrupt, ownerWord, ownerPairing),
  inbox(inboxDir, ctx.id, 2000, ctx.peers),
  ...(process.env.TENERAL_RAYBOARD_URL ? [rayboard({
    url: process.env.TENERAL_RAYBOARD_URL,
    // No implicit binding: the owner chooses which API-verified account can speak for them.
    ownerId: rayboardOwnerId(process.env.TENERAL_RAYBOARD_OWNER_ID), owners: ownersOn('rayboard'),
    // Talk on the board is chat like any other: the same attention, the same hands, the same record of who is there.
    chat: true, ambient: process.env.TENERAL_RAYBOARD_AMBIENT !== '0', who: (speakers) => whoSpeaks('rayboard', speakers), mode: (channel) => listening('rayboard', channel), heard: heardOn('rayboard'), peer: peerOn('rayboard'),
    token: () => rayboardToken(process.env.TENERAL_RAYBOARD_TOKEN_FILE),
    ca: process.env.TENERAL_RAYBOARD_CA_FILE ? rayboardCa(process.env.TENERAL_RAYBOARD_CA_FILE) : undefined,
    events: read(RAYBOARD_READS),
  })] : []),
  // Opt-in: the smoke gate has no workspace watcher. Paths/hashes only; an edit is never owner's word.
  ...(process.env.TENERAL_WORKSPACE_WATCH === '1' ? [workspaceSensor({
    root: workspace,
    events: read(WORKSPACE_READS),
    checkpoint: (cursor: WorkspaceCursor) => appendEvent(journal, gen, { type: 'note', kind: WORKSPACE_CURSOR_KIND, data: cursor }),
  })] : []),
  ...githubRepositories.map(repository => github({
    repository, upstream,
    events: read(GITHUB_READS),
    checkpoint: (cursor: GithubCursor) => {
      // A stimulus emitted in this poll is already on disk. If journaling it failed, the sensor
      // holds this checkpoint back. One note replaces all feed cursors for a repository atomically;
      // a crash before it repeats stimuli, whose ids suppress duplicates after restart.
      const pending = past.notes([GITHUB_CURSOR_KIND]).findLast(e => e.type === 'note' && typeof e.data === 'object' && e.data !== null && !Array.isArray(e.data) && 'repository' in e.data && e.data.repository === repository);
      if (pending?.type === 'note' && JSON.stringify(pending.data) === JSON.stringify(cursor)) return;
      appendEvent(journal, gen, { type: 'note', kind: GITHUB_CURSOR_KIND, data: cursor });
    },
  })),
  // Which account the stored token belongs to, told to the agent when it is new (body/github-account.ts).
  ...(process.env.TENERAL_AUTH ? [githubAccount({
    token: () => { try { return readFileSync(join(process.env.TENERAL_AUTH!, 'github-token'), 'utf8'); } catch { return ''; } },
    events: read(GITHUB_ACCOUNT_READS),
    note: (login) => appendEvent(journal, gen, { type: 'note', kind: GITHUB_ACCOUNT_KIND, data: { login } }),
  })] : []),
  ...(process.env.TENERAL_AUTH && hasToken(process.env.TENERAL_AUTH) ? [(emit: (s: Stimulus) => void) => {
    const worker = githubNotificationPoller({
      events: read(GITHUB_NOTIFICATION_READS),
      token: () => existsSync(join(process.env.TENERAL_AUTH!, 'github-token')) ? readFileSync(join(process.env.TENERAL_AUTH!, 'github-token'), 'utf8') : '',
      checkpoint: (cursor: GithubNotificationCursor) => appendEvent(journal, gen, { type: 'note', kind: GITHUB_NOTIFICATION_CURSOR_KIND, data: cursor }),
    }, emit);
    const timer = setTimeout(() => { void worker.poll(); setInterval(() => { void worker.poll(); }, 60_000); }, 60_000);
    return () => { clearTimeout(timer); worker.stop(); };
  }] : []),
  // TENERAL_ZULIP_AMBIENT=0: channel talk that does not address the agent never wakes it, and only accompanies the next message that does.
  // One sensor: the message poller, and the event queue that rings it at once for a message, an edit or a deletion and carries reactions.
  zulipLive({
    conversations: true, ambient: process.env.TENERAL_ZULIP_AMBIENT !== '0', credentials: () => zulipCredentials(zulipCredentialPath), events: read(ZULIP_READS),
    ownerId: confirmedZulipOwnerId(ownerTyped(), zulipOwnerId), owners: ownersOn('zulip'), keepImage: keepZulipImage,
    who: (speakers) => whoSpeaks('zulip', speakers),
    mode: (stream) => listening('zulip', stream), heard: heardOn('zulip'), peer: peerOn('zulip'),
    entered: (stream, members) => enter(journal, gen, noted(PLACE_KIND, PARTICIPANT_KIND, CONTACT_KIND), 'zulip', stream, members === null ? null : members.map((m) => ({ service: 'zulip', ...m }))),
    // Checkpointed only after delivery: a reaction is told of once across restarts.
    checkpoint: (cursor: ZulipQueueCursor) => {
      const pending = past.latest('note', ZULIP_QUEUE_CURSOR_KIND);
      if (pending?.type === 'note' && JSON.stringify(pending.data) === JSON.stringify(cursor)) return;
      appendEvent(journal, gen, { type: 'note', kind: ZULIP_QUEUE_CURSOR_KIND, data: cursor });
    },
  }),
  mail({
    key: () => mailKey(process.env, mailConfigPath),
    events: read(MAIL_READS),
    quiet: id => appendEvent(journal, gen, { type: 'note', kind: 'mail.quiet.v1', data: id }),
  }),
];

/** One turn. Returns what was thrown, or null when it ran to its end. */
async function turn(): Promise<{ error: unknown } | null> {
  // Any wake except the owner's terminal/birth may settle quietly. Keep streamed markers out of the terminal.
  const quietTick = mayStayQuiet(sourceOf(past.latest('stimulus')));
  const genericTyping = typingFor(workspace);
  const ownerBefore = ownerArrived;
  // To stderr, so the terminal is not silent for the minutes a reply or a tool can take.
  say('[thinking]');
  current = new AbortController();
  try {
    const outcome = await runTurn({
      journal, gen, provider, tools: allTools, ctx, budgetChars, tailChars, logbookChars, sight,
      // Older memories the thing just said brings back: the search `recall` makes, asked once before the turn's first request. One a later memory made outdated is left out.
      // The latest reminders are asked of the past: the turn hands over only the end of the journal it holds.
      // A skill the agent keeps that fits what was said: offered by a line, opened by the agent if it judges that it fits.
      offer: (question) => offerFor(ctx, question),
      remind: (question, inFront) => { past.sync(); return chooseReminder(past.find(question, { kinds: ['memory'], limit: 12, words: true }), inFront, lately(past.notes([REMINDED_KIND])), past); },
      imageRoute: imageRoute(process.env), budget: budgetChoice,
      // Composed again every round: the agent may have just rewritten its soul.
      system: () => composeSystem(prompt, soulDir, journal),
      onText: (t) => { console.log(`\n${t}\n`); terminalPrompt.answered(); },
      // Once the owner has said something in the middle of such a turn, what follows is said to them and is printed like any reply.
      onDelta: (t) => { if (!quietTick || ownerArrived !== ownerBefore) console.log(t); },
      onTool: (name) => say(`[tool] ${name}`),
      // The chat adapter shows composition only for the exact stimulus that warrants it.
      onTyping: genericTyping,
      signal: current.signal,
    });
    if (outcome === 'mutation') handoff = ctx.mutationCommit;
    // Not a failure: nothing is counted and nothing is tried again. The loop below finds no turn owed and waits.
    if (outcome === 'interrupted') say('[interrupted]');
    return null;
  } catch (error) {
    return { error };
  } finally {
    current = null;
  }
}

/** Sleeps until a sensor emits or the agent is told to quit, or for `ms` when given. True when it was woken, false when the time ran out. */
function idle(ms?: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // A delay longer than a timer holds would fire at once.
    const timer = ms === undefined ? undefined : setTimeout(() => resolve(false), Math.min(ms, TIMER_MAX_MS));
    wake = () => { clearTimeout(timer); resolve(true); };
    idleWake = wake;
  }).then((woken) => { wake = null; idleWake = null; return woken; });
}

/** How long after a memory could not be formed before the next try. The episode waits; nothing is lost by waiting. */
const REST_RETRY_MS = 15 * 60_000;
let restNotBefore = 0;

/**
 * A request of rest that is under way: a memory, a wider memory, a look ahead. It is begun only at
 * rest, but something arriving does not end it. The turn that answers what arrived runs beside it,
 * and what the request formed is journaled when no turn is running: a note that changed what a
 * turn is shown, in the middle of it, would cost the turn its provider's cache. A request thrown
 * away at the first message is paid for and comes to nothing, which is how most of them ended.
 * TENERAL_BACKGROUND=serial brings back the old way: whatever arrives cancels it.
 */
let background: { done: Promise<boolean>; stop: AbortController } | null = null;
const beside = process.env.TENERAL_BACKGROUND !== 'serial';
const stopBackground = (): void => { background?.stop.abort(); };
/** What a request beside a turn formed, waiting for the turn to end. */
const formed: Parameters<typeof appendEvent>[2][] = [];
function journalFormed(): void {
  for (const body of formed.splice(0)) appendEvent(journal, gen, body);
}

/**
 * What the agent does at rest: it forms one memory, of the oldest episode that is over and has
 * none, or does the next thing of that kind (brain/sleep.ts). Returns false when there was nothing
 * to do, or no use in trying now; true also when something arrived while the request goes on.
 */
async function rest(): Promise<boolean> {
  if (background === null) {
    if (Date.now() < restNotBefore) return false;
    const stop = new AbortController();
    const done = sleep({
      skills: () => keptSkills(ctx),
      journal, gen, specs: TOOLS.map((t) => t.spec), budgetChars: budgetChoice.budgetChars, tailChars, logbookChars,
      // While a turn runs, the pulse file says what the turn is doing, not this.
      provider: (messages, specs, options) => provider(messages, specs, { ...options, mayPulse: () => !working }),
      system: () => composeSystem(prompt, soulDir, journal),
      signal: stop.signal,
      append: (body) => { if (working) formed.push(body); else appendEvent(journal, gen, body); },
      past,
      asked: past,
    }).then((slept) => {
      const said = { remembered: 'formed a memory', merged: 'made several memories into one', reflected: 'looked over what it is doing', quarantined: 'no memory could be formed of one stretch; it stays in the journal as it happened' };
      if (slept === 'remembered' || slept === 'merged' || slept === 'reflected' || slept === 'quarantined') say(`[memory] ${said[slept]}`);
      return slept !== 'nothing';
    }, (err) => {
      if (stop.signal.aborted) return true;
      // Not a failed turn: nobody waits for this, so it is neither counted nor journaled, only tried again later.
      say(`[memory] could not form a memory now: ${err instanceof Error ? err.message : String(err)}`);
      restNotBefore = Date.now() + REST_RETRY_MS;
      return false;
    }).finally(() => {
      background = null;
      // The loop may be asleep with more to remember: let it look again.
      idleWake?.();
    });
    background = { done, stop };
  }
  const { done, stop } = background;
  let arrived!: () => void;
  const woken = new Promise<true>((resolve) => { arrived = () => resolve(true); });
  wake = beside ? arrived : () => { stop.abort(); arrived(); };
  resting = true;
  try {
    return await Promise.race([done, woken]);
  } finally {
    wake = null;
    resting = false;
  }
}

// Everything above loaded and parsed: this generation can start.
appendEvent(journal, gen, { type: 'generation.ready', commit: gen });
process.on('exit', () => subagents.stopAll());
// Those that were running when the body last stopped go on, when they are this generation's and their copies are still there.
{
  const { resumed, closed } = subagents.recover();
  if (resumed.length > 0) say(`[subagent] going on after the restart: ${resumed.join(', ')}`);
  if (closed.length > 0) say(`[subagent] closed as cut off: ${closed.join(', ')}`);
}
/** When this body started: the clock counts from here until it has given a tick of its own. */
const startedAt = Date.now();
const heartbeatMs = heartbeatMinutes * 60_000;
/**
 * The conversation since the thing said before the last report to the owner, which is all `reportAsk` reads (brain/agenda.ts):
 * read once, and added to as the journal grows. Read again from its beginning when a later report moves it, or when a
 * conversation was taken back, which changes what stands.
 */
let reported = { from: -1, upTo: 0, events: [] as JournalEvent[] };
function sinceReport(): JournalEvent[] {
  const from = past.stands().report, upTo = past.count();
  if (reported.from !== from) reported = { from, upTo: from, events: [] };
  if (upTo > reported.upTo) {
    const more = past.standingFrom(reported.upTo, upTo);
    reported = more.some((e) => e.type === 'note' && e.kind === BACK_KIND) ? { from, upTo, events: past.standingFrom(from, upTo) } : { from, upTo, events: [...reported.events, ...more] };
  }
  return reported.events;
}
/** What a tick asks when it is time to tell the owner what the agent did on its own; '' when it is not. */
const report = (now: number, everyMs: number | undefined = reportHours * 3_600_000): string => reportAsk(sinceReport(), now, everyMs, past.known());
/** The agenda as a tick offers it (`agendaFor` in heart/coordinator.ts), from what the past holds. */
const agendaNow = (now: number): string => offered(past.known(), now, past.stands().idle, report(now));
/** The same as a pulse asked for by hand and a glance have always read it (`agendaPulse`, `glanceText`): with a report asked for once a day, whatever the owner set for the clock's own ticks. */
const agendaByDay = (now: number): string => offered(past.known(), now, past.stands().idle, reportAsk(sinceReport(), now, undefined, past.known()));
/** When the next tick of the clock is due; undefined with no clock. */
function nextTickAt(): number | undefined {
  const last = past.stands().clock;
  return tickAt(startedAt, last === '' ? undefined : Date.parse(last), heartbeatMs);
}
/** Whether time of its own may be given now. Heartbeat and /heart share the same pulse construction; only the owner command is manual. */
function mayTick(now: number): boolean {
  // Past what the owner allows a day for time of its own, there is no tick: whatever arrives is still answered.
  if (!clockMayTick(sinceSaid(), soulDir) || (ownTokensDay !== null && past.ownSpent(now - 24 * 3_600_000) >= ownTokensDay)) return false;
  // Time of its own is time at rest: no tick while the owner is in conversation, none when the
  // agenda holds nothing that can be acted on now, and fewer when the last ones came to nothing.
  const stands = past.stands();
  return restInOf(stands.owner, now, restMs) === 0 && tickDueOf(stands.idle, stands.clock, now, heartbeatMs)
    && worthATick(past.known(), now, report(now));
}
/** What a tick offers; what waits and is offered for a look is not offered again before a wait that doubles. */
function tickAgenda(now: number): string {
  const text = agendaNow(now);
  for (const item of followUps(past.known(), now).slice(0, 5)) {
    if (item.work !== undefined) appendEvent(journal, gen, { type: 'note', kind: WORK_KIND, data: { intention: item.id, work: lookedAt(item.work, now) } });
  }
  return text;
}
/** The length of the journal when the store was last written out before a sleep. */
let tidiedAt = -1;
/** The store is written out at most this often while the body runs, and once more when it ends. */
const STORE_WRITE_MS = 5 * 60_000;
let storeWrittenAt = Date.now();
/** How often a job the agent left running is looked at, while there is one: its end sends no signal of its own. */
const JOB_LOOK_MS = 2000;
const heart = new Heart({
  // Never read while the heart is given what it asks, below.
  events: () => readEvents(journal),
  // What the heart reads for itself, asked of the past.
  asks: { owed: () => turnOwed(past, journal), owner: () => past.stands().owner, known: () => past.known(), pulse: (now) => ({ source: 'clock', text: `${clockText(new Date(now))} ${agendaByDay(now)}` }) },
  born: () => clockMayTick(sinceSaid(), soulDir),
  emit,
  overheard: () => GLANCE && (past.states('overheard', { state: 'waiting' }).length > 0 || past.states('overheard', { state: 'ignored' }).length > 0),
  glance: async () => {
    // One that was begun beside the turn that has just ended is let finish: the same talk is not decided twice.
    if (glancing !== null) await glancing;
    const decided = await glance(glanceDeps());
    if (decided !== null) say(`[glance] overheard talk: ${decided}`);
  },
  settle: async () => {
    const woken = new AbortController();
    wake = () => woken.abort();
    resting = true;
    try {
      const events = sinceSaid();
      const settled = await settle({ journal, gen, provider, specs: TOOLS.map(t => t.spec), budgetChars: budgetChoice.budgetChars, tailChars, logbookChars, system: () => composeSystem(prompt, soulDir, journal), signal: woken.signal, asked: past }, events);
      if (settled === 'reflected') say('[agenda] settled what the turn left');
      return settled;
    } finally { wake = null; resting = false; }
  },
  remember: rest,
  // What the agent waits for: a job it left running, then its own work that has come due. An owner's interruption holds both until something new arrives.
  arrived: () => {
    if (quitting) return null;
    const now = Date.now();
    // Each asks for what it reads: an interruption lies after the latest thing said, a job and a subagent are notes of their own, and work is what is known.
    const own = heldByInterrupt(sinceSaid()) ? null : endedJob(journal, gen, past.states('job', { state: 'running', gen }).map((row) => row.event)) ?? endedSubagent(journal, gen, past.states('subagent', { state: 'ended' }).map((row) => row.event)) ?? dueWorkOf(journal, gen, now, past.known()) ?? dueSchedule(journal, gen, now, past);
    // And the species, heard from now and then: an offer it has moved past is retired, and the agent told.
    return own ?? staleOffers(now);
  },
  nextLook: () => {
    const now = Date.now(), held = heldByInterrupt(sinceSaid());
    const due = held ? undefined : workDueAtOf(past.known());
    // And what it set itself to do again and again: the next time one comes round.
    const round = held ? undefined : scheduleDueAt(now, past);
    const job = !held && past.states('job', { state: 'running', gen }).length > 0;
    return Math.min(offersLookAt - now, ...(due === undefined ? [] : [due - now]), ...(round === undefined ? [] : [Math.max(0, round - now)]), ...(job ? [JOB_LOOK_MS] : []));
  },
  // The clock: time of the agent's own, offered at rest when a tick is due and there is something to offer.
  tick: () => {
    const now = Date.now();
    return clockTick(now, nextTickAt(), () => mayTick(now), () => tickAgenda(now));
  },
  nextTick: () => {
    const at = nextTickAt();
    return at === undefined ? undefined : at - Date.now();
  },
  backlog: () => past.counts().waiting,
  restMs,
  onError: error => {
    say(`[agenda] could not settle the turn now: ${error instanceof Error ? error.message : String(error)}`);
    restNotBefore = Date.now() + REST_RETRY_MS;
  },
});
// A journal with no stimulus yet means this individual was never born: the letter goes first.
const firstWords = birth(sinceSaid(), letter);
if (firstWords !== null) emit(firstWords);
const stops = sensors.map((start) => start(emit));
// The channels it has heard from before are ones it takes part in: each is seen to once at the start.
{
  const known = new Set<string>();
  for (const e of noted(HEARD_KIND)) {
    if (e.type !== 'note' || e.kind !== HEARD_KIND || typeof e.data !== 'object' || e.data === null || Array.isArray(e.data)) continue;
    const d = e.data as Partial<Heard>;
    if (typeof d.service === 'string' && typeof d.where === 'string' && d.how !== 'dm' && known.size < 50) known.add(`${d.service}\n${d.where}`);
  }
  for (const key of known) { const [service, channel] = key.split('\n'); hearIn(service!, channel!); }
}
// The journal grew: by a stimulus, which wakes by itself in `emit`, by the stem, or by a record
// nobody needs to answer. A request of the agent's own goes on unless a turn is now owed.
stops.push(watchJournal(journal, () => { if (!resting || quitting || words.length > 0 || turnOwed(past, journal)) wake?.(); }));

// Failed turns in a row, and how many of the latest kind. What each kind leads to is in brain/retry.ts.
let failures = 0;
let streak: { kind: FailureKind; count: number } = { kind: 'passing', count: 0 };
for (;;) {
  if (handoff !== null) process.exit(75);
  settleWords();
  // Also true right after a restart: an unfinished turn or a stem note is picked up here.
  while (!quitting && turnOwed(past, journal)) {
    if (retryAt !== null && Date.now() < retryAt) {
      // A failed turn is still owed but its next try is not due. Sleep past it without waking on
      // every stimulus: a clock tick or an inbox message must not hammer a provider already at
      // its limit (see retryAt). The owner's own line clears it in emit.
      const wait = retryAt - Date.now();
      say(`[retry] waiting ${describeDelay(wait)} for the provider's limit before the next try, or until the owner writes`);
      await idle(wait);
      // Any stimulus can end the sleep. Recheck the deadline before calling the provider: only
      // the owner's own message clears retryAt, and the scheduled time may not have arrived.
      continue;
    }
    const before = ownerArrived;
    // The stimulus that woke this turn is already in the journal. Start after the last settled
    // reply/interruption, not at the current end, and include any late work answered by the turn.
    // As a place in the journal's file: what the turn did is read from there when it is over.
    const turnFrom = past.settled();
    working = true;
    const failed = await turn();
    working = false;
    journalFormed();
    settleWords();
    heart.completed(readEventsFrom(journal, turnFrom), process.env.TENERAL_REFLECT_AFTER_TURN !== '0', 0);
    if (handoff !== null) {
      const last = past.latest('stimulus');
      // A terminal line read during the mutation turn is durable and must get its reply now.
      // Re-running mutate would be rejected as a repeated request, so keep the original handoff.
      if (last?.type !== 'stimulus' || last.source !== 'terminal' || !turnOwed(past, journal)) process.exit(75);
    }
    if (failed === null) {
      retryAt = null;
      failures = 0;
      streak.count = 0;
      continue;
    }
    const { error } = failed;
    // A provider that refused the turn must not be asked for anything else beside it.
    stopBackground();
    const kind = failureKind(error);
    failures += 1;
    streak = { kind, count: kind === streak.kind ? streak.count + 1 : 1 };
    // The stack when it is this code's own fault: it is what the next generation needs to mend it.
    say(`[turn failed] ${error instanceof Error ? (kind === 'own' ? error.stack ?? error.message : error.message) : String(error)}`);
    const next = verdict(kind, streak.count);
    if (next === 'exit') {
      // Not the provider: waiting mends nothing. As a crash the stem counts it, and rolls this generation back if it goes on.
      say(`[giving up] ${PATIENCE} turns in a row failed in this generation's own code; exiting so the stem can act`);
      process.exit(1);
    }
    if (next === 'record' && error instanceof ProviderError) {
      // The one failure that is journaled: as a reply, it ends the owed turn, and it is where the owner will read it.
      const note = refusalNote(error, kind);
      appendEvent(journal, gen, { type: 'assistant', text: note, toolCalls: [] });
      console.log(`\n${note}\n`);
      terminalPrompt.answered();
      failures = 0;
      streak.count = 0;
      continue;
    }
    const delay = retryDelayMs(failures, error instanceof ProviderError ? error.retryAfterMs : null);
    const ownerWrote = ownerArrived !== before;
    const note = {
      type: 'note' as const,
      kind: 'turn.failed',
      data: {
        kind, failures, message: (error instanceof Error ? error.message : String(error)).slice(0, 600),
        retryAt: ownerWrote ? null : new Date(Date.now() + delay).toISOString(),
      },
    };
    // For the owner and the record: the turn is still owed, and the journal shows why nothing is
    // coming and when the next try is. Written before any await, so it cannot loop with the retry.
    appendEvent(journal, gen, note);
    if (ownerWrote) {
      // The owner wrote while the turn ran; that message gets its try now, once. Other traffic
      // remains journaled but leaves the provider's backoff in force.
      say(`[retry] ${failures} in a row; the owner wrote meanwhile, trying again now`);
      continue;
    }
    retryAt = Date.now() + delay;
    say(`[retry] ${failures} in a row; trying again in ${describeDelay(delay)}, or when the owner writes`);
    await idle(delay);
  }
  if (quitting) break;
  // The heart chooses one bounded idle activity. A new pulse or reflection loops back so any
  // newly owed turn is answered before memory work or a long sleep.
  const beat = await heart.next();
  if (quitting) break;
  if (beat !== 'wait') continue;
  // Once for each time the journal has grown: a wake only to look whether a job has ended, or a time has come, has nothing new to tidy.
  if (past.count() !== tidiedAt) {
    // Before waiting: the memory sits its exam when enough has been remembered since the last one. No model is asked;
    // the result is journaled, for the owner to see and for a later change of the memory to be held against (immune/gates.ts).
    try {
      // Whether it is due is read in the notes of the memories and of the last exam; the exam itself reads the conversation, asked of the past for that once.
      if (due(noted(RESULT_KIND, EPISODE_KIND, MERGE_KIND))) {
        // The request as a turn would be sent it now: the exam also asks whether it leads to what the questions ask (`listed` in brain/exam.ts).
        const system = composeSystem(prompt, soulDir, journal);
        const view = { tailChars, ...(logbookChars === undefined ? {} : { logbookChars }) };
        const room = budgetChoice.budgetChars - JSON.stringify(TOOLS.map((t) => t.spec)).length - system.toWellFormed().length;
        const frame = frameFrom(past, room, view);
        const told = swapped(frame.head, room, view);
        const text = assemble(frame, system, room + system.toWellFormed().length, undefined, view).map((m) => m.content ?? '').join('\n');
        appendEvent(journal, gen, { type: 'note', kind: RESULT_KIND, data: { ...sit(past, past.standingFrom(0), { text, tailFrom: told === 0 ? 0 : frame.head.kept[told - 1]!.to }), skills: skillUse(ctx) } });
      }
    } catch (err) {
      say(`[memory] the exam could not be sat: ${err instanceof Error ? err.message : String(err)}`);
    }
    // And what the store gained is written out, so that the next start finds it on disk. Not after every turn:
    // writing rewrites the whole day, a second of work on a long one, while what is not written is only laid
    // out again from the journal at the next start, which costs far less than writing it every time.
    try {
      past.sync();
      if (Date.now() - storeWrittenAt >= STORE_WRITE_MS) {
        past.persist();
        storeWrittenAt = Date.now();
      }
    } catch (err) {
      say(`[memory] the store could not be written: ${err instanceof Error ? err.message : String(err)}`);
    }
    // A prompt only where someone can type at it; a wake reuses the existing input place.
    if (process.stdin.isTTY) terminalPrompt.ready();
    tidiedAt = past.count();
  }
  // Until something arrives, until rest begins and there may be something of its own to do, or until what the agent waits for may have come.
  // While it waits, the database embeds what it has not yet (brain/vectors.ts): a portion, about a second of its work,
  // then a look whether anything arrived. Whoever speaks meanwhile is heard after the portion that was under way.
  const waitFor = heart.waitFor();
  const until = waitFor === undefined ? Number.POSITIVE_INFINITY : Date.now() + waitFor;
  let woken = false;
  try {
    for (let covered = -1; !quitting && !woken && Date.now() < until;) {
      const now = past.embed(0);
      if (now === covered) break;   // nothing was left to embed
      covered = now;
      woken = await idle(Math.max(0, Math.min(EMBED_PAUSE_MS, until - Date.now())));
    }
  } catch (err) {
    say(`[memory] the documents could not be embedded: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!woken && !quitting && Date.now() < until) await idle(waitFor === undefined ? undefined : until - Date.now());
}

stopBackground();
journalFormed();
// What was laid out since the store was last written: a body that ends in good order leaves nothing for the next to lay out again.
try { past.sync(); past.persist(); } catch (err) { say(`[memory] the store could not be written: ${err instanceof Error ? err.message : String(err)}`); }
for (const stop of stops) stop();
process.exit(0);
