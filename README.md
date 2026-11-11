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
   - in a fresh checkout the kernel makes of exactly that commit, the type check, the kernel's tests and the body's tests must pass. A test run counts only if it ends with bun's summary showing at least one test and no failures. The checks run without the agent's environment, so code under test does not see the API key.
4. If a check fails, the same generation starts again and is told which check and what it printed. If all pass, the kernel switches to the new commit and starts it.
5. A new generation has 60 seconds to report that it is ready. If it exits abnormally or is not ready in time, or later crashes three times in a row without producing a reply, or needs more than ten restarts in all, the kernel returns to the generation before it and tells the agent why. There is one step back, not a history: if that generation fails too, or there is none because this is the first, the kernel stops.

Around that: only a generation that became ready may molt, so the one kept for rollback is always one that started. A restart after a crash or a rejected molt waits a second longer for each one in a row. Three molts in a row that the checks reject, with no reply in between, stop the supervisor and leave it to you. A lock file keeps a second supervisor from running the same checkout, and a body left behind by a supervisor that was killed is stopped before a new one starts.

The agent is woken by sensors, not only by you typing: the terminal is one, a clock is another (every 30 minutes unless you change it), its inbox is a third, and it can build more.

## Birth

The first time you start it, the agent speaks first. Its journal is empty, so the first thing in it becomes the letter in `BIRTH.md`. The letter asks the agent to read its own code, tell you what it found, and ask who it should be for you: its name, what you want from it, how much initiative to take. Then it writes its soul, `soul/SOUL.md` and `soul/OWNER.md`, and from then on those files are part of every turn. They are the agent's own to revise, and they are never committed.

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
    ./box bun install
    ./box

Commit your changes before the first start: the kernel creates its worktrees from `HEAD`.

Type to talk. `/quit` stops the agent; typed while it is working, it takes effect when the turn ends. Ctrl-C stops it without waiting.

Settings, in `.env`:

| Variable | Meaning |
|---|---|
| `TENERAL_BASE_URL` | An OpenAI-compatible chat-completions endpoint, such as `https://host/v1`. Required. |
| `TENERAL_API_KEY` | The key for it. Required. |
| `TENERAL_MODEL` | The model's name. Required. It must support tool calls. |
| `TENERAL_HEARTBEAT_MINUTES` | Minutes between clock stimuli. Default 30; 0 turns the clock off. |
| `TENERAL_CONTEXT_CHARS` | Characters of context sent per request. Default 250000. |

Write values without quotes and without a comment after them: Docker passes the whole line on as written.

To start over as a new individual, delete `soul/`, `memory/`, `inbox/` and `.teneral/`, then run `git worktree prune` and `git branch -D lineage/local`.

### Why a container

The agent runs shell commands. `./box` builds a small image (Bun, git, a few standard tools) and runs the agent in a container that can see this directory and nothing else of your machine: not your home directory, not your keys, not your other projects. It runs as your user id, so the files it writes here stay yours, with every capability dropped, at most 512 processes and 4 GB of memory. Anything it writes outside this directory is gone when the container exits. Run it that way.

What the container does not do: it does not stop the agent from changing files inside this directory, including the kernel that supervises it, if it goes around the molt path. The network is also open, because the agent has to reach its model. Whatever it can read here, including its own API key, it could send elsewhere.

`./box <command>` runs that command in the same container instead of the agent: `./box bun test`, `./box bash`. Ctrl-C, `/quit` and `docker stop` all end the agent and remove the container.

An individual lives where it was born. Worktrees record absolute paths, and inside the container this directory is `/teneral`, so an agent first started with `./box` must always be started with `./box`. For the same reason, do not run `git worktree prune` here from outside the container while that individual exists: git would not find `/teneral` and would forget its worktrees.

A peer's inbox in `soul/peers.json` has to be a path the agent can see, and in the container that means inside this directory. Dropping files into `inbox/` from outside works as it is.

To run without the container, on a machine you are willing to hand over, you need [Bun](https://bun.sh) 1.4 and git: `bun install && bun start`. There the agent's shell has everything your account has.

## What it does not do yet

- **The kernel guards against mistakes, not against intent.** The body has a shell and runs as the same user as the kernel, in the same container. A molt cannot change the kernel, but a shell command can edit `kernel/`, the journal or `.teneral/state.json` directly. Nothing here stops a body that goes around the molt path.
- **Messages between agents are unsigned.** The `from` on a message is whatever the sender wrote.
- **Nothing measures whether a generation is better.** The checks show it is not broken: it type-checks, its tests pass, it starts. Whether it is an improvement is for you and the agent to judge from the journal.

`BACKLOG.md` lists these and the smaller known faults. It is the agent's own file: it is expected to work from it and add to it.

## Your clone is its own individual

`main` is the shared starting point. Once you run it, your agent commits to its own `lineage/local` branch and diverges. Its journal, its soul and its branch stay on your machine; the kernel never pushes.

## License

MIT. See `LICENSE`.
