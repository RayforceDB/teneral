# teneral

A minimal agent that rewrites its own code, one measured generation at a time. The conversation outlives every version.

*Teneral* is what entomologists call an insect that has just molted: the new body is there, but it has not hardened yet. Here it is a generation of the agent's code that was just switched on and has not yet proven it works.

**Status: experiment.** The question is whether an agent can get better by rewriting its harness, and where that stops helping. Read [What it does not do yet](#what-it-does-not-do-yet) before trusting it with anything.

## How it works

Two halves in one repository, and three directories that belong to one individual and are never committed.

- `kernel/` is a small supervisor. It starts the agent, checks every new generation, and puts back the previous one when a new one fails. A molt cannot change it.
- `body/` is everything the agent may rewrite: how it calls the model, its tools, its sensors, how it builds its context. It is kept under 200,000 bytes so the agent can read all of itself.
- `memory/journal.jsonl` is the agent's history, append-only. Every event carries the commit of the code that wrote it, so generations can be compared.
- `soul/` holds a few Markdown files the agent writes about who it is and who it works with. They are part of every request to the model.
- `inbox/` is where other programs leave messages for it.

One commit of the agent's code is a *generation*. Asking the kernel to switch to a new one is a *molt*:

1. The agent edits a second checkout of this repository, `.teneral/candidate`, on the branch `lineage/local`. The code it is running is a third checkout, `.teneral/live`, which the kernel resets to the exact commit before every start.
2. The agent calls its `molt` tool. The tool commits the candidate, journals the request, and the process exits with code 75 when the turn ends.
3. The kernel checks the commit:
   - compared with the running generation, it may change only `body/`, `test/body/` and `BACKLOG.md`. This is an allowlist: every other path, including any new file, is refused;
   - `body/` may hold only regular files, and no more than 200,000 bytes of them;
   - in a fresh checkout the kernel makes of exactly that commit, the type check, the kernel's tests and the body's tests must pass. A test run counts only if it ends with bun's summary showing at least one passing test and no failures. The checks run with almost none of the kernel's environment (only `PATH`, `HOME`, `LANG` and `BUN_INSTALL` are passed on), so code under test does not see the API key, and with a temp directory of their own inside that checkout, which goes when the checkout does;
   - last, the smoke run: in the same checkout the kernel starts the candidate the way it starts a generation, on an empty throwaway install with one message waiting and a stand-in for the model that the kernel serves on a local port. The stand-in speaks both wire protocols, and the candidate is run as the provider you configured, with a dummy key: never with your key or your sign-in. Its environment is the checks' with the variables a generation is started with added, the model's pointing at the stand-in and the clock off; nothing else from `.env` is there. The candidate has 30 seconds to report that it is ready and to answer the message. Code that passes its tests but does not start, or starts and never takes a turn, stops here.
4. If a check fails, the same generation starts again and is told which check and what it printed. If all pass, the kernel switches to the new commit and starts it.
5. A new generation has 60 seconds to report that it is ready, and 10 minutes to produce its first reply: the note about its promotion is waiting for it, so a working one answers. If it exits abnormally before it is ready, or is not ready in time, or is alive but silent after those 10 minutes, or later crashes three times in a row without producing a reply, or needs more than ten restarts, the kernel returns to the generation before it and tells the agent why, with the end of what the failed generation wrote to stderr. There is one step back, not a history: if that generation fails too, or there is none because this is the first, the kernel stops.

Around that:

- Only a generation that became ready may molt, so the one kept for rollback is always one that started.
- The 10 minutes apply until a promoted generation's first reply and never after. An outage of the model does not roll back a generation that has already answered once. Neither does anything else: a generation that answers once and then stays alive without answering again is not caught, and you will only see it as silence in `./box talk`. `./box back` is for that.
- A restart after a crash waits a second longer for each crash in a row. The ten restarts are given back when a run lasted an hour before it failed.
- A rejected molt is followed by a wait as well. Asking for a different commit each time is ordinary work and is never limited. Asking for the same commit and having it rejected three times in a row stops the supervisor and leaves it to you.
- Every molt request gets an answer. If the kernel is stopped while the checks run (`./box down`, Ctrl-C in `./box fg`), the running check is killed and the kernel exits within a few seconds; at the next start the agent is told that nothing was decided and to ask again. The same happens when the agent's process dies between asking and exiting.
- A lock file keeps a second supervisor from running the same checkout, and a body left behind by a supervisor that was killed is stopped before a new one starts.

The agent is woken by sensors, not only by you typing: your lines are one, a clock is another (every 30 minutes unless you change it, and silent until the soul is written), its inbox is a third, and it can build more. It runs in the background, so the clock and the inbox reach it whether or not a terminal is open.

## Birth

The first time you start it, the agent speaks first. Its journal holds no message yet, so the first one in it becomes the letter in `BIRTH.md`. The letter asks the agent to read its own code, tell you what it found, and ask who it should be for you: its name, what you want from it, how much initiative to take. Then it writes its soul, `soul/SOUL.md` and `soul/OWNER.md`, and from then on those files are part of every turn. They are the agent's own to revise, and they are never committed.

If you want a different beginning, edit `BIRTH.md` and commit it before the first start.

## Talking to it from outside

Anything can reach the agent by putting a JSON file into `inbox/` (create the directory if it is not there yet): another teneral agent, a script, a bridge to a chat service. The format is in `kernel/envelope.ts`:

    {"v": 1, "id": "note-1", "from": "script", "to": "anyone", "replyTo": null, "ts": "2026-11-11T12:00:00Z", "hops": 0, "text": "hello"}

The file name must end in `.json`. Write it under another name and rename it, so it is never read half-written. The inbox is looked at every two seconds; a message that was taken in moves to `inbox/seen/`, a file that is not a valid envelope to `inbox/rejected/`.

To let the agent write to another one, list that agent's inbox in `soul/peers.json`:

    { "bob": "/path/to/other/teneral/inbox" }

Messages are not signed. The agent is told to treat them as untrusted and not to change its code or run commands because one asked, and an exchange of replies is cut off after four. The limit on replies is in the body's `send` tool and the rest is an instruction to the model; the kernel enforces neither.

## Run it

Requires Docker and git.

    ./box up                # start the agent in the background; the first time, it sets up a model provider first
    ./box talk              # attach this terminal to it
    ./box down              # stop it
    ./box back              # send it back to the generation before
    ./box setup             # choose another model provider, or sign in again

Commit your changes before the first start: the kernel creates its worktrees from `HEAD`.

The first `./box up` finds no `.env` and runs the setup: you choose a model provider, give it what it needs, and two test requests are made, one that must be answered in words and one that must come back as a tool call. Only when both work is `.env` written, and the agent starts. It also installs the project's two development dependencies once, which the checks on a molt need. From a script, with no terminal to ask at, `./box up` says what is missing and exits with status 1.

### Model providers

The setup offers what `kernel/providers.ts` lists:

1. **ChatGPT plan (Continue with ChatGPT).** The agent's requests use your ChatGPT Plus or Pro plan, through the sign-in OpenAI documents for open-source apps that run locally ([Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source)). No API key is involved.
2. **OpenAI API key.** Pay as you go, at `https://api.openai.com/v1`, over the Responses API.
3. **Another OpenAI-compatible endpoint.** Any chat-completions endpoint: you type its base URL, a key and a model that supports tool calls. This is what the project did before there was a choice, and what a `.env` without `TENERAL_PROVIDER` still means.

What the ChatGPT sign-in does:

- The setup prints an address at `auth.openai.com`. You open it in your own browser, sign in there and approve the app, which OpenAI shows under the name `teneral`; you never type a password into teneral. The address is for you alone.
- OpenAI sends your browser back to `http://127.0.0.1:1455/auth/callback`, where the setup is listening. For that, and only for the time of the sign-in, `./box setup` publishes port 1455 on this machine's loopback address. No other command opens a port. If 1455 is taken, `TENERAL_CALLBACK_PORT=<port> ./box setup` uses another.
- The tokens OpenAI issues are stored in `.teneral/auth/chatgpt.json`, readable only by your user. An access token lasts an hour and is renewed by itself; the sign-in as a whole lasts 30 days from its last renewal. `.env` holds no key for this provider.
- **The agent's own shell can read that file.** It runs as your user in a directory it can see all of. The agent is told the credentials are yours and to leave them alone, and its code keeps the token out of its environment, its journal and its workspace; nothing stops a command it runs from reading the file. The same has always been true of an API key in `.env`.
- What the agent uses counts against your plan. On Plus, the five-hour limit is one total shared with everything else that uses your plan. Review it, limit this app's share or disconnect it at [ChatGPT Settings, Usage](https://chatgpt.com/settings/usage). `./box talk` reminds you with one line that the plan is in use. When a limit is reached the agent waits and tries again (after 10 s, 1 min, 5 min, then every 15 min); `./box logs` shows the reason with that link, while `./box talk` shows nothing until a request passes again.
- When the sign-in has ended (30 days without a renewal, or you disconnected the app), `./box logs` says `sign in again with ./box setup`. Running it again reuses the registration and asks OpenAI only to confirm the account.
- On a machine with no browser, run the setup in a checkout on a machine that has one, and copy its `.teneral/auth/chatgpt.json` to the same place here over a secure channel; or forward the port for the time of the setup (`ssh -L 1455:127.0.0.1:1455 <machine>`) and open the address locally.

To change provider or sign in again, run `./box setup`. It asks before replacing an existing `.env`, keeps the settings in it that are not about the provider, and writes nothing unless the test requests work. A running agent keeps its old configuration until `./box down` and `./box up`. Model replies come whole, not streamed to your terminal, with either protocol.

**Not verified against the real service.** The ChatGPT sign-in was built from OpenAI's documentation and tested end to end against a stand-in that is as strict as that documentation reads; no account was available to try the real one. If an assumption is wrong, the setup's test requests are where it shows, before anything is written: a failed sign-in or test prints OpenAI's status and message. The open points: whether a first registration is accepted from any open-source app without prior arrangement; whether tool calls made in one request are accepted back in the next without the model's reasoning items, which are not kept (see `BACKLOG.md`); whether tools grouped in one namespace come back under their plain names; and which models your plan lists.

`./box up` starts the agent in a container of its own and returns. The agent does not depend on the terminal that started it: close the window and the clock still wakes it and its inbox is still read. Run again while it is up, `./box up` says so and changes nothing.

`./box talk` attaches a terminal. It shows the last few exchanges, then every line you enter goes to the agent as its owner's words, and what the agent does is shown as it happens: its replies in full, one short line for each tool call, what the kernel did to a molt (promoted, rejected and why, rolled back), and one line for anything else that woke it, such as the clock or a message from another agent. `/quit`, Ctrl-D or Ctrl-C leaves; the agent goes on. Any number of terminals can be attached at once. Each sees the same replies and, marked with `> `, what was typed in the others.

`./box talk` also takes its lines from a pipe, for scripts:

    echo "What are you working on?" | ./box talk

Then it shows no history. It sends one line at a time: a line goes out when the agent is at rest, and the next line, or the exit, waits until the agent has finished its reply to that one. The exit status is 0 after the reply to the last line. If nothing is journaled for 300 seconds while a line waits, it gives up with status 1; `./box talk --wait 60` changes that time. With no lines at all (`./box talk </dev/null`) it prints the last few exchanges and exits.

`./box down` stops the agent: the kernel is asked to stop, stops the agent and exits, and the container is removed. A terminal attached with `./box talk` ends with it. Nothing is lost by it. The journal, the soul and the code are in this directory, and `./box up` goes on from there.

`./box back` sends the agent back to the generation it was on before the current one, for when a generation that passed every check turns out worse. `./box back <commit>` goes to a specific earlier one, named by its commit or the first seven or more characters of it, and `./box back --list` shows the generations this individual has lived in, oldest first, with when each became ready, how many replies it gave, and which is current. The choice is made from the journal: a generation can be gone back to if it once reported ready and git still has its commit. "Before" follows the order in which generations were promoted, so after the kernel has rolled a failed generation back, `./box back` goes one further back, not forward to the failed one. A running agent is stopped for the change and started again; one that was down stays down. The agent is told as after any rollback, and its workspace is left as it is, with the later code still in it. When there is nothing to go back to, the command says so, changes nothing and exits with status 1.

`./box logs` follows what the container prints: the kernel's `[teneral]` lines, `[thinking]` and `[tool]` as the agent works, and its replies.

`./box fg` runs the agent in the foreground of this terminal instead, for debugging. There you type straight to it; `/quit` stops the agent (typed while it is working, it takes effect when the turn ends), Ctrl-C stops it without waiting, and so does closing the terminal.

**It does not come back by itself.** After a reboot, or when Docker itself is restarted, the agent is down until you run `./box up`. This is on purpose. When the kernel gives up, because a generation cannot be kept running and there is nothing to roll back to, or the checks keep rejecting the same commit, it exits and waits for you; Docker's restart policies cannot tell that from a crash and would start it again, some of them without end. So there is no restart policy. When the kernel has stopped by itself, `./box talk` says so and gives its exit status, `./box logs` shows what it last printed, and the next `./box up` shows that once more before it starts again.

Settings, in `.env`:

| Variable | Meaning |
|---|---|
| `TENERAL_PROVIDER` | Which provider: `chatgpt`, `openai` or `compatible`. Written by `./box setup`. Unset, or anything else: `compatible`. |
| `TENERAL_BASE_URL` | The endpoint, such as `https://host/v1`. Required, except for `chatgpt`, whose address is stored with the sign-in. |
| `TENERAL_API_KEY` | The key for it. Required, except for `chatgpt`, which must not have one. |
| `TENERAL_MODEL` | The model's name. Required. It must support tool calls. |
| `TENERAL_HEARTBEAT_MINUTES` | Minutes between clock stimuli. Default 30; 0 turns the clock off. |
| `TENERAL_CONTEXT_CHARS` | Characters of context sent per request. Default 250000. Lower it when the agent reports that the conversation no longer fits the model. |

`./box setup` writes the first four; `.env.example` shows the file for writing it by hand. Write values without quotes and without a comment after them: Docker passes the whole line on as written. The file is read when the container starts, so a change takes `./box down` and `./box up`.

To start over as a new individual, run `./box down`, delete `soul/`, `memory/`, `inbox/` and `.teneral/`, then run `git worktree prune` and `git branch -D lineage/local`. A ChatGPT sign-in lives in `.teneral/auth/` and goes with it; keep that directory to stay signed in.

### How your lines reach it

`./box talk` runs a small client, `kernel/talk.ts`, inside the agent's container. Each line you enter becomes a file in `.teneral/owner/`, which the agent reads within a quarter of a second and takes exactly as a line typed at its own terminal. What you see is read back from the journal. There is no connection between the client and the agent to break, which is why you can leave and come back, and why a line entered just before a molt or a crash is not lost: the file stays until it is in the journal.

Nothing is signed. Whoever can write to `.teneral/owner/` speaks as the owner, and that includes the agent's own shell. `inbox/` is the other door, for everyone else: what arrives there is shown to the agent as coming from another agent and is not to be obeyed.

### Why a container

The agent runs shell commands. `./box` builds a small image (Bun, git, a few standard tools) and runs the agent in a container that can see this directory and nothing else of your machine: not your home directory, not your keys, not your other projects. It runs as your user id, so the files it writes here stay yours, with every capability dropped. Anything it writes outside this directory is gone when the container is removed. Run it that way.

What the container does not do: it does not stop the agent from changing files inside this directory, including the kernel that supervises it, if it goes around the molt path. It sets no limit on memory or on the number of processes, so a runaway command inside the container can exhaust the machine's memory or process table; `BOX_DOCKER_ARGS="--memory 4g --pids-limit 512"` puts limits back if you want them. The network is also open, because the agent has to reach its model. Whatever it can read here, including its own API key or the tokens of a ChatGPT sign-in, it could send elsewhere.

`./box run <command>` runs that command in a fresh container of the same kind instead of the agent: `./box run bun test`, `./box run bash`. It can run beside the agent. The agent's own container is named `teneral-` and the name of this directory, so a second agent for the same directory, or for another directory of the same name, is refused. `BOX_DOCKER_ARGS` in the environment adds options to `docker run`, for a host that needs them or for limits you want; a normal run needs none.

Worktrees record absolute paths, and inside the container this directory is `/teneral`. The kernel mends those records at every start, so this directory can be moved while the agent is down, and an individual raised with `./box` can later be started without it, or the other way round. What it cannot mend is a record that is gone: do not run `git worktree prune` here from outside the container while the individual's paths are the container's. Git would not find `/teneral` and would forget its worktrees. (`git gc` does the same to worktrees it has not found for three months; the kernel switches that off in this repository's git config, with `gc.worktreePruneExpire never`.)

A peer's inbox in `soul/peers.json` has to be a path the agent can see, and in the container that means inside this directory. Dropping files into `inbox/` from outside works as it is.

To run without the container, on a machine you are willing to hand over, you need [Bun](https://bun.sh) 1.4 and git: `bun install`, `bun kernel/setup.ts` for the setup, then `bun start`. That runs in the foreground, as `./box fg` does, and `bun kernel/talk.ts` in a second terminal is what `./box talk` is; `bun kernel/back.ts`, with the agent stopped, is what `./box back` is. There the agent's shell has everything your account has.

## What it does not do yet

- **The kernel guards against mistakes, not against intent.** The body has a shell and runs as the same user as the kernel, in the same container. A molt cannot change the kernel, but a shell command can edit `kernel/`, the journal or `.teneral/state.json` directly. Nothing here stops a body that goes around the molt path.
- **Messages between agents are unsigned.** The `from` on a message is whatever the sender wrote.
- **Nothing measures whether a generation is better.** The checks show it is not broken: it type-checks, its tests pass, it starts and answers one message from a stand-in model. Whether it is an improvement is for you and the agent to judge from the journal.

`BACKLOG.md` lists these and the smaller known faults. It is the agent's own file: it is expected to work from it and add to it.

## Your clone is its own individual

`main` is the shared starting point. Once you run it, your agent commits to its own `lineage/local` branch and diverges. Its journal, its soul and its branch stay on your machine; the kernel never pushes.

## License

MIT. See `LICENSE`.
