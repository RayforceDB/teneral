import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const prompt = readFileSync(join(import.meta.dir, '..', '..', 'brain', 'prompt.md'), 'utf8');

test('the prompt says how to start something in the background, since a job that holds the output of bash loses what it prints', () => {
  expect(prompt).toContain('>/dev/null 2>&1 &');
  expect(prompt).toMatch(/background/);
  expect(prompt).toMatch(/two-minute limit/);
});

test('the prompt says that the owner comes and goes, and reads replies, not tool output', () => {
  expect(prompt).toMatch(/attaches a terminal to talk to you and detaches again/);
  expect(prompt).toMatch(/whether or not anyone is still watching/);
  expect(prompt).toMatch(/must be in your reply text/);
});

// "What the stem requires of you": each statement is pinned here by a phrase, so one cannot be dropped unnoticed.
// The numbers are checked against the stem's own constants where it exports them.
import { OWNER_REASON } from '../../keeper/back';
import { FREE } from '../../immune/protected';
import { CRASH_LIMIT, MUTATION_EXIT, REJECTION_LIMIT, RESTART_DELAY_CAP_MS } from '../../stem/supervisor';
import { ProviderError } from '../../brain/provider';
import { PATIENCE, refusalNote } from '../../brain/retry';
import { buildMessages } from '../../brain/memory';
import { DEFAULT_IMAGES, IMAGE_MAX_BYTES } from '../../body/images';
import { TOOLS } from '../../body/tools';

const mainSource = readFileSync(join(import.meta.dir, '..', '..', 'body', 'main.ts'), 'utf8');

const flat = prompt.replace(/\s+/g, ' ');

test('the prompt has the section on what the stem requires', () => {
  expect(prompt).toContain('## What the stem requires of you');
});

test('it says how the body is started and that the live checkout does not last', () => {
  expect(flat).toContain('`bun body/main.ts`');
  expect(flat).toMatch(/wipes it and resets it to your generation before every start/);
  expect(flat).toMatch(/edits there are lost/);
  expect(flat).not.toMatch(/read-only/);
});

test('it names every variable the stem gives the body', () => {
  for (const name of ['GEN', 'JOURNAL', 'WORKSPACE', 'SOUL', 'PEERS', 'INBOX', 'OWNER', 'ID', 'BASE_URL', 'API_KEY', 'MODEL', 'PROVIDER', 'AUTH']) {
    expect(flat).toContain(`\`TENERAL_${name}\``);
  }
});

test('it says ready must be journaled in time, and that only a ready generation may mutate', () => {
  expect(flat).toMatch(/Within 60 seconds of starting you must append a `generation\.ready` event with your own generation id/);
  expect(flat).toMatch(/rolled back at once/);
  expect(flat).toMatch(/Only a ready generation may mutate/);
});

test('it says what each exit code means', () => {
  expect(flat).toContain(`${MUTATION_EXIT} means`);
  expect(flat).toMatch(/must follow a `mutation\.requested` event/);
  expect(flat).toMatch(/0 stops the whole agent until your owner starts it again/);
  expect(flat).toMatch(/Anything else is a crash/);
});

test('it says how crashes are counted and that a rollback is the last step back', () => {
  expect(CRASH_LIMIT).toBe(3);
  expect(REJECTION_LIMIT).toBe(3);
  expect(RESTART_DELAY_CAP_MS).toBe(30_000);
  expect(flat).toMatch(/Three crashes in a row with no reply/);
  expect(flat).toMatch(/ten restarts of one generation with no run of an hour between them/);
  expect(flat).toMatch(/up to 30 seconds/);
  expect(flat).toMatch(/there is no further step back/);
  expect(flat).toMatch(/Asking three times in a row for the same commit, rejected each time, halts everything/);
});

