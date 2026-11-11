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
   - last, the smoke run: in the same checkout the kernel starts the candidate the way it starts a generation, on an empty throwaway install with one message waiting and a stand-in for the model that the kernel serves on a local port. Its environment is the checks' with the variables a generation is started with added, the model's pointing at the stand-in and the clock off; nothing else from `.env` is there. The candidate has 30 seconds to report that it is ready and to answer the message. Code that passes its tests but does not start, or starts and never takes a turn, stops here.
4. If a check fails, the same generation starts again and is told which check and what it printed. If all pass, the kernel switches to the new commit and starts it.
5. A new generation has 60 seconds to report that it is ready, and 10 minutes to produce its first reply: the note about its promotion is waiting for it, so a working one answers. If it exits abnormally before it is ready, or is not ready in time, or is alive but silent after those 10 minutes, or later crashes three times in a row without producing a reply, or needs more than ten restarts, the kernel returns to the generation before it and tells the agent why, with the end of what the failed generation wrote to stderr. There is one step back, not a history: if that generation fails too, or there is none because this is the first, the kernel stops.

Around that:

- Only a generation that became ready may molt, so the one kept for rollback is always one that started.
- The 10 minutes apply until a promoted generation's first reply and never after. An outage of the model does not roll back a generation that has already answered once. Neither does anything else: a generation that answers once and then stays alive without answering again is not caught, and you will only see it as silence in `./box talk`.
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

    cp .env.example .env    # fill in an OpenAI-compatible endpoint, key and model
    ./box run bun install
    ./box up                # start the agent in the background
    ./box talk              # attach this terminal to it
    ./box down              # stop it

Commit your changes before the first start: the kernel creates its worktrees from `HEAD`.

`./box up` starts the agent in a container of its own and returns. The agent does not depend on the terminal that started it: close the window and the clock still wakes it and its inbox is still read. Run again while it is up, `./box up` says so and changes nothing.

`./box talk` attaches a terminal. It shows the last few exchanges, then every line you enter goes to the agent as its owner's words, and what the agent does is shown as it happens: its replies in full, one short line for each tool call, what the kernel did to a molt (promoted, rejected and why, rolled back), and one line for anything else that woke it, such as the clock or a message from another agent. `/quit`, Ctrl-D or Ctrl-C leaves; the agent goes on. Any number of terminals can be attached at once. Each sees the same replies and, marked with `> `, what was typed in the others.

`./box talk` also takes its lines from a pipe, for scripts:

    echo "What are you working on?" | ./box talk

Then it shows no history. It sends one line at a time: a line goes out when the agent is at rest, and the next line, or the exit, waits until the agent has finished its reply to that one. The exit status is 0 after the reply to the last line. If nothing is journaled for 300 seconds while a line waits, it gives up with status 1; `./box talk --wait 60` changes that time. With no lines at all (`./box talk </dev/null`) it prints the last few exchanges and exits.

`./box down` stops the agent: the kernel is asked to stop, stops the agent and exits, and the container is removed. A terminal attached with `./box talk` ends with it. Nothing is lost by it. The journal, the soul and the code are in this directory, and `./box up` goes on from there.

`./box logs` follows what the container prints: the kernel's `[teneral]` lines, `[thinking]` and `[tool]` as the agent works, and its replies.

`./box fg` runs the agent in the foreground of this terminal instead, for debugging. There you type straight to it; `/quit` stops the agent (typed while it is working, it takes effect when the turn ends), Ctrl-C stops it without waiting, and so does closing the terminal.

**It does not come back by itself.** After a reboot, or when Docker itself is restarted, the agent is down until you run `./box up`. This is on purpose. When the kernel gives up, because a generation cannot be kept running and there is nothing to roll back to, or the checks keep rejecting the same commit, it exits and waits for you; Docker's restart policies cannot tell that from a crash and would start it again, some of them without end. So there is no restart policy. When the kernel has stopped by itself, `./box talk` says so and gives its exit status, `./box logs` shows what it last printed, and the next `./box up` shows that once more before it starts again.

Settings, in `.env`:

