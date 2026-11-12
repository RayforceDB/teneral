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
   - every organ the commit pins (see [Organs](#organs)) is in the cache with exactly the pinned hash, unpacks safely, and passes its own check. A body that pins none skips this;
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

## Organs

An organ is a native dependency the agent adopts for its body: a program or a library that somebody else publishes as release archives, such as a database to build its memory on. The agent chooses it, pins it, and later upgrades it by itself. The mechanism knows nothing about any particular one.

**The pin** is `body/organs.json`, a file of the body like any other, so it molts and rolls back with the code that uses it:

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
    .teneral/organs/trees/<sha256>/             the archive unpacked, by the kernel
    .teneral/organs/sets/<id>/<name>            one link per pinned organ, to its root

The agent downloads an archive itself, with its own tools. The kernel never reaches the network for one and does not take the agent's word either: it computes the hash of the cached file itself.

**The gate** `organs` runs after the size check and before anything of the candidate's is executed. For each pin of the candidate commit: the archive is in the cache and hashes to the pin (at most 256 MB); it is unpacked, unless that was done before, beside its place and renamed into it, so a tree that exists is a whole one; then the check runs, with the bare environment of every check. Unpacking refuses the whole archive for any entry that is not a plain file, a directory or a link that stays inside: a name that is absolute or climbs with `..`, a second entry for a name already written, a file that would be written through a link, a link pointing out, a device, a fifo; more than 1 GB unpacked or more than 20,000 entries. A refusal rejects the molt with a message that says what to do, for example `organ rayforce: it is not unpacked, and archive ea20… is not in the cache at …/archives/ea20….tar.gz; download https://… there first`.

**The body finds its organs** through `TENERAL_ORGANS`: a directory with one entry per organ, by name, so the example's program is `$TENERAL_ORGANS/rayforce/rayforce`. The variable is set for the candidate's tests and its smoke run, from the candidate's pins, and for every generation at its start, from the pins of that generation's own commit. It is not set for a body that pins nothing. The unpacked tree is shared by every generation that pins the same archive and is to be read, not written: what an organ stores belongs elsewhere.

**Rollback** needs nothing more. The generation before pins what it pinned, and that tree is still in the cache: the kernel never removes an archive or a tree, the current generation's, the previous one's or any other (so the cache only grows; see `BACKLOG.md`). At each start, a tree that is missing is unpacked again from its archive. When the archive is gone as well, the supervisor does not start the generation and does not roll it back: it stops and says which archive belongs at which path and where to download it, and `./box up` goes on from there once the file is back. A cache that was wiped is a fault of the install, not of the generation, and going a generation back would give up a sound one.

**An upgrade**, as the agent does it: download the new archive and the hash its publisher gives; verify one against the other; move the archive to `archives/<sha256>.tar.gz`; change the pin in the workspace; run `bun kernel/organs.ts` there, which does for the workspace's pins exactly what the gate will do and prints the directory to use as `TENERAL_ORGANS` for its own test run; then molt. If the new version turns out worse, the kernel's rollback or `./box back` returns to the old pin with the old code.

**Improving the dependency itself** does not go through the kernel. The image has `git`, `curl`, `clang` and `make`: the agent clones the dependency's source, builds and tests a patch locally, and proposes it upstream. Only a published release is pinned; when one holds the fix, it is installed as any upgrade. A locally built binary is for trying the patch, not for the body to depend on.

## Notes, and what the body keeps outside the journal

The journal has one event that is the body's own: `{ "type": "note", "kind": "...", "data": ... }`. The kernel stores it and never reads it; the talk clients do not show it, and it is neither a reply nor something that wakes the agent. `kind` is a short name the body chooses (`a-z`, `0-9`, `.`, `_`, `-`, at most 64 characters), `data` is anything that is JSON, at most 64 KB of it. A note that breaks this is refused when it is appended, with nothing written. The seed body writes none and passes them over when it builds a request.

It is there for one rule: **anything the body keeps outside the journal must be rebuildable from the journal, and lies in a place named by its schema version, so that a rolled-back body finds data it understands.** An index, a database, a summary are derived: the journal is the record, and what a store was built from must be in it, as the conversation itself or as notes. A body that changes the shape of its store writes to a new place (`memory/store-v2/`, not `memory/store/` in a new shape) and builds it from the journal; the old place stays as it was. After a rollback the older body opens the place it knows, finds it as it left it, and replays what the journal gained since. A store that is lost or damaged is a store to build again, never a loss.

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

The first `./box up` finds no `.env` and runs the setup: you choose a model provider, give it what it needs, and two test requests are made, one that must be answered in words and one that must come back as a tool call. Only when both work is `.env` written, and the agent starts. At a terminal the setup is a few full-screen pages: you choose with the arrow keys or a number, a key is typed unseen, the two tests show their progress, and the last page says what was written and where. `./box setup --plain` asks the same questions as lines of text. It also installs the project's two development dependencies once, which the checks on a molt need. From a script, with no terminal to ask at, `./box up` says what is missing and exits with status 1.

### Model providers

The setup offers what `kernel/providers.ts` lists:

1. **ChatGPT plan (Continue with ChatGPT).** The agent's requests use your ChatGPT Plus or Pro plan, through the sign-in OpenAI documents for open-source apps that run locally ([Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source)). No API key is involved.
2. **OpenAI API key.** Pay as you go, at `https://api.openai.com/v1`, over the Responses API.
3. **Another OpenAI-compatible endpoint.** Any chat-completions endpoint: you type its base URL, a key and a model that supports tool calls. This is what the project did before there was a choice, and what a `.env` without `TENERAL_PROVIDER` still means.

What the ChatGPT sign-in does:

- The setup shows an address at `auth.openai.com`, as one line that your terminal wraps, so that selecting it copies it whole; where the terminal supports links it can also be clicked. You open it in your own browser, sign in there and approve the app, which OpenAI shows under the name `teneral`; you never type a password into teneral. The address is for you alone. The setup waits until your browser comes back; Esc gives up.
- OpenAI sends your browser back to `http://127.0.0.1:1455/auth/callback`, where the setup is listening. For that, and only for the time of the sign-in, `./box setup` publishes port 1455 on this machine's loopback address. No other command opens a port. If 1455 is taken, `TENERAL_CALLBACK_PORT=<port> ./box setup` uses another.
- The tokens OpenAI issues are stored in `.teneral/auth/chatgpt.json`, readable only by your user. An access token lasts an hour and is renewed by itself; the sign-in as a whole lasts 30 days from its last renewal. `.env` holds no key for this provider.
- **The agent's own shell can read that file.** It runs as your user in a directory it can see all of. The agent is told the credentials are yours and to leave them alone, and its code keeps the token out of its environment, its journal and its workspace; nothing stops a command it runs from reading the file. The same has always been true of an API key in `.env`.
- What the agent uses counts against your plan. On Plus, the five-hour limit is one total shared with everything else that uses your plan. Review it, limit this app's share or disconnect it at [ChatGPT Settings, Usage](https://chatgpt.com/settings/usage). `./box talk` reminds you with one line that the plan is in use. When a limit is reached the agent waits and tries again (after 10 s, 1 min, 5 min, then every 15 min); `./box logs` shows the reason with that link, while `./box talk` shows nothing until a request passes again.
- When the sign-in has ended (30 days without a renewal, or you disconnected the app), `./box logs` says `sign in again with ./box setup`. Running it again reuses the registration and asks OpenAI only to confirm the account.
- On a machine with no browser, run the setup in a checkout on a machine that has one, and copy its `.teneral/auth/chatgpt.json` to the same place here over a secure channel; or forward the port for the time of the setup (`ssh -L 1455:127.0.0.1:1455 <machine>`) and open the address locally.

To change provider or sign in again, run `./box setup`. It asks before replacing an existing `.env`, keeps the settings in it that are not about the provider, and writes nothing unless the test requests work. A running agent keeps its old configuration until `./box down` and `./box up`. Model replies come whole, not streamed to your terminal, with either protocol.

**Not verified against the real service.** The ChatGPT sign-in was built from OpenAI's documentation and tested end to end against a stand-in that is as strict as that documentation reads; no account was available to try the real one. If an assumption is wrong, the setup's test requests are where it shows, before anything is written: a failed sign-in or test prints OpenAI's status and message. The open points: whether a first registration is accepted from any open-source app without prior arrangement; whether tool calls made in one request are accepted back in the next without the model's reasoning items, which are not kept (see `BACKLOG.md`); whether tools grouped in one namespace come back under their plain names; and which models your plan lists.

`./box up` starts the agent in a container of its own and returns. The agent does not depend on the terminal that started it: close the window and the clock still wakes it and its inbox is still read. Run again while it is up, `./box up` says so and changes nothing.

`./box talk` attaches a terminal. It does not take the screen over: the conversation is printed into the terminal as any program's output is, so the terminal's own scrollbar, PageUp and PageDown, mouse selection, copy and search work on all of it, and it is still there after you leave. Only a few rows at the bottom are redrawn in place. From top to bottom:

- **A welcome panel**, printed once when you attach: teneral's mark, who you are talking with (the individual's own name once a file of its soul gives one: a line `name: ...` in any `.md` file under `soul/`, else a first-level heading of a word or two), and a table of what is true of it: the directory, the start of its id, the generation it is in (as an ordinal and a short commit) and how many it has lived in, the model and the provider, teneral's version, when it was born, which sensors are on (the clock and its interval, the inbox, your terminal), and its peers if it has any.
- **Status lines** under the panel, each behind a `◆`: that the individual is awake and what it is doing, or that nobody is running; `Using ChatGPT plan. Manage usage: ...` with the address, when the plan pays; how images get in on this machine; and, when the journal holds more than is shown, that `/history` prints it.
- **The conversation**, starting with the last few exchanges. Your lines are marked `›`, with any image as a chip, `[image 1 · png · 1280×720 · 240 KB]`. A reply starts with `●` and has its markdown laid out (headings, emphasis, lists, quotes, code blocks cut at the edge rather than wrapped, links with their address dimmed). A summary of the model's reasoning, when the body journals one, is a dim slanted paragraph behind `○`, before what it led to. Each tool call is one dim line under `▪`, ending with `✓` or `✗ failed` and how long it took; the calls of one turn stand together. What the kernel did to a mutation (a change the agent proposed to its own body; the tool and the journal still call it a molt) is a coloured block behind a bar: `mutation accepted` with both commits; `mutation to <commit> rejected at gate ...` with the end of the gate's output; `rolled back` with the reason and the end of what the generation last printed; `sent back by you`. The clock, a message from another agent and the birth letter are one quiet line each, and words the body journaled in the model's place stand under `! not from the model`. Everything the agent, a tool or another agent wrote is stripped of control characters and escape sequences before it is shown, and always starts two columns in: the first two columns are the client's own.
- **The live region**, the only part that is redrawn. What has not finished waits here and is printed above once it has: a tool call until its result, a line of yours until the journal has it. While the agent is doing something, one line says what and for how long: `waking` (its first start, before its first words), `thinking`, `running <tool>`, `mutating` (it proposed a mutation and the kernel has not answered), `starting` (the kernel is there and no body runs: between two runs). Under that is the **input box**, a thin frame across the width that grows with what you type, with attached images as chips inside it. Under the box is the **footer**: at the left the model (and the reasoning effort, if `TENERAL_REASONING_EFFORT` is set), where the agent stands when it is doing nothing (`resting`, `not running`, or `waiting for you`: its last finished reply ended with a question mark and nothing has arrived since), the directory and the generation; at the right a tip that changes every twenty seconds, and under it how full the model's context is, `context 8% (71.9k/1.05M)`, once the body journals what its requests use. Reasoning and context use appear when the agent's body records them and are simply absent when it does not.

| Key | What it does |
| --- | --- |
| Enter | send what you typed, and the images attached, to the agent as its owner |
| Alt+Enter, Ctrl-J | a new line; a pasted text keeps its line breaks. The box grows to eight rows |
| Left, Right, Home, End, Ctrl-A, Ctrl-E | move in the line; with Ctrl or Alt, Left and Right jump by words |
| Backspace, Delete, Ctrl-U, Ctrl-K, Ctrl-W | delete a character, to the start of the line, to its end, the word before. Backspace at the very start removes the last attached image |
| Up, Down | the line above or below in a text of several lines; at the first or last line, what you sent before |
| Ctrl+V | attach the image that is in your clipboard |
| `/image <path>` | attach an image file from your machine. Dragging a file into the terminal, or pasting its path, does the same |
| Tab, `/tools` | show a few rows of what each tool call returned, from now on, and once more for the calls since you last spoke; again to stop |
| `/history` | print the earlier conversation that was read from the journal when you attached |
| `/generations` | the generations it has lived in, as `./box back --list` gives them |
| `/help` | the keys and commands |
| Ctrl-L | draw the live region again |
| `/quit`, Ctrl-D on an empty line, Ctrl-C | leave. The agent goes on |

PageUp, PageDown and the mouse are your terminal's own; the client never asks for the mouse. The cursor you see in the box is drawn by the client; the terminal's own cursor is hidden while the client runs and is given back when it ends.

Nothing in the client stops the agent or changes it; `./box down` and `./box back` do that. Leaving takes the live region away and leaves the conversation in the scrollback, with one line saying that the agent goes on. When the terminal goes away without a word (a closed window, a dropped connection), the client notices within about half a minute and ends by itself. Any number of terminals can be attached at once. Each sees the same replies, and what was typed in the others marked as such. The client keeps a bounded part of the conversation in memory, whatever the size of the journal. When the window changes size the live region is drawn anew at the new width; what was already printed is the terminal's to wrap, as with any output. One limit: a terminal that wraps its rows again, made much narrower and lower in a single step, can push the top of the old live region out of reach, and a few of its rows may then stay in the scrollback. The colours, the mark and the glyphs are in one place, `kernel/tui/theme.ts`: true colour, with the nearest of 256 or 16 colours where that is what the terminal has, chosen to read on a dark background and on a light one; `NO_COLOR` is honoured, and a locale that is not UTF-8 gets ASCII marks.

### Images

You can give the agent pictures: PNG, JPEG, GIF or WebP, at most 10 MB each and at most four in one message. What a file is, is decided by its first bytes, not its name.

- **Ctrl+V** attaches the image in your clipboard. (Your terminal's own paste, usually Ctrl+Shift+V, pastes text as before.)
- **Dragging a file** into the terminal attaches it: the terminal types the file's path, and a paste or a line that is exactly the path of an image file (quoted, with escaped spaces, or as a `file://` address) becomes a chip instead of text. A path of anything else stays the text it is.
- **`/image <path>`** does the same for a path you type, from `/` or from `~/`.

An attached image is a chip in the input box, with its kind, its size in pixels and in bytes; the footer lists what is attached, and Backspace at the start of the line takes the last one off. The file is kept for good under `memory/images/`, named by the SHA-256 of its bytes, and the message you send ends with one line for each image, exactly `[image: memory/images/<sha256>.<ext>]`. In the conversation that line is shown as the chip again, here and in every other attached client.

**The agent sees an image only once its own body knows how.** A body that knows those lines, in messages from its owner, shows the model the picture; a body from before that shows the model the line as text. An individual that was born earlier gets there by a mutation of its own, like any other change to its body.

The client runs inside the container, where there is no clipboard and no file of your machine. So `./box talk` runs a small helper on your machine for as long as the client is attached. The two share a directory of their own under `.teneral/owner/.clip/`, which is removed when you leave: the client leaves a request there, the helper answers with the bytes. A request names one of two things, "the clipboard's image" or "this file", and a file is only ever read. The helper needs a way to read the clipboard:

| Your machine | What reads the clipboard |
| --- | --- |
| Linux with X11 | `xclip` (the package `xclip`) |
| Linux with Wayland | `wl-paste` (the package `wl-clipboard`); `xclip` is used instead when only that is there |
| macOS | `pngpaste` if it is installed (`brew install pngpaste`), else `osascript`, which every Mac has |

When the clipboard offers an image in several formats PNG is taken, and nothing is converted. Without such a tool, or over SSH where there is no display, Ctrl+V says what is missing; dragging a file and `/image` work regardless. A client started without `./box` (a plain `docker exec`, or `bun kernel/talk.ts` on the machine itself) has no helper: it says so, and `/image` then takes only files the client can read itself. Nothing is shown as a picture in the terminal; an image is always a chip.

`./box talk --plain` is the same conversation as plain text, without the panel and the input box: the last few exchanges, then replies in full, one short line for each tool call (`  [bash] command: ...`), the kernel's notes as `[kernel] ...`, and what was typed in other terminals marked with `> `. That is also what you get whenever the input or the output is not a terminal. It has no way to attach an image.

`./box talk` also takes its lines from a pipe, for scripts, and this is unchanged:

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

`./box talk` runs a small client, `kernel/talk.ts`, inside the agent's container (what it draws at a terminal is in `kernel/tui/`). Each line you enter becomes a file in `.teneral/owner/`, which the agent reads within a quarter of a second and takes exactly as a line typed at its own terminal. What you see is read back from the journal. There is no connection between the client and the agent to break, which is why you can leave and come back, and why a line entered just before a molt or a crash is not lost: the file stays until it is in the journal.

Nothing is signed. Whoever can write to `.teneral/owner/` speaks as the owner, and that includes the agent's own shell. `inbox/` is the other door, for everyone else: what arrives there is shown to the agent as coming from another agent and is not to be obeyed.

### Why a container

The agent runs shell commands. `./box` builds an image (Bun, git, a few standard tools, and curl, clang and make for [organs](#organs)) and runs the agent in a container that can see this directory and nothing else of your machine: not your home directory, not your keys, not your other projects. It runs as your user id, so the files it writes here stay yours, with every capability dropped. Anything it writes outside this directory is gone when the container is removed. Run it that way.

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