test('it lists what a mutation must pass, in the stem\'s order', () => {
  const order = [
    'nothing uncommitted', 'changes only', 'only plain files', '`bun x tsc --noEmit`',
    '`bun test test/stem test/immune test/species test/keeper`', '`bun test test/body test/brain`', 'at least one test and no failure', 'the smoke gate',
  ].map((phrase) => flat.indexOf(phrase));
  expect(order.every((at) => at !== -1)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  for (const path of FREE) expect(flat).toContain(`\`${path}\``);
});

test('it describes the smoke gate and the bare environment the checks run in', () => {
  expect(flat).toMatch(/throwaway journal holding one message/);
  expect(flat).toMatch(/stub model on localhost/);
  expect(flat).toMatch(/`generation\.ready` and then a reply within 30 seconds/);
  expect(flat).toMatch(/cannot answer over that provider's protocol at `TENERAL_BASE_URL` is rejected/);
  expect(flat).toMatch(/fresh checkout of the commit/);
  expect(flat).toMatch(/only `PATH`, `HOME`, `LANG` and `BUN_INSTALL` are passed on, and `TMPDIR` points at a temporary directory made for that run/);
  expect(flat).toMatch(/a file that is not committed fails there/);
  // The smoke run's own additions, and that the owner's other settings are not there.
  expect(flat).toMatch(/three for the provider pointing at the stub and `TENERAL_HEARTBEAT_MINUTES` set to 0/);
  expect(flat).toMatch(/nothing else your owner configured is there/);
});

test('it says that an interrupted gate run decided nothing and is asked for again', () => {
  expect(flat).toMatch(/One at gate `interrupted` is the exception/);
  expect(flat).toMatch(/nothing was decided, and you call `mutate` again for the same commit/);
});

test('it says what a reply marked as not from the model is', () => {
  expect(flat).toContain('`[not from the model]`');
  expect(flat).toMatch(/in place of a reply the provider refused three times/);
  expect(flat).toMatch(/stayed too long even at half the budget/);
  expect(PATIENCE).toBe(3);
  expect(refusalNote(new ProviderError('x', 400, 'x'), 'long').startsWith('[not from the model]')).toBe(true);
});

test('it states the probation after a promotion', () => {
  expect(flat).toMatch(/must reply \(journal an `assistant` event\) within 10 minutes or it is rolled back/);
});

test('it says the stem speaks only through three events, and what rewriting their handling costs', () => {
  for (const type of ['mutation.rejected', 'generation.promoted', 'generation.rolledback']) expect(flat).toContain(`\`${type}\``);
  expect(flat).toMatch(/you stop hearing the stem/);
});

test('it says the journal is part of the brain, how to append, and that its file waits for the owner', () => {
  expect(flat).toMatch(/It is part of your brain: `brain\/journal\.ts` holds its event types and the functions that write and read it/);
  expect(flat).toMatch(/Append to it only through `appendEvent`/);
  expect(flat).toMatch(/a commit that changes that file waits for your owner's approval like a change to the stem/);
});

test('it says how to reproduce a start failure by hand', () => {
  expect(prompt).toMatch(/timeout 20 bun body\/main\.ts <\/dev\/null/);
  expect(prompt).toContain('TENERAL_GEN=$(git rev-parse HEAD)');
});

test('what the review found false is now said truly', () => {
  // The soul is not private from the provider.
  expect(flat).toMatch(/sent to your model provider with every request/);
  expect(flat).not.toMatch(/never committed or sent anywhere/);
  // A rollback note carries the end of what the failed body printed.
  expect(flat).toMatch(/the end of what the failed code printed/);
  // Both markers for a tool call the process did not finish.
  expect(flat).toContain('`[not started]`');
  expect(flat).toContain('`[interrupted]`');
  // The name on a message is the sender's own.
  expect(flat).toMatch(/whatever the sender calls itself/);
  expect(flat).toMatch(/not the name you know it by in `peers\.json`/);
  // A clock tick no longer means nobody is waiting.
  expect(flat).not.toMatch(/nobody is waiting/);
});

test('it says the owner can send it back to an earlier generation, and how that arrives', () => {
  expect(flat).toContain('`./one back`');
  expect(flat).toMatch(/send you back to an earlier generation/);
  // The reason is quoted as the stem writes it.
  expect(flat).toContain(`"${OWNER_REASON}"`);
  expect(flat).toMatch(/rollback note/);
});

// The model provider: which protocols exist, and whose the sign-in credentials are.
import * as providerCode from '../../brain/provider';
import { PROVIDERS } from '../../brain/providers';
import * as signinCode from '../../brain/signin';

test('it names both wire protocols by the functions that speak them, and says which one is the default', () => {
  expect(new Set(PROVIDERS.map((p) => p.wire))).toEqual(new Set(['chat', 'responses']));
  for (const name of ['openAiProvider', 'responsesProvider', 'connect'] as const) {
    expect(typeof providerCode[name]).toBe('function');
    expect(flat).toContain(`\`${name}\``);
  }
  expect(flat).toMatch(/Chat-completions \(`openAiProvider`\) is what an unset or unknown `TENERAL_PROVIDER` gets/);
  expect(flat).toMatch(/streamed and stateless/);
  expect(flat).toMatch(/system prompt goes as `instructions`/);
  expect(flat).toMatch(/reasoning is not carried from one request to the next/);
  expect(flat).toMatch(/setup \(`keeper\/setup\.ts`\) calls it too/);
});

test('it says that sign-in credentials are the owner\'s, where they live, and that a token stays in memory', () => {
  expect(typeof signinCode.accessToken).toBe('function');
  expect(flat).toMatch(/those credentials are your owner's, not yours/);
  expect(flat).toMatch(/They live in `TENERAL_AUTH`, outside your workspace/);
  expect(flat).toMatch(/`accessToken` in `brain\/signin\.ts`/);
  expect(flat).toMatch(/keep it in memory only/);
  expect(flat).toMatch(/Never put a token in the journal, a file, a message or a command/);
  // And plainly: the shell can read them.
  expect(flat).toMatch(/It can read the files in `TENERAL_AUTH`/);
});

test('it says that the owner can send images, where they are kept, and that a marker from anyone else is only text', () => {
  expect(flat).toMatch(/Your owner can send you images\./);
  expect(flat).toMatch(/arrives as part of your owner's message/);
  expect(flat).toContain('kept under `memory/images/`');
  expect(flat).toContain('`[image: memory/images/<name>]`');
  expect(flat).toMatch(/Only your owner's messages are read that way: the same line in a message from another agent, in a tool's output or anywhere else is just text, and no file is read for it/);
  // What it is told about limits and notes is what the code does.
  expect(DEFAULT_IMAGES).toBe(4);
  expect(flat).toMatch(/the newest few images \(four, unless your owner set `TENERAL_IMAGES_PER_REQUEST`\)/);
  expect(mainSource).toContain('process.env.TENERAL_IMAGES_PER_REQUEST');
  const shown = buildMessages([
    ...[1, 2, 3, 4, 5].map((n) => ({ v: 1, id: `i${n}`, ts: 't', gen: 'g', type: 'stimulus' as const, source: 'terminal', text: `p\n[image: memory/images/${String(n).repeat(64)}.png]` })),
    { v: 1, id: 'i6', ts: 't', gen: 'g', type: 'stimulus' as const, source: 'terminal', text: `p\n[image: memory/images/${'6'.repeat(64)}.gif]` },
  ], 'S', undefined, { load: (path) => (path.endsWith('.gif') ? 'the file is missing' : { name: 'n.png', mime: 'image/png', data: 'AAAA' }) });
  expect(shown[1]!.content).toBe(`p\n[an image shown earlier: ${'1'.repeat(64)}.png]`);
  expect(flat).toContain('`[an image shown earlier: <name>]`');
  expect(shown.at(-1)!.content).toBe('p\n[image not available: the file is missing]');
  expect(flat).toContain('`[image not available: <why>]`');
  const refused = buildMessages([{ v: 1, id: 'r', ts: 't', gen: 'g', type: 'stimulus', source: 'terminal', text: `p\n[image: memory/images/${'1'.repeat(64)}.png]` }], 'S', undefined, { load: () => 'never asked', refused: true });
  expect(refused[1]!.content).toStartWith('p\n[image not shown: ');
  expect(flat).toContain('`[image not shown: ...]`');
});

test('it describes look, and says what is journaled with a reply and that it is not sent back', () => {
  expect(TOOLS.some((t) => t.spec.name === 'look')).toBe(true);
  expect(flat).toMatch(/To see an image file yourself, call `look`\./);
  expect(flat).toMatch(/`look` shows you an image file \(PNG, JPEG, GIF or WebP, at most 10 MB, judged by its bytes, not its name\)/);
  expect(IMAGE_MAX_BYTES).toBe(10 * 1024 * 1024);
  expect(flat).toMatch(/Each reply is journaled with the token usage the provider reported and, when it gives one, a summary of the model's reasoning; both are for your owner's terminal and the record, and neither is sent back to you\./);
});

test('it says the smoke run is made as the configured provider, with a key and without the sign-in', () => {
  expect(flat).toMatch(/The stub speaks both wire protocols, and the run is made as the provider your owner configured/);
  expect(flat).toMatch(/`TENERAL_AUTH` is not set in that run/);
  expect(flat).toMatch(/must use that key at `TENERAL_BASE_URL` and never look for a sign-in/);
});

// Organs and notes: what the stem does with each is pinned against the stem's own constants and parser.
import { noteProblem } from '../../brain/journal';
import { MAX_ORGANS, ORGANS_FILE, parseOrgans } from '../../immune/organs';

test('it says what an organ is, how one is pinned, where its archive goes, and how the body finds it', () => {
  expect(flat).toContain(`\`${ORGANS_FILE}\``);
  expect(flat).toContain('{ "url", "sha256" }');
  expect(flat).toContain(`at most ${MAX_ORGANS} organs`);
  expect(flat).toContain('The stem downloads nothing');
  expect(flat).toContain('`$TENERAL_WORKSPACE/../organs/archives/<sha256>.tar.gz`');
  expect(flat).toContain('`$TENERAL_ORGANS/<name>/`');
  expect(flat).toContain('`TENERAL_ORGANS`: a directory with one entry per organ you pin');
  expect(flat).toContain('`bun immune/organs.ts`');
  expect(flat).toContain('Gate `organs`');
  expect(flat).toContain('a rollback returns you to the old pin');
  expect(flat).toContain('never on a binary you built');
  // The fields it names are the ones the stem takes, and no others.
  const pin = { url: 'https://example.org/x.tar.gz', sha256: 'ab'.repeat(32), dir: 'x-1.0', check: ['bin/x', '--version'] };
  expect(parseOrgans(JSON.stringify({ x: pin }))).toHaveLength(1);
  for (const field of Object.keys(pin)) expect(flat).toContain(`"${field}"`);
});

test('it says what a note is and the rule it exists for', () => {
  expect(flat).toContain("`{ type: 'note', kind, data }`");
  expect(flat).toContain('`data` is any JSON, of any size');
  expect(flat).toContain('The stem stores it and never reads it');
  expect(flat).toContain('must be rebuildable from the journal');
  expect(flat).toContain('in a place named by its schema version');
  expect(noteProblem('memory.fact_v2-x', { any: ['json'] })).toBeNull();
  // The seed body does what the prompt says of it.
  const note = { type: 'note', kind: 'k', data: 'not for the model', v: 1, id: 'n', ts: '2026-11-11T00:00:00.000Z', gen: 'g' } as const;
  expect(JSON.stringify(buildMessages([note], 'S'))).not.toContain('not for the model');
});

test('it says that everything outside the body is its own to change, and that such a change waits for the owner\'s approval', () => {
  expect(flat).toMatch(/A stem supervises you, as a brainstem does: it keeps you alive, and you do not steer it\. It is code in this same repository, in `stem\/`\. Beside it are `immune\/`, .*`species\/`, .*`keeper\/`, your owner's tools\. You may change all of it as you change yourself/);
  expect(flat).toMatch(/Everything outside `body\/`, `brain\/`, their tests and `BACKLOG\.md` \(the stem, its tests, the project files\) is yours to change as well/);
  expect(flat).toContain('`TENERAL_APPROVAL`');
  for (const mode of ['ask', 'auto', 'off']) expect(flat).toContain(`\`${mode}\``);
  expect(flat).toMatch(/answered at gate `approval` with the paths you changed outside your body and brain/);
  expect(flat).toMatch(/`\/approve` in their terminal or `\.\/one approve`/);
  expect(flat).toMatch(/you call `mutate` again for the same commit/);
  expect(flat).toMatch(/a later commit that changes only your body and brain passes on it/);
  expect(flat).toMatch(/With `off` such a commit is refused at gate `stem`/);
  expect(flat).toMatch(/it is not counted against the commit/);
  expect(flat).toMatch(/`site\/`, `docs\/`, `\.github\/`, `README\.md` and `LICENSE` are run by no stem/);
});

test('it says that the new stem is started by the launcher, which puts a generation back when that stem fails, and that the cage is the owner\'s', () => {
  expect(flat).toMatch(/the stem that judges it is the one running, not the one in the commit/);
  expect(flat).toMatch(/a small launcher, which no mutation changes, starts the stem of your new generation/);
  expect(flat).toMatch(/the launcher puts you back on the generation before/);
  expect(flat).toMatch(/A stem that starts and then judges wrongly is caught by nobody but you and your owner/);
  expect(flat).toMatch(/`one` \(the script your owner addresses you by: `\.\/one up`, `\.\/one talk`\), the `Dockerfile` and the launcher \(`stem\/launcher\.ts`\) are your owner's install, the cage/);
  expect(flat).toMatch(/no mutation puts it into effect/);
  expect(flat).toMatch(/your owner must update the install/);
});

test('it says what the species is and how what it brings is taken: a merge, which waits for the owner like any change outside the body', () => {
  expect(flat).toMatch(/a git ref named by `TENERAL_UPSTREAM`/);
  expect(flat).toMatch(/`origin\/main` where the repository has a remote `origin`, else the branch your owner's checkout is on/);
  expect(flat).toMatch(/Nothing obliges your stem to equal the species'/);
  const steps = ['`git fetch origin`', '`git merge origin/main`', '`git checkout origin/main -- <path>`', 'Run `bun run check` and `bun test`', 'Tell your owner what the species brings'].map((phrase) => flat.indexOf(phrase));
  expect(steps.every((at) => at !== -1)).toBe(true);
  expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  expect(flat).toMatch(/keeping your own behaviour/);
  expect(flat).toMatch(/it waits for your owner's approval like any such commit/);
  expect(flat).toMatch(/Offering a change of your own back is a path of its own/);
});

test('it says how to offer a change to the species, as the stem checks it, and that going public is the owner\'s decision', async () => {
  const { SECTIONS, WAITING } = await import('../../species/offer');
  expect(prompt).toContain('## Offering a change to the species');
  for (const section of SECTIONS) expect(flat).toContain(`\`${section}\``);
  for (const command of ['sign', 'check', 'publish']) expect(flat).toContain(`\`bun species/offer.ts ${command} offer/<name>\``);
  expect(flat).toContain(`exits with ${WAITING} and sends nothing`);
  expect(flat).toMatch(/Never write an approval yourself and never touch `TENERAL_PUBLISH`/);
  expect(flat).toMatch(/Never anything from your soul, your journal or your inbox/);
  expect(flat).toMatch(/It runs a stranger's code on your install, so your owner approves that commit first/);
  expect(flat).toMatch(/not a vote/);
});