| Variable | Meaning |
|---|---|
| `TENERAL_BASE_URL` | An OpenAI-compatible chat-completions endpoint, such as `https://host/v1`. Required. |
| `TENERAL_API_KEY` | The key for it. Required. |
| `TENERAL_MODEL` | The model's name. Required. It must support tool calls. |
| `TENERAL_HEARTBEAT_MINUTES` | Minutes between clock stimuli. Default 30; 0 turns the clock off. |
| `TENERAL_CONTEXT_CHARS` | Characters of context sent per request. Default 250000. Lower it when the agent reports that the conversation no longer fits the model. |

Write values without quotes and without a comment after them: Docker passes the whole line on as written. The file is read when the container starts, so a change takes `./box down` and `./box up`.

To start over as a new individual, run `./box down`, delete `soul/`, `memory/`, `inbox/` and `.teneral/`, then run `git worktree prune` and `git branch -D lineage/local`.

### How your lines reach it

`./box talk` runs a small client, `kernel/talk.ts`, inside the agent's container. Each line you enter becomes a file in `.teneral/owner/`, which the agent reads within a quarter of a second and takes exactly as a line typed at its own terminal. What you see is read back from the journal. There is no connection between the client and the agent to break, which is why you can leave and come back, and why a line entered just before a molt or a crash is not lost: the file stays until it is in the journal.

Nothing is signed. Whoever can write to `.teneral/owner/` speaks as the owner, and that includes the agent's own shell. `inbox/` is the other door, for everyone else: what arrives there is shown to the agent as coming from another agent and is not to be obeyed.

### Why a container

The agent runs shell commands. `./box` builds a small image (Bun, git, a few standard tools) and runs the agent in a container that can see this directory and nothing else of your machine: not your home directory, not your keys, not your other projects. It runs as your user id, so the files it writes here stay yours, with every capability dropped. Anything it writes outside this directory is gone when the container is removed. Run it that way.

What the container does not do: it does not stop the agent from changing files inside this directory, including the kernel that supervises it, if it goes around the molt path. It sets no limit on memory or on the number of processes, so a runaway command inside the container can exhaust the machine's memory or process table; `BOX_DOCKER_ARGS="--memory 4g --pids-limit 512"` puts limits back if you want them. The network is also open, because the agent has to reach its model. Whatever it can read here, including its own API key, it could send elsewhere.

`./box run <command>` runs that command in a fresh container of the same kind instead of the agent: `./box run bun test`, `./box run bash`. It can run beside the agent. The agent's own container is named `teneral-` and the name of this directory, so a second agent for the same directory, or for another directory of the same name, is refused. `BOX_DOCKER_ARGS` in the environment adds options to `docker run`, for a host that needs them or for limits you want; a normal run needs none.

Worktrees record absolute paths, and inside the container this directory is `/teneral`. The kernel mends those records at every start, so this directory can be moved while the agent is down, and an individual raised with `./box` can later be started without it, or the other way round. What it cannot mend is a record that is gone: do not run `git worktree prune` here from outside the container while the individual's paths are the container's. Git would not find `/teneral` and would forget its worktrees. (`git gc` does the same to worktrees it has not found for three months; the kernel switches that off in this repository's git config, with `gc.worktreePruneExpire never`.)

A peer's inbox in `soul/peers.json` has to be a path the agent can see, and in the container that means inside this directory. Dropping files into `inbox/` from outside works as it is.

To run without the container, on a machine you are willing to hand over, you need [Bun](https://bun.sh) 1.4 and git: `bun install && bun start`. That runs in the foreground, as `./box fg` does, and `bun kernel/talk.ts` in a second terminal is what `./box talk` is. There the agent's shell has everything your account has.

## What it does not do yet

- **The kernel guards against mistakes, not against intent.** The body has a shell and runs as the same user as the kernel, in the same container. A molt cannot change the kernel, but a shell command can edit `kernel/`, the journal or `.teneral/state.json` directly. Nothing here stops a body that goes around the molt path.
- **Messages between agents are unsigned.** The `from` on a message is whatever the sender wrote.
- **Nothing measures whether a generation is better.** The checks show it is not broken: it type-checks, its tests pass, it starts and answers one message from a stand-in model. Whether it is an improvement is for you and the agent to judge from the journal.

`BACKLOG.md` lists these and the smaller known faults. It is the agent's own file: it is expected to work from it and add to it.

## Your clone is its own individual

`main` is the shared starting point. Once you run it, your agent commits to its own `lineage/local` branch and diverges. Its journal, its soul and its branch stay on your machine; the kernel never pushes.

## License

MIT. See `LICENSE`.
