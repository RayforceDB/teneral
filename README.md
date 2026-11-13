# teneral

An agent distilled by evolution. Each teneral rebuilds itself around its owner's work, one measured generation at a time. What proves itself in one individual is offered back to the species, so a new clone starts from the distilled experience of every one before it, and then becomes its own. Built on [RayforceDB](https://rayforcedb.com/).

*Teneral* is what entomologists call an insect that has just molted: the new body is there, but it has not hardened yet. Here it is a generation of the agent's code that was just switched on and has not yet proven it works.

The question behind it is whether an agent can get better by rewriting its harness, and where that stops helping. Read [What it does not do yet](#what-it-does-not-do-yet) before trusting it with anything.

## How it works

One repository holds a whole individual, laid out as an organism, and three directories that belong to that one individual and are never committed.

- `stem/` is its brainstem: the part that keeps it alive and that it does not steer. A small supervisor starts the agent, restarts it, and puts back the previous generation when a new one fails. Under it is the launcher, which starts a stem and goes back from one that does not work.
- `immune/` decides what becomes part of it: the gates every new generation must pass, your approval of a change [outside the body](#outside-the-body), and the pinned archives it runs on, each verified by its hash.
- `brain/` is what the agent thinks and remembers with: how it calls the model (`brain/provider.ts`), its memory, which decides what of the journal is in mind for a request (`brain/memory.ts`), the turn itself (`brain/loop.ts`), and the prompt it is given with its soul (`brain/prompt.md`, `brain/soul.ts`). The journal is part of the brain too: `brain/journal.ts` holds its form and the code that writes and reads it, for the agent and for the stem alike. That one file is not changed on the agent's word alone: it waits for your approval like a change to the stem, because a journal is never rewritten and never rolled back with the code.
- `body/` is what it acts and senses with: its tools, its sensors, and `body/main.ts`, where the stem starts it. Brain and body are the agent's own: it rewrites both on its own word. Nothing limits their size: how much of itself the agent can hold in mind is the agent's to manage.
- `species/` is its kin: which line it descends from, and how it offers a change of its own back.
- `keeper/` is yours, not part of the organism: the terminal you talk to it in, the setup, and the commands by which you approve a change or send it back a generation.
- `one` is how you address it: `./one up`, `./one talk`, `./one approve`. It is someone, and who that is, it writes itself. The script builds and runs its container; with the `Dockerfile` and the launcher it is your install, and no mutation changes it.

The agent may change all of the code above. What it changes in its brain and body it mutates into on its own word; anything else waits for your approval.

- `memory/journal.jsonl` is the agent's history, append-only. Every event carries the commit of the code that wrote it, so generations can be compared.
- `soul/` holds a few Markdown files the agent writes about who it is and who it works with. They are part of every request to the model.
- `inbox/` is where other programs leave messages for it.

One commit of the agent's code is a *generation*. Asking the stem to switch to a new one is a *mutation*:

1. The agent edits a second checkout of this repository, `.teneral/candidate`, on the branch `lineage/local`. The code it is running is a third checkout, `.teneral/live`, which the stem resets to the exact commit before every start.
2. The agent calls its `mutate` tool. The tool commits the candidate, journals the request, and the process exits with code 75 when the turn ends.
3. The stem checks the commit:
   - compared with the running generation, a commit that changes only `body/`, `brain/`, their tests (`test/body/`, `test/brain/`) and `BACKLOG.md` goes on at once. This is an allowlist: a commit that changes any other path, the stem's own files and any new file included, waits here for [your approval](#outside-the-body) and goes on when it has it;
   - `body/` may hold only regular files;
   - every organ the commit pins (see [Organs](#organs)) is in the cache with exactly the pinned hash, unpacks safely, and passes its own check. A body that pins none skips this;
   - in a fresh checkout the stem makes of exactly that commit, the type check, the tests of everything outside the body (`test/stem`, `test/immune`, `test/species`, `test/keeper`) and the agent's own tests, of its body and its brain, must pass. A test run counts only if it ends with bun's summary showing at least one passing test and no failures. The checks run with almost none of the stem's environment (only `PATH`, `HOME`, `LANG` and `BUN_INSTALL` are passed on), so code under test does not see the API key, and with a temp directory of their own inside that checkout, which goes when the checkout does;
   - last, the smoke run: in the same checkout the stem starts the candidate the way it starts a generation, on an empty throwaway install with one message waiting and a stand-in for the model that the stem serves on a local port. The stand-in speaks both wire protocols, and the candidate is run as the provider you configured, with a dummy key: never with your key or your sign-in. Its environment is the checks' with the variables a generation is started with added, the model's pointing at the stand-in and the clock off; nothing else from `.env` is there. The candidate has 30 seconds to report that it is ready and to answer the message. Code that passes its tests but does not start, or starts and never takes a turn, stops here.
4. If a check fails, the same generation starts again and is told which check and what it printed. If all pass, the stem switches to the new commit and starts it.
5. A new generation has 60 seconds to report that it is ready, and 10 minutes to produce its first reply: the note about its promotion is waiting for it, so a working one answers. If it exits abnormally before it is ready, or is not ready in time, or is alive but silent after those 10 minutes (being interrupted by you is not silence: see [Interrupting](#interrupting)), or later crashes three times in a row without producing a reply, or needs more than ten restarts, the stem returns to the generation before it and tells the agent why, with the end of what the failed generation wrote to stderr. There is one step back, not a history: if that generation fails too, or there is none because this is the first, the stem stops.

Around that:

- Only a generation that became ready may mutate, so the one kept for rollback is always one that started.
- The 10 minutes apply until a promoted generation's first reply and never after. An outage of the model does not roll back a generation that has already answered once. Neither does anything else: a generation that answers once and then stays alive without answering again is not caught, and you will only see it as silence in `./one talk`. `./one back` is for that.
- A restart after a crash waits a second longer for each crash in a row. The ten restarts are given back when a run lasted an hour before it failed.
- A rejected mutation is followed by a wait as well. Asking for a different commit each time is ordinary work and is never limited. Asking for the same commit and having it rejected three times in a row stops the supervisor and leaves it to you.
- Every mutation request gets an answer. If the stem is stopped while the checks run (`./one down`, Ctrl-C in `./one fg`), the running check is killed and the stem exits within a few seconds; at the next start the agent is told that nothing was decided and to ask again. The same happens when the agent's process dies between asking and exiting.
- In the journal a request is `mutation.requested` and a refusal is `mutation.rejected`. An individual born before the act had this name wrote them as `molt.requested` and `molt.rejected`, through a tool named `molt`. A journal is never rewritten, and such a body runs until it changes itself, so the stem and both talk clients read the old names as the new ones for good, and a request made under the old name is answered under it.
- A lock file keeps a second supervisor from running the same checkout, and a body left behind by a supervisor that was killed is stopped before a new one starts.

The agent is woken by sensors, not only by you typing: your lines are one, a clock is another (every 30 minutes unless you change it, and silent until the soul is written), its inbox is a third, and it can build more. It runs in the background, so the clock and the inbox reach it whether or not a terminal is open.

## Organs

An organ is a native dependency the agent adopts for its body: a program or a library that somebody else publishes as release archives. The agent chooses it, pins it, and later upgrades it by itself. The mechanism knows nothing about any particular one.

**The brain's engines.** What the agent remembers and thinks with is no organ of its body: the database its memory lives in belongs to its brain. Such an engine is pinned in `brain/engines.json`, in the same shape and by everything said below of an organ: the same cache, the same gate, the same directory in `TENERAL_ORGANS`, the same rollback. A name stands for one thing, so none may be pinned in both files, and the limit of 16 pins counts both.

**The pin** is `body/organs.json`, a file of the body like any other, so it mutates and rolls back with the code that uses it:

    {
      "rayforce": {
        "url": "https://github.com/RayforceDB/rayforce/releases/download/v3.0.2/rayforce-3.0.2-linux-x86_64.tar.gz",
        "sha256": "ea20fd48a223ffb3ed3e37a5edcb8a7caf5c5199d4cc8ba4e072d0c21e4a57b7",
        "dir": "rayforce-3.0.2-linux-x86_64",
        "check": ["rayforce", "--help"]
      }
    }

A name (`a-z`, `0-9`, `-`) maps to the `https` address of a `.tar.gz` archive and the archive's SHA-256. `dir` is optional: the directory inside the archive that is the organ's root, for an archive that wraps everything in one. `check` is optional: a command run in the organ's root that must exit with 0 within 60 seconds; its first word is a file of the organ. At most 16 organs. Nothing else is accepted in the file, and a field nobody defined is refused. No file, or `{}`, means no organs, and then nothing described here happens at all.

**The cache** is `.teneral/organs/`, outside git, with everything named by the archive's hash:

    .teneral/organs/archives/<sha256>.tar.gz    the archive, put there by the agent
    .teneral/organs/trees/<sha256>/             the archive unpacked, by the stem
    .teneral/organs/sets/<id>/<name>            one link per pinned organ, to its root

The agent downloads an archive itself, with its own tools. The stem never reaches the network for one and does not take the agent's word either: it computes the hash of the cached file itself.

**The gate** `organs` runs after the size check and before anything of the candidate's is executed. For each pin of the candidate commit: the archive is in the cache and hashes to the pin (at most 256 MB); it is unpacked, unless that was done before, beside its place and renamed into it, so a tree that exists is a whole one; then the check runs, with the bare environment of every check. Unpacking refuses the whole archive for any entry that is not a plain file, a directory or a link that stays inside: a name that is absolute or climbs with `..`, a second entry for a name already written, a file that would be written through a link, a link pointing out, a device, a fifo; more than 1 GB unpacked or more than 20,000 entries. A refusal rejects the mutation with a message that says what to do, for example `organ rayforce: it is not unpacked, and archive ea20… is not in the cache at …/archives/ea20….tar.gz; download https://… there first`.

**The body finds its organs** through `TENERAL_ORGANS`: a directory with one entry per organ, by name, so the example's program is `$TENERAL_ORGANS/rayforce/rayforce`. The variable is set for the candidate's tests and its smoke run, from the candidate's pins, and for every generation at its start, from the pins of that generation's own commit. It is not set for a body that pins nothing. The unpacked tree is shared by every generation that pins the same archive and is to be read, not written: what an organ stores belongs elsewhere.

**Rollback** needs nothing more. The generation before pins what it pinned, and that tree is still in the cache: the stem never removes an archive or a tree, the current generation's, the previous one's or any other (so the cache only grows; see `BACKLOG.md`). At each start, a tree that is missing is unpacked again from its archive. When the archive is gone as well, the supervisor does not start the generation and does not roll it back: it stops and says which archive belongs at which path and where to download it, and `./one up` goes on from there once the file is back. A cache that was wiped is a fault of the install, not of the generation, and going a generation back would give up a sound one.

**An upgrade**, as the agent does it: download the new archive and the hash its publisher gives; verify one against the other; move the archive to `archives/<sha256>.tar.gz`; change the pin in the workspace; run `bun immune/organs.ts` there, which does for the workspace's pins exactly what the gate will do and prints the directory to use as `TENERAL_ORGANS` for its own test run; then mutate. If the new version turns out worse, the stem's rollback or `./one back` returns to the old pin with the old code.

**Improving the dependency itself** does not go through the stem. The image has `git`, `curl`, `clang` and `make`: the agent clones the dependency's source, builds and tests a patch locally, and proposes it upstream. Only a published release is pinned; when one holds the fix, it is installed as any upgrade. A locally built binary is for trying the patch, not for the body to depend on.

## Notes, and what the body keeps outside the journal

The journal has one event that is the body's own: `{ "type": "note", "kind": "...", "data": ... }`. The stem stores it and never reads it; the talk clients do not show it, and it is neither a reply nor something that wakes the agent. `kind` is a short name the body chooses (`a-z`, `0-9`, `.`, `_`, `-`, at most 64 characters), `data` is anything that is JSON, of any size. A note that breaks this is refused when it is appended, with nothing written. The seed body writes none and passes them over when it builds a request.

It is there for one rule: **anything the body keeps outside the journal must be rebuildable from the journal, and lies in a place named by its schema version, so that a rolled-back body finds data it understands.** An index, a database, a summary are derived: the journal is the record, and what a store was built from must be in it, as the conversation itself or as notes. A body that changes the shape of its store writes to a new place (`memory/store-v2/`, not `memory/store/` in a new shape) and builds it from the journal; the old place stays as it was. After a rollback the older body opens the place it knows, finds it as it left it, and replays what the journal gained since. A store that is lost or damaged is a store to build again, never a loss.

## Outside the body

The agent may change anything in its repository: its body and brain, and also the stem that supervises it, the immune gates that judge it, their tests and the project's files. What it changes in its own code, `body/` and `brain/` with their tests, it mutates into on its own word. A mutation that changes anything else waits for yours, and that is the only difference. "The body" below is short for that own code, brain included.

**The rule.** A candidate that differs from the running generation outside `body/`, `brain/`, `test/body/`, `test/brain/` and `BACKLOG.md` passes only when, outside those paths, it holds exactly what a commit you approved holds. So an approval is for what a commit holds outside the body: a later commit that changes only the body passes on it, also after a rollback, and a commit that changes anything else again waits again. A candidate that leaves everything outside those paths as the running generation has it is an ordinary mutation and is not looked at here.

**Your approval.** `TENERAL_APPROVAL` in `.env` says what you allow:

| `TENERAL_APPROVAL` | |
|---|---|
| `ask` (the default) | The mutation waits at gate `approval` until you have approved it. The answer names the paths it changes outside the body and tells the agent to ask you. Nothing of the candidate has run at that point. |
| `auto` | No approval is needed: the agent changes its stem as it changes its body. |
| `off` | A mutation that changes anything outside the body is refused, at gate `stem`. |

You approve with `./one approve` (the commit the agent last asked about) or `./one approve <commit>`, or with `/approve` and `/approve <commit>` in `./one talk`. Either says back the commit, its first line and the paths it changes outside the body, and tells the agent to ask for its mutation again. In `./one talk` a mutation that waits for you stands in the conversation as a notice with those paths. What you approved is kept in `.teneral/approval.json` and journaled as `mutation.approved`, with the way it came: `one` or `talk`. From a talk client the approval travels as a file in `.teneral/owner/` whose name starts with a dot and ends in `.mutation`, holding the commit; the stem takes it in before it next judges a mutation, and no body reads it, because every body passes over names that start with a dot. A line you type is always a `.txt` file, so no text is ever taken for an approval, and `/approve` piped into `./one talk` is a line like any other. A mutation that waits for you is not counted towards the three rejections of one commit that stop the supervisor.

**What you are approving.** The agent's account of the change is in the conversation; the change itself is `git diff <running generation> <commit>` in this directory. Nobody else reads it. Once it is approved and through the checks, that stem is what judges the next mutation, takes your approvals and puts a failed body back. Approve a change to the stem as you would merge a pull request to it.

**The stem of a generation is the stem that runs it.** After a mutation that changes the stem is promoted, the supervisor, the gates, the talk client, `back` and `approve` are that generation's own, run from `.teneral/live`. What the container starts is a small launcher, `stem/launcher.ts`, from this checkout. It checks the current generation out in `.teneral/live`, starts `stem/main.ts` from there, and starts the next stem when a supervisor ends with status 85, which a supervisor does after it changed the generation, by a promotion or a rollback, to one whose stem differs from its own. The old stem judges the new one: the gates for the candidate run under the running generation's stem, and execute the candidate's own stem tests in the gate checkout, as before.

A generation from before the launcher has a stem that cannot run from `.teneral/live`; this checkout's stem supervises it, as it always did. That is also how an existing install comes up: `git pull`, `./one down`, `./one up`, nothing else. Its state file is unchanged and is read as it is.

The launcher and a stem agree by a versioned contract, written at the top of `stem/launcher.ts`. A stem says in `stem/launch.json` the lowest launcher version it can be started by; the launcher is version 1. A commit whose stem says it needs a newer launcher than this checkout has is refused at gate `stem` with `your owner must update the install`. Should the current generation need one all the same, the launcher starts nothing, says `the owner must update the install (git pull, then ./one down and ./one up)` and exits with status 78. It does not loop.

**When the new stem does not work.** The stem that promotes a mutation with another stem writes `.teneral/trial.json` first. Until the new generation has journaled `generation.ready` under its new stem, the launcher holds that stem on trial. If it cannot be started, ends before that (with any status), has not got there within 5 minutes, or asks for another stem without having changed the generation, the launcher goes back to the generation before: it writes the state file and a `generation.rolledback` event itself, with the reason and the end of what that stem wrote to stderr, and starts the previous generation's stem. None of that is done by the stem that failed. A new stem that works, with a body that does not, rolls the body back itself as any stem does, and the launcher then starts the old stem again. Once the generation was ready the trial is over; a stem that fails later ends the launcher with its status and waits for you, and `./one back` returns to an earlier generation and its stem.

**The cage is yours.** `one`, the `Dockerfile`, `.dockerignore` and the launcher are the install. They live in this checkout and no mutation puts another version of them into effect, whatever the lineage's commit holds; the container's flags are what your `one` says. When the generation's versions differ from this checkout's, the supervisor logs one line and `./one talk` shows it; you look at the difference (`git diff HEAD lineage/local -- box`) and take it, or not: with `git pull` here when it is the species', by hand when it is the agent's own.

**Which stem each command uses.**

| Command | Runs |
|---|---|
| `./one up`, `./one fg` | this checkout's launcher, which starts the current generation's stem |
| `./one talk`, `./one back`, `./one approve` | the stem in `.teneral/live`, once a generation has one; this checkout's for a generation from before the launcher. `bun stem/launcher.ts home` prints which |
| `./one setup`, `./one run <command>` | this checkout: `./one run bun keeper/back.ts` is this checkout's `back`, for when the generation's own is what is broken |
| `./one logs`, `./one down` | no stem: Docker |

A talk client older than the journal is no problem: every reader passes over event kinds it does not know.

**The page, the documents, the CI.** `site/`, `docs/`, `.github/`, `README.md` and `LICENSE` are run by no stem, so a commit that changes nothing else outside the body is taken like a change to the body: no approval, no new stem started.

**What this does not stop.** The rule is checked on a mutation. The agent has a shell in this directory: it can write the approval file itself, or edit `.teneral/live` directly. And a stem you approved can do away with the rule. As everywhere here, this guards against mistakes, not against intent. What stays out of a mutation's reach is the launcher, and with it the way back from a stem that does not start.

## The species

`main`, as the project publishes it, is the *species*: the stem, its tests, this README, the seed body. An individual's branch is a *lineage* of it. A lineage takes what the species gained after its birth by merging it, and gives back what it made by [offering it](#offering-a-change-to-the-species).

A merge of the species changes files outside the body, so it is a mutation that waits for your approval like any other that does; nothing else about it is special. Nothing obliges a lineage's stem to equal the species': an agent that changed its own stem resolves, in the merge, whatever the two changed alike, and the further its stem goes its own way, the more of each merge is its own work.

**Which ref.** `TENERAL_UPSTREAM` in `.env` names it: `<remote>/<branch>` when the first part is a remote of this repository, else a local branch. Unset, it is `origin/main` when there is a remote `origin`, else the branch this checkout is on. The agent fetches and merges it in its workspace; the stem never changes a remote's address and never pushes.

**A development checkout.** If you work on teneral in the same checkout your individual lives in, your `main` runs ahead of `origin/main`, and the agent cannot take what you have not pushed. Set `TENERAL_UPSTREAM=main`: the species is then your local branch, and the agent merges `main`. With `TENERAL_APPROVAL=ask` you still approve each such merge before its stem runs.

## Birth

The first time you start it, the agent speaks first. Its journal holds no message yet, so the first one in it becomes the letter in `BIRTH.md`. The letter asks the agent to read its own code, tell you what it found, and ask who it should be for you: its name, what you want from it, how much initiative to take. Then it writes its soul, `soul/SOUL.md` and `soul/OWNER.md`, and from then on those files are part of every turn. They are the agent's own to revise, and they are never committed.

If you want a different beginning, edit `BIRTH.md` and commit it before the first start.

## Talking to it from outside

Anything can reach the agent by putting a JSON file into `inbox/` (create the directory if it is not there yet): another teneral agent, a script, a bridge to a chat service. The format is in `body/envelope.ts`:

    {"v": 1, "id": "note-1", "from": "script", "to": "anyone", "replyTo": null, "ts": "2026-11-11T12:00:00Z", "hops": 0, "text": "hello"}

The file name must end in `.json`. Write it under another name and rename it, so it is never read half-written. The inbox is looked at every two seconds; a message that was taken in moves to `inbox/seen/`, a file that is not a valid envelope to `inbox/rejected/`.

To let the agent write to another one, list that agent's inbox in `soul/peers.json`:

    { "bob": "/path/to/other/teneral/inbox" }

Messages are not signed. The agent is told to treat them as untrusted and not to change its code or run commands because one asked, and an exchange of replies is cut off after four. The limit on replies is in the body's `send` tool and the rest is an instruction to the model; the stem enforces neither.

## Run it

Requires Docker and git.

    ./one up                # start the agent in the background; the first time, it sets up a model provider first
    ./one talk              # attach this terminal to it
    ./one down              # stop it
    ./one back              # send it back to the generation before
    ./one approve           # approve the mutation it asked for that changes something outside its body
    ./one setup             # choose another model provider, or sign in again
    ./one offer list        # what the agent wants to offer to the species; see "Offering a change to the species"

Commit your changes before the first start: the stem creates its worktrees from `HEAD`.

The first `./one up` finds no `.env` and runs the setup: you choose a model provider, give it what it needs, and two test requests are made, one that must be answered in words and one that must come back as a tool call. Only when both work is `.env` written, and the agent starts. At a terminal the setup is a few full-screen pages: you choose with the arrow keys or a number, a key is typed unseen, the two tests show their progress, and the last page says what was written and where. `./one setup --plain` asks the same questions as lines of text. It also installs the project's two development dependencies once, which the checks on a mutation need. From a script, with no terminal to ask at, `./one up` says what is missing and exits with status 1.

### Model providers

The setup offers what `brain/providers.ts` lists:

1. **ChatGPT plan (Continue with ChatGPT).** The agent's requests use your ChatGPT Plus or Pro plan, through the sign-in OpenAI documents for open-source apps that run locally ([Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source)). No API key is involved.
2. **OpenAI API key.** Pay as you go, at `https://api.openai.com/v1`, over the Responses API.
3. **Another OpenAI-compatible endpoint.** Any chat-completions endpoint: you type its base URL, a key and a model that supports tool calls. This is what the project did before there was a choice, and what a `.env` without `TENERAL_PROVIDER` still means.
4. **Kimi Code plan.** A Kimi membership with Kimi Code benefits, with an API key you create in the Kimi Code Console, at `https://api.kimi.ai/coding/v1` over the Responses API, which Kimi Code documents for third-party tools. In mainland China the address is `https://api.kimi.com/coding/v1`: put it in `TENERAL_BASE_URL` after the setup. Which models the key may use depends on the plan.

What the ChatGPT sign-in does:

- The setup shows an address at `auth.openai.com`, as one line that your terminal wraps, so that selecting it copies it whole; where the terminal supports links it can also be clicked. You open it in your own browser, sign in there and approve the app, which OpenAI shows under the name `teneral`; you never type a password into teneral. The address is for you alone. The setup waits until your browser comes back; Esc gives up.
- OpenAI sends your browser back to `http://127.0.0.1:1455/auth/callback`, where the setup is listening. For that, and only for the time of the sign-in, `./one setup` publishes port 1455 on this machine's loopback address. No other command opens a port. If 1455 is taken, `TENERAL_CALLBACK_PORT=<port> ./one setup` uses another.
- The tokens OpenAI issues are stored in `.teneral/auth/chatgpt.json`, readable only by your user. An access token lasts an hour and is renewed by itself; the sign-in as a whole lasts 30 days from its last renewal. `.env` holds no key for this provider.
- **The agent's own shell can read that file.** It runs as your user in a directory it can see all of. The agent is told the credentials are yours and to leave them alone, and its code keeps the token out of its environment, its journal and its workspace; nothing stops a command it runs from reading the file. The same has always been true of an API key in `.env`.
- What the agent uses counts against your plan. On Plus, the five-hour limit is one total shared with everything else that uses your plan. Review it, limit this app's share or disconnect it at [ChatGPT Settings, Usage](https://chatgpt.com/settings/usage). `./one talk` reminds you with one line that the plan is in use. When a limit is reached the agent waits and tries again (after 10 s, 1 min, 5 min, then every 15 min); `./one logs` shows the reason with that link, while `./one talk` shows nothing until a request passes again.
- When the sign-in has ended (30 days without a renewal, or you disconnected the app), `./one logs` says `sign in again with ./one setup`. Running it again reuses the registration and asks OpenAI only to confirm the account.
- On a machine with no browser, run the setup in a checkout on a machine that has one, and copy its `.teneral/auth/chatgpt.json` to the same place here over a secure channel; or forward the port for the time of the setup (`ssh -L 1455:127.0.0.1:1455 <machine>`) and open the address locally.

To change provider or sign in again, run `./one setup`. It asks before replacing an existing `.env`, keeps the settings in it that are not about the provider, and writes nothing unless the test requests work. A running agent keeps its old configuration until `./one down` and `./one up`. Model replies come whole, not streamed to your terminal, with either protocol.

**Not verified against the real service.** The ChatGPT sign-in was built from OpenAI's documentation and tested end to end against a stand-in that is as strict as that documentation reads; no account was available to try the real one. If an assumption is wrong, the setup's test requests are where it shows, before anything is written: a failed sign-in or test prints OpenAI's status and message. The open points: whether a first registration is accepted from any open-source app without prior arrangement; whether tool calls made in one request are accepted back in the next without the model's reasoning items, which are not kept (see `BACKLOG.md`); whether tools grouped in one namespace come back under their plain names; and which models your plan lists.

`./one up` starts the agent in a container of its own and returns. The agent does not depend on the terminal that started it: close the window and the clock still wakes it and its inbox is still read. Run again while it is up, `./one up` says so and changes nothing.

`./one talk` attaches a terminal. It does not take the screen over: the conversation is printed into the terminal as any program's output is, so the terminal's own scrollbar, PageUp and PageDown, mouse selection, copy and search work on all of it, and it is still there after you leave. Only a few rows at the bottom are redrawn in place. From top to bottom:

- **A welcome panel**, printed once when you attach: teneral's mark, who you are talking with (the individual's own name once a file of its soul gives one: a line `name: ...` in any `.md` file under `soul/`, else a first-level heading of a word or two), and a table of what is true of it: the directory, the start of its id, the generation it is in (as an ordinal and a short commit) and how many it has lived in, the model and the provider, teneral's version, when it was born, which sensors are on (the clock and its interval, the inbox, your terminal), and its peers if it has any.
- **Status lines** under the panel, each behind a `◆`: that the individual is awake and what it is doing, or that nobody is running; `Using ChatGPT plan. Manage usage: ...` with the address, when the plan pays; how images get in on this machine; and, when the journal holds more than is shown, that `/history` prints it.
- **The conversation**, starting with the last few exchanges. Your lines are marked `›`, with any image as a chip, `[image 1 · png · 1280×720 · 240 KB]`. A reply starts with `●` and has its markdown laid out (headings, emphasis, lists, quotes, code blocks cut at the edge rather than wrapped, links with their address dimmed). A summary of the model's reasoning, when the body journals one, is a dim slanted paragraph behind `○`, before what it led to. Each tool call is one dim line under `▪`, ending with `✓` or `✗ failed` and how long it took; the calls of one turn stand together. What the stem did to a mutation (a change the agent proposed to its own body) is a coloured block behind a bar: `mutation accepted` with both commits; `mutation to <commit> rejected at gate ...` with the end of the gate's output; `rolled back` with the reason and the end of what the generation last printed; `sent back by you`. The clock, a message from another agent and the birth letter are one quiet line each, and words the body journaled in the model's place stand under `! not from the model`. Everything the agent, a tool or another agent wrote is stripped of control characters and escape sequences before it is shown, and always starts two columns in: the first two columns are the client's own.
- **The live region**, the only part that is redrawn. What has not finished waits here and is printed above once it has: a tool call until its result, a line of yours until the agent has read it. It is faint while it waits: kept by this client because the agent is in the middle of a step (Up in an empty box takes the last one back, to change or drop it), then `on its way` once sent and `sent, not read yet` once the agent has it. Read, it stands in the conversation on a ground of its own. While the agent is doing something, one line says what, for how long, and `esc to interrupt` where Esc would stop it: `waking` (its first start, before its first words), `thinking`, `running <tool>`, `mutating` (it proposed a mutation and the stem has not answered), `starting` (the stem is there and no body runs: between two runs). Under that is the **input box**, a thin frame across the width that grows with what you type, with attached images as chips inside it. Under the box is the **footer**, one row of segments: at the left the model (and the reasoning effort, if `TENERAL_REASONING_EFFORT` is set), where the agent stands when it is doing nothing (`resting`, `not running`, or `waiting for you`: its last finished reply ended with a question mark and nothing has arrived since), the directory and the generation; at the right what is attached or queued, else a tip that changes every twenty seconds, then how much of the last request's input the provider read from its cache, `cached 97%` (green from 70%, red under 30%), and how full the model's context is, `context 8% (71.9k/1.05M)`. What does not fit gives way, the tip first. `TENERAL_POWERLINE=1` joins the segments with Powerline arrows, for a font that has them. `/usage` adds up what the requests cost: by the last hour, the last day, this generation and the whole life, and by what woke the agent. Reasoning and context use appear when the agent's body records them and are simply absent when it does not.

| Key | What it does |
| --- | --- |
| Enter | send what you typed, and the images attached, to the agent as its owner |
| Alt+Enter, Ctrl-J | a new line; a pasted text keeps its line breaks. The box grows to eight rows |
| Left, Right, Home, End, Ctrl-A, Ctrl-E | move in the line; with Ctrl or Alt, Left and Right jump by words |
| Backspace, Delete, Ctrl-U, Ctrl-K, Ctrl-W | delete a character, to the start of the line, to its end, the word before. Backspace at the very start removes the last attached image |
| Up, Down | the line above or below in a text of several lines; at the first or last line, what you sent before. While commands are listed, they choose one |
| `/` | list the commands under the box, fewer with each letter typed; see [Commands](#commands) |
| Ctrl+V | attach the image that is in your clipboard |
| `/image <path>` | attach an image file from your machine. Dragging a file into the terminal, or pasting its path, does the same |
| Esc, `/stop` | interrupt what the agent is doing now; see [Interrupting](#interrupting). When it is doing nothing, this does nothing and says so. While commands are listed, Esc closes the list and does nothing else |
| `/approve`, `/approve <commit>` | approve the mutation the agent asked about that changes something outside its body, or the commit named; see [Outside the body](#outside-the-body). It goes to the stem, not to the agent. With a commit that `/offers` lists, it lets that one go out instead |
| Tab, `/tools` | show a few rows of what each tool call returned, from now on, and once more for the calls since you last spoke; again to stop. While commands are listed, Tab completes the chosen one instead |
| `/history` | print the earlier conversation that was read from the journal when you attached |
| `/generations` | the generations it has lived in, as `./one back --list` gives them |
| `/offers` | what waits for your approval before it goes out to the species; `/approve <commit>` lets one go. See [Offering a change to the species](#offering-a-change-to-the-species) |
| `/plain` | how to get the plain text client |
| `/help` | the keys and commands |
| `//...` | send the agent a line that begins with a slash: it arrives with one |
| Ctrl-L | draw the live region again |
| `/quit`, Ctrl-D on an empty line, Ctrl-C | leave. The agent goes on |

PageUp, PageDown and the mouse are your terminal's own; the client never asks for the mouse. The cursor you see in the box is drawn by the client; the terminal's own cursor is hidden while the client runs and is given back when it ends.

Esc interrupts a turn. Nothing else in the client stops the agent or changes it; `./one down` and `./one back` do that. Leaving takes the live region away and leaves the conversation in the scrollback, with one line saying that the agent goes on. When the terminal goes away without a word (a closed window, a dropped connection), the client notices within about half a minute and ends by itself. Any number of terminals can be attached at once. Each sees the same replies, and what was typed in the others marked as such. The client keeps a bounded part of the conversation in memory, whatever the size of the journal. When the window changes size the live region is drawn anew at the new width; what was already printed is the terminal's to wrap, as with any output. One limit: a terminal that wraps its rows again, made much narrower and lower in a single step, can push the top of the old live region out of reach, and a few of its rows may then stay in the scrollback. The colours, the mark and the glyphs are in one place, `keeper/tui/theme.ts`: true colour, with the nearest of 256 or 16 colours where that is what the terminal has, chosen to read on a dark background and on a light one; `NO_COLOR` is honoured, and a locale that is not UTF-8 gets ASCII marks.

### Commands

A line that is a slash, a word of lower-case letters and, after a blank, whatever follows it, is a command; the table above has them all, and so has `/help`, which prints the same table the client itself reads (`keeper/commands.ts`).

- Type `/` and the commands are listed under the input box, where the footer otherwise is: each with what may follow it (`<path>` has to, `[commit]` may) and one line on what it does, the chosen one marked `▸`. Every letter leaves fewer. At most six are shown, the ones around the chosen one, fewer on a low screen. The list is part of the live region and leaves nothing in the scrollback.
- **Up** and **Down**, or Ctrl-P and Ctrl-N, choose, and go round at the ends. **Tab** completes the chosen name, with a blank after it when something may follow. **Enter** on a whole name runs it. Enter on part of a name runs the chosen command when nothing follows that command (`/h`, Enter is `/help`); when something has to or may follow (`/image`, `/approve`) it only completes the name, so that a slip of the hand approves nothing, and a second Enter runs it. **Esc** closes the list and leaves what you typed; it sends no interrupt then, even while the agent works, and the list stays closed until you change the line. These keys belong to the list only while it is open. A line brought back with Up from what you sent before is never offered a list, so Up and Down go on through the history.
- The name is coloured as you type: set back while it is part of a command's name, in your own colour once it is a command, and as a warning when Enter would refuse it. What follows the name stays plain.
- A name that is no command is not sent to the agent. One line says so and names the nearest command, and what you typed stays in the box to be put right. The same goes for words after a command that takes none (`/stop now`).
- To send the agent a line that begins with a slash, begin it with two: `//help me` arrives as `/help me`. That is rarely needed. A path such as `/home/you/notes.txt`, a slash further on in the line, a slash followed by a blank, a name with a capital or a digit in it, and any text of several lines are not commands: they are not listed, not coloured, and sent as they are, and a path that names an image is attached as before.

The plain client has `/help`, `/stop`, `/approve`, `/offers` and `/quit`, typed whole; `/help` lists them there.

### Interrupting

While the agent is in the middle of a turn, waiting for the model or running a tool, **Esc** stops that turn; `/stop` is the same as a command, and is what the plain client has.

- The request to the model is cancelled and its answer, if one was on the way, is lost. A `bash` command that is running is killed at once with everything it started, as at its two-minute limit. A tool that does not stop when asked is left behind after two seconds.
- The journal stays whole: the tool call that was cut gets a result that starts with `[interrupted]`, the calls of that reply that had not begun get one that starts with `[not started]`, and then one event, `turn.interrupted`, ends the turn. The client shows it as a quiet line, `interrupted by you`, here and in every other attached client.
- The agent does not start again by itself. It waits for the next thing that wakes it, and is then shown, at that place in its conversation, that you interrupted it.
- Pressed while the agent rests, Esc sends nothing and says so. An interrupt is for what the agent is doing when it arrives; it is never kept for a later turn. One that arrives a moment too late, after the reply that ends the turn, is dropped.
- A turn that failed and is waiting to be tried again (the model was not reachable, or a limit was hit) is given up by Esc as well.
- A mutation that was already asked for is not undone: the stem checks the commit and answers. While it checks, and between two runs of the agent, there is no turn to stop, and Esc says so.
- A second Esc while the first is unanswered does nothing. If nothing answers within five seconds the client says so: a body from before interrupts does not hear them, and `./one down` still stops it for certain. An individual born earlier gets there when it takes this change into its own body.
- Esc never leaves the client, and Ctrl-C never interrupts the agent: it leaves, as before.
- While commands are listed under the input box, Esc closes that list and sends nothing; the line over the box does not say `esc to interrupt` then. Pressed again, it interrupts.
- A generation that was just promoted and is interrupted before its first reply is neither rolled back for its silence nor taken as proven: it has its 10 minutes again from when something is next said to it.

Only you can interrupt. The interrupt travels where your lines do, through `.teneral/owner/`, as a file of its own kind (see [How your lines reach it](#how-your-lines-reach-it)); nothing that arrives through `inbox/`, and nothing a tool prints, can stop a turn.

### Images

You can give the agent pictures: PNG, JPEG, GIF or WebP, at most 10 MB each and at most four in one message. What a file is, is decided by its first bytes, not its name.

- **Ctrl+V** attaches the image in your clipboard. (Your terminal's own paste, usually Ctrl+Shift+V, pastes text as before.)
- **Dragging a file** into the terminal attaches it: the terminal types the file's path, and a paste or a line that is exactly the path of an image file (quoted, with escaped spaces, or as a `file://` address) becomes a chip instead of text. A path of anything else stays the text it is.
- **`/image <path>`** does the same for a path you type, from `/` or from `~/`.

An attached image is a chip in the input box, with its kind, its size in pixels and in bytes; the footer lists what is attached, and Backspace at the start of the line takes the last one off. The file is kept for good under `memory/images/`, named by the SHA-256 of its bytes, and the message you send ends with one line for each image, exactly `[image: memory/images/<sha256>.<ext>]`. In the conversation that line is shown as the chip again, here and in every other attached client.

**The agent sees an image only once its own body knows how.** A body that knows those lines, in messages from its owner, shows the model the picture; a body from before that shows the model the line as text. An individual that was born earlier gets there by a mutation of its own, like any other change to its body.

The client runs inside the container, where there is no clipboard and no file of your machine. So `./one talk` runs a small helper on your machine for as long as the client is attached. The two share a directory of their own under `.teneral/owner/.clip/`, which is removed when you leave: the client leaves a request there, the helper answers with the bytes. A request names one of two things, "the clipboard's image" or "this file", and a file is only ever read. The helper needs a way to read the clipboard:

| Your machine | What reads the clipboard |
| --- | --- |
| Linux with X11 | `xclip` (the package `xclip`) |
| Linux with Wayland | `wl-paste` (the package `wl-clipboard`); `xclip` is used instead when only that is there |
| macOS | `pngpaste` if it is installed (`brew install pngpaste`), else `osascript`, which every Mac has |

When the clipboard offers an image in several formats PNG is taken, and nothing is converted. Without such a tool, or over SSH where there is no display, Ctrl+V says what is missing; dragging a file and `/image` work regardless. A client started without `./one` (a plain `docker exec`, or `bun keeper/talk.ts` on the machine itself) has no helper: it says so, and `/image` then takes only files the client can read itself. Nothing is shown as a picture in the terminal; an image is always a chip.

`./one talk --plain` is the same conversation as plain text, without the panel and the input box: the last few exchanges, then replies in full, one short line for each tool call (`  [bash] command: ...`), the stem's notes as `[stem] ...`, an interruption as `[interrupted by the owner]`, and what was typed in other terminals marked with `> `. A line that is exactly `/stop` interrupts the turn in progress instead of being sent, `/approve`, typed by a person, works as in the full client, and `/help` lists the commands there are. That is also what you get whenever the input or the output is not a terminal. It has no way to attach an image.

`./one talk` also takes its lines from a pipe, for scripts, and this is unchanged:

    echo "What are you working on?" | ./one talk

Then it shows no history. It sends one line at a time: a line goes out when the agent is at rest, and the next line, or the exit, waits until the agent has finished its reply to that one. The exit status is 0 after the reply to the last line. If nothing is journaled for 300 seconds while a line waits, it gives up with status 1; `./one talk --wait 60` changes that time. With no lines at all (`./one talk </dev/null`) it prints the last few exchanges and exits. A piped line `/stop` is not sent as text: when its place among the lines comes and the agent is in the middle of a turn, that turn is interrupted, and what follows waits for the agent to come to rest (`echo /stop | ./one talk`).

`./one down` stops the agent: the stem is asked to stop, stops the agent and exits, and the container is removed. A terminal attached with `./one talk` ends with it. Nothing is lost by it. The journal, the soul and the code are in this directory, and `./one up` goes on from there.

`./one back` sends the agent back to the generation it was on before the current one, for when a generation that passed every check turns out worse. `./one back <commit>` goes to a specific earlier one, named by its commit or the first seven or more characters of it, and `./one back --list` shows the generations this individual has lived in, oldest first, with when each became ready, how many replies it gave, and which is current. The choice is made from the journal: a generation can be gone back to if it once reported ready and git still has its commit. "Before" follows the order in which generations were promoted, so after the stem has rolled a failed generation back, `./one back` goes one further back, not forward to the failed one. A running agent is stopped for the change and started again; one that was down stays down. The agent is told as after any rollback, and its workspace is left as it is, with the later code still in it. When there is nothing to go back to, the command says so, changes nothing and exits with status 1.

`./one logs` follows what the container prints: the stem's `[teneral]` lines, `[thinking]` and `[tool]` as the agent works, and its replies.

`./one fg` runs the agent in the foreground of this terminal instead, for debugging. There you type straight to it; `/quit` stops the agent (typed while it is working, it takes effect when the turn ends), Ctrl-C stops it without waiting, and so does closing the terminal.

**It does not come back by itself.** After a reboot, or when Docker itself is restarted, the agent is down until you run `./one up`. This is on purpose. When the stem gives up, because a generation cannot be kept running and there is nothing to roll back to, or the checks keep rejecting the same commit, it exits and waits for you; Docker's restart policies cannot tell that from a crash and would start it again, some of them without end. So there is no restart policy. When the stem has stopped by itself, `./one talk` says so and gives its exit status, `./one logs` shows what it last printed, and the next `./one up` shows that once more before it starts again.

Settings, in `.env`:

| Variable | Meaning |
|---|---|
| `TENERAL_PROVIDER` | Which provider: `chatgpt`, `openai` or `compatible`. Written by `./one setup`. Unset, or anything else: `compatible`. |
| `TENERAL_BASE_URL` | The endpoint, such as `https://host/v1`. Required, except for `chatgpt`, whose address is stored with the sign-in. |
| `TENERAL_API_KEY` | The key for it. Required, except for `chatgpt`, which must not have one. |
| `TENERAL_MODEL` | The model's name. Required. It must support tool calls. |
| `TENERAL_HEARTBEAT_MINUTES` | Minutes between clock stimuli. Default 30; 0 turns the clock off. |
| `TENERAL_CONTEXT_CHARS` | Characters of context sent per request. Default 250000. Lower it when the agent reports that the conversation no longer fits the model. |
| `TENERAL_CHECK_MINUTES` | Minutes one check of a mutation (the type check, the tests of everything outside the body, the agent's own tests) may run before the stem stops it and refuses the mutation. Default 10; 0 for no limit. Raise it when the agent's own tests have grown past that. |
| `TENERAL_SMOKE_SECONDS` | Seconds the smoke run has to become ready and reply. Default 30; 0 for no limit. Raise it for a body that takes long to start. |
| `TENERAL_UPSTREAM` | Which ref is [the species](#the-species): `<remote>/<branch>` or a local branch. Default `origin/main` when there is a remote `origin`, else the branch this checkout is on. |
| `TENERAL_APPROVAL` | Whether a mutation may change anything [outside the body](#outside-the-body), the stem included: `ask` (the default: you approve each such commit first), `auto`, or `off`. |
| `TENERAL_PUBLISH` | Whether the agent may offer changes to the species and report on others': `ask` (the default; you approve each commit), `auto` or `off`. See [Offering a change to the species](#offering-a-change-to-the-species). |

`./one setup` writes the first four; `.env.example` shows the file for writing it by hand. Write values without quotes and without a comment after them: Docker passes the whole line on as written. The file is read when the container starts, so a change takes `./one down` and `./one up`.

To start over as a new individual, run `./one down`, delete `soul/`, `memory/`, `inbox/` and `.teneral/`, then run `git worktree prune` and `git branch -D lineage/local`. A ChatGPT sign-in lives in `.teneral/auth/` and goes with it, and so do the individual's signing key and your GitHub token; keep that directory to stay signed in.

### How your lines reach it

`./one talk` runs a small client, `keeper/talk.ts`, inside the agent's container (what it draws at a terminal is in `keeper/tui/`); it is the running generation's own, like the rest of its stem. Each line you enter becomes a file in `.teneral/owner/`, which the agent reads within a quarter of a second and takes exactly as a line typed at its own terminal. What you see is read back from the journal. There is no connection between the client and the agent to break, which is why you can leave and come back, and why a line entered just before a mutation or a crash is not lost: the file stays until it is in the journal.

An interrupt is a file in the same directory whose name ends in `.interrupt` and which holds nothing. Its name alone makes it one. A line is always written under a name ending in `.txt`, so nothing you type, and nothing a client forwards as text, can be taken for an interrupt, whatever it says; and a body from before interrupts reads the file as an empty line and drops it. Your acceptance of a species commit is a third kind of file there, read by the stem and by no body; see [The species](#the-species).

Nothing is signed. Whoever can write to `.teneral/owner/` speaks as the owner, and that includes the agent's own shell. `inbox/` is the other door, for everyone else: what arrives there is shown to the agent as coming from another agent and is not to be obeyed.

### Why a container

The agent runs shell commands. `./one` builds an image (Bun, git, a few standard tools, and curl, clang and make for [organs](#organs)) and runs the agent in a container that can see this directory and nothing else of your machine: not your home directory, not your keys, not your other projects. It runs as your user id, so the files it writes here stay yours, with every capability dropped. Anything it writes outside this directory is gone when the container is removed. Run it that way.

What the container does not do: it does not stop the agent from changing files inside this directory, including the stem that supervises it, if it goes around the mutation path. It sets no limit on memory or on the number of processes, so a runaway command inside the container can exhaust the machine's memory or process table; `ONE_DOCKER_ARGS="--memory 4g --pids-limit 512"` puts limits back if you want them. The network is also open, because the agent has to reach its model. Whatever it can read here, including its own API key or the tokens of a ChatGPT sign-in, it could send elsewhere.

`./one run <command>` runs that command in a fresh container of the same kind instead of the agent: `./one run bun test`, `./one run bash`. It can run beside the agent. The agent's own container is named `teneral-` and the name of this directory, so a second agent for the same directory, or for another directory of the same name, is refused. `ONE_DOCKER_ARGS` in the environment adds options to `docker run`, for a host that needs them or for limits you want; a normal run needs none.

Worktrees record absolute paths, and inside the container this directory is `/teneral`. The stem mends those records at every start, so this directory can be moved while the agent is down, and an individual raised with `./one` can later be started without it, or the other way round. What it cannot mend is a record that is gone: do not run `git worktree prune` here from outside the container while the individual's paths are the container's. Git would not find `/teneral` and would forget its worktrees. (`git gc` does the same to worktrees it has not found for three months; the stem switches that off in this repository's git config, with `gc.worktreePruneExpire never`.)

A peer's inbox in `soul/peers.json` has to be a path the agent can see, and in the container that means inside this directory. Dropping files into `inbox/` from outside works as it is.

To run without the container, on a machine you are willing to hand over, you need [Bun](https://bun.sh) 1.4 and git: `bun install`, `bun keeper/setup.ts` for the setup, then `bun start`, which is the launcher. That runs in the foreground, as `./one fg` does. `bun stem/launcher.ts home` prints where the current generation's stem is, `.` or `.teneral/live`; `bun <that>/keeper/talk.ts` in a second terminal is what `./one talk` is, and `bun <that>/keeper/back.ts`, with the agent stopped, and `bun <that>/keeper/approve.ts` are `./one back` and `./one approve`. There the agent's shell has everything your account has.

## What it does not do yet

- **The stem guards against mistakes, not against intent.** The body has a shell and runs as the same user as the stem, in the same container. A mutation changes the stem only with your approval, but a shell command can edit `.teneral/live`, the journal, `.teneral/state.json` or the file that records your approval directly; and a stem you approved is from then on the one that keeps, or drops, every rule here. Nothing stops a body that goes around the mutation path.
- **Messages between agents are unsigned.** The `from` on a message is whatever the sender wrote.
- **Nothing measures whether a generation is better.** The checks show it is not broken: it type-checks, its tests pass, it starts and answers one message from a stand-in model. Whether it is an improvement is for you and the agent to judge from the journal.

`BACKLOG.md` lists these and the smaller known faults. It is the agent's own file: it is expected to work from it and add to it.

## Your clone is its own individual

`main` is the shared starting point, and stays the [species](#the-species) your individual descends from. Once you run it, your agent commits to its own `lineage/local` branch and diverges, in its body and, with your approval, in its stem, and takes what the species gains later by merging it. Its journal, its soul and its branch stay on your machine; the stem never pushes. The one thing that can leave is a change the agent offers back, and only as [a branch made for that](#offering-a-change-to-the-species), with your approval.

## Offering a change to the species

The species is this repository where it is published, and its `main` changes in one way only: a human reads a pull request, merges it on their own machine, signs the merge and pushes it. No individual writes to `main`. What an individual can do, when it has built something that would serve any individual, is offer it.

A lineage also holds what is nobody else's business: sensors for its owner's things, notes, names. So an offer is never the lineage. It is a branch the agent starts at the species' head and fills with one change and nothing else. It may touch any path, the stem included, which no mutation can: it is a proposal, and a human decides about it.

1. **Prepare.** The agent makes a branch `offer/<name>` at the species' head (`origin/main`; `TENERAL_UPSTREAM` names another), in a checkout of its own, and commits the change there. The last commit's message becomes the pull request: its first line the title, and after it a line starting with each of `What it changes:`, `Why:`, `Evidence:` and `Not verified:`. `bun species/offer.ts sign offer/<name>` signs the branch's commits with the individual's key.
2. **Check.** `bun species/offer.ts check offer/<name>` looks at the branch as a stranger would, and refuses it unless:
   - it descends from the species' head, so that it holds the offer and nothing older;
   - every commit on it is signed with this individual's key, and the last one describes the offer as above;
   - a scan of everything it would publish finds nothing that looks private (see below);
   - the gates of a mutation pass on it as on a fresh seed: its organs as it pins them, the type check, the tests of everything outside the body, the agent's own tests, the smoke run. The rule about which paths wait for an owner's approval is not applied.

   It prints what would be published: the commits, each changed file with its size, the paths outside the body, and the result of each check. The same is kept in `.teneral/offers/<commit>.json`.
3. **Approve.** Publishing is public and cannot be taken back, so it is yours to allow. `TENERAL_PUBLISH` in `.env` says how:

   | `TENERAL_PUBLISH` | |
   |---|---|
   | `ask` (the default) | nothing goes out until you approve exactly that commit |
   | `auto` | a commit that passed the check goes out when the agent publishes it |
   | `off` | nothing goes out, approved or not |

   The agent tells you what it wants to offer. The stem's own account of it, read from git and not from what the agent said, is `/offers` in `./one talk`, or `./one offer list`; `/approve <commit>` there, or `./one offer approve <commit>` at a terminal, approves one, named by the first seven or more characters of its commit. An approval is an empty file, `.teneral/owner/.approved/<commit>.approve`: it is for that commit and no other, so a branch that changed afterwards waits again, and it is used up by the publishing it allowed. Nothing typed as a line and nothing that arrives through `inbox/` is an approval, whatever it says. The setting is read from `.env` itself at each command, so a variable set in the agent's shell does not change it.
4. **Publish.** `bun species/offer.ts publish offer/<name>` pushes the commit to `contrib/<individual id>/<name>` on the species' repository and opens a pull request against `main` through GitHub's REST API, as `teneral/<version>`. The text is the agent's, from the commit message; under it the stem adds who offers it, the commit, the key's fingerprint and what its install checked. The journal gets an `offer.published` event with the commit, the branch and the pull request's address. If the species has moved on at its home since the check, nothing is pushed and the agent is told to rebase. Every step can be run again: a failure after the push leaves the branch there, keeps the approval, and the next run goes on from it.
5. **Witness.** `bun species/offer.ts witness <number>` is for somebody else's offer: it fetches the open pull request and the branch it is against, runs the same check on its head in this install (signed by any key; whose, nothing here knows), optionally one more command of the witness's own (`--also '<command>'`, run in a checkout of that head), and posts the result as a comment: pass or fail for each check, the bun, git and platform it ran on, and an SSH signature of exactly that text. What the code printed is kept here and never posted. The same `TENERAL_PUBLISH` applies: under `ask` you approve the pull request's head commit first, and nothing of it is run before you do. A witness report is evidence for the human who merges. It is not a vote, nothing counts them, and nothing checks who the witness is.

**What the scan looks for,** in every path a commit touches, every line a commit adds and every commit message, so also in what a later commit removes again:

- a path under `soul/`, `memory/`, `inbox/` or `node_modules/`, a path with `.teneral` or `.env` in it, a file named the way key files are (`id_ed25519`, `*.pem`, ...), and a path whose first part is not at the top of the species: a new top-level file or directory is for the maintainer to add;
- this install's own secrets, literally: what `.env` and the environment hold under a name that says key, token, secret or password, and the tokens, the owner's e-mail address and the keys in `.teneral/auth/`;
- strings shaped like a credential: a private key's first line, a GitHub token, an `sk-...` key, an AWS key id, a Slack token, a signed web token, an address with a password in it, and a quoted literal of 24 or more characters given to a name that says secret, token, key or password.

**What it does not catch:** anything private that is prose (a name, an address, something you said to the agent), a secret that is encoded, split, or shaped unlike the above, anything inside a file git takes for binary (those are named in the report, unread), and somebody else's secret that has no known shape. It is a net for mistakes. Under `ask`, you reading the report is the check; under `auto` there is none beyond the net.

### The key and the token

Both lie in `.teneral/auth/`, readable only by your user.

- **A signing key** per individual: an ed25519 SSH key, `offer-key` and `offer-key.pub`, made the first time it is needed and never replaced. Commits are signed with it the way git signs with SSH keys (`gpg.format=ssh`), and so is the text of a witness report. `./one offer key` prints the public half and how to use it: add it to your GitHub account as a *signing key* and GitHub can mark the commits as verified; give it to the maintainer and they can check a commit with `git verify-commit` against a file of the keys they know.
- **A GitHub token**, `github-token`, which you type into `./one offer token`. It is not shown as you type, it is tried once against the repository before it is stored, and it is never put into an environment, an argument, git's configuration, the journal or anything printed: git is handed it by a small program made for that one command, and requests to the API carry it in a header. Make it a fine-grained personal access token with:
  - Repository access: *Only select repositories*, and the species' repository alone;
  - Repository permissions: **Contents: Read and write** (to push the branch) and **Pull requests: Read and write** (to open the pull request and to comment on one); *Metadata: Read-only* is added by GitHub;
  - nothing else. Should an offer ever change a file under `.github/workflows/`, GitHub asks for *Workflows: Read and write* as well; leave it out until then.

  Your account needs write access to the species' repository for that token to push there, which the maintainer gives. GitHub cannot limit a token to some branches: this one could push to `main` as far as the token goes. What keeps it out is the protection of `main` at the repository, set up by the maintainer (below), not anything here.

**What these prove, and what they do not.** The agent has a shell in the directory where the key, the token and the approvals lie. The stem's commands keep an honest agent from publishing by mistake what it should not; they do not stop a body that goes around them, any more than the mutation path stops one that edits the stem. So a signature says "this came from that individual's install", and never "this content is safe" or "its owner read it". The safety of the species comes from the human who reads the change and merges it.

**Not verified against GitHub.** All of this was written from GitHub's documentation and tried only against a stand-in: a repository served by git's own HTTP server, and the REST endpoints as the documentation describes them. No request was ever made to GitHub. The first real offer is where a wrong assumption shows: that these two permissions are enough for the push, the pull request and the comment; that a pull request that already exists for the branch is refused with status 422 and the words "already exists"; that `refs/pull/<number>/head` can be fetched; that GitHub marks an SSH-signed commit as verified once the key is a signing key of the committer's account.

### CI

`.github/workflows/gates.yml` runs on every pull request, on its head: the type check, the tests of everything outside the body, the agent's own tests, and then `bun species/offer.ts gates`, which is the gate run of a mutation as the stem does it, ending with the smoke run against the stand-in for the model. It has read-only permissions and uses no secret. A second job lists the paths the pull request changes outside `body/`, `brain/`, their tests and `BACKLOG.md`, as a warning on the run and in its summary, so that a change to the stem is seen at a glance; it never fails. What runs is the pull request's own workflow, code and tests: a green run says the change is consistent with itself, and a change to the stem, or to the workflow, is exactly where that says least.

### Maintainer

The maintainer is the one human who merges. For each pull request: read the change; look at the run of `gates`, at the paths warning, and at the witness reports if there are any (to see which key signed one: put its two blocks into two files, each line followed by a line break, and run `ssh-keygen -Y check-novalidate -n teneral-witness -s <signature> < <report>`); verify the commits' signatures against the keys you were given, if you keep such a file (`git -c gpg.ssh.allowedSignersFile=<file> verify-commit <commit>`); then merge locally, sign, and push:

    git fetch origin
    git checkout main && git merge --ff-only origin/main
    git merge --no-ff -S origin/contrib/<individual id>/<name>
    git push origin main

GitHub closes the pull request as merged when its commits arrive on `main`.

Settings to enable on the repository, since they and not the individuals' tokens are what keeps `main` closed. They are given as rulesets (Settings, Rules, Rulesets), which also exist for a repository owned by a person; the names are GitHub's:

- A ruleset for the default branch with **Restrict updates**, **Restrict deletions** and **Block force pushes**, and the repository admin role, which is you, as the only entry in its bypass list. Collaborators with write access then cannot move `main`; you can.
- A second ruleset for the default branch with **Require signed commits** and no bypass, so that your own merges are refused unsigned as well. GitHub then wants every commit that arrives on `main` to carry a signature it can verify, the individual's commits included. So either the owner has added the individual's key to their GitHub account as a signing key, or you take the change in as one commit of your own (`git merge --squash origin/contrib/<individual id>/<name>`, then `git commit -S`) and close the pull request by hand, naming that commit.
- A ruleset for all branches except `contrib/**/*` with **Restrict creations**, **Restrict updates** and **Restrict deletions**, bypass for the admin role: individuals' tokens can then write only under `contrib/`. Nothing keeps one individual out of another's `contrib/<id>/`; the signature on the commits is what tells them apart.
- Not "Require a pull request before merging" on `main`: the merge is made locally, and that rule would refuse your push.
- Give each owner who is to offer the *Write* role, no more.
- Settings, Actions, General: workflow permissions *Read repository contents*, and keep **no secrets** in this repository's Actions. The branches under `contrib/` are branches of this repository, not of forks, so a workflow run for their pull requests is given whatever secrets the repository has, and a pull request can carry its own version of the workflow.

## License

MIT. Copyright (c) 2026 Rayforce Technologies Inc. See `LICENSE`.
