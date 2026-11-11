# Backlog

Each item: what is wrong, how to tell it got better. Add to this file before changing code.

## Next

1. **Cost report.** There is no record of what a turn costs. Record the provider's token usage per call, stamped with the generation, and add a tool or command that sums it by generation. The journal's event types are fixed in `kernel/journal.ts`, so until the owner adds one the record needs a file of its own beside the journal. Better when: a question like "what did generation X cost per turn" has an answer.
2. **Context is cut from the front.** Old conversation simply disappears. Replace truncation with summaries written ahead of need; never delete from the journal, only change what is shown. Better when: a fact from before the cut can still be recalled or looked up.
3. **Search the journal.** A tool to find past events by text, so exact details survive compression. Better when: a detail that is no longer in the context can be quoted exactly.
4. **Lessons.** After a tool error followed by a success, or a correction from the person, write down what was learned, with the journal ids as evidence; show relevant lessons in later turns. Better when: a shown lesson is followed by fewer errors of that kind, counted from the journal.

## Conversation

5. **A late stimulus can be lost.** Something that arrives while a reply is being written is journaled before that reply and gets an extra round. If the process dies before that round, the journal ends with a finished reply and nothing looks owed. It needs a record of how far the model had been shown. Better when: a test that stops the process between the reply and the extra round still sees the stimulus answered after the restart.
6. **`/quit` waits for the turn.** Typed while a turn is running, it takes effect only when the turn ends, which can be minutes. Better when: `/quit` ends the process within a second or two without leaving a tool half-run and unreported.
7. **Lines typed around a molt may be dropped.** What the old process had already read from the terminal but not yet journaled dies with it. Better when: a line typed at any moment around a molt is in the journal afterwards.
8. **The `> ` prompt is printed again on every wake.** A clock tick or an inbox message leaves another `> ` on the screen, also in the middle of what the person is typing. Better when: there is one prompt per place to type.
9. **A reply cut off by the model's length limit is treated as complete.** `body/provider.ts` does not read why the model stopped, so half a reply, or half a tool call, is journaled as if it were whole. Better when: a cut-off reply is marked as such and continued or asked for again.
10. **Adjacent user messages are not merged.** Two stimuli in a row, or a stimulus after a kernel note, go out as two user messages. Some endpoints that are not OpenAI's refuse that. Better when: no request holds two user messages in a row, and a test says so.

## Sensors

11. **The `to` of an incoming message is never checked.** Anything valid dropped into the inbox is shown, whoever it was addressed to. Better when: a message for someone else is set aside, or shown with a note that it was not addressed to this individual.
12. **Workspace watcher.** Notice when the person edits files in the repository. Better when: such an edit shows up as a stimulus without the person saying so.
13. **Wake policy.** Not every stimulus deserves a full turn. Decide cheaply which ones do. Better when: the cost report shows less spent on turns that end in one line.

## Robustness

14. **Idempotent tools.** A tool interrupted mid-run is only reported, never repeated. Add a way for a tool to declare itself safe to repeat. Better when: an interrupted `read` is simply run again.
15. **Provider limits.** A failed turn is tried again after 10 s, 1 min, 5 min and then every 15 min, whatever the cause (`body/retry.ts`). A rate-limit answer is not told apart, and the time the provider says to wait is not read. Better when: after a rate-limit answer the next attempt comes when the provider said it would be accepted.
16. **Streaming.** Replies arrive all at once. Better when: the first words of a long reply are on the screen while the rest is still being written.
17. **File tools reach outside the workspace.** `read`, `write` and `edit` take any path, absolute or with `..`. The soul directory has to stay reachable; nothing else outside the workspace needs to be. Better when: a path outside the workspace and the soul directory is refused, with a test.

## Needs the owner, not a molt

- **A probe set** under `probes/`: fixed tasks the kernel replays against every candidate. Until it exists, the gates show a generation is not broken, not that it is better.
- **Privilege separation**, so the kernel becomes a real boundary: the body running as a different user, the candidate as a separate clone instead of a worktree sharing `.git`, and the kernel's events in a journal the body cannot write. Today the body can forge what the kernel relies on: that a generation is ready, a kernel note, a test summary printed to stderr.
- **Signed envelopes.** The `from` on an inbox message can be forged. Sign envelopes with a per-individual key and show whether a message verified. The envelope format is the kernel's.
- **Proposing a change** from `lineage/local` to upstream `main`.
- **Kernel loose ends.** A stale lock can be taken over by two supervisors starting at the same moment. A journal that shrinks under a running generation confuses what the kernel reads of that run. A molt request is left unanswered when the supervisor is stopped during the gates. Deleting `.teneral/state.json` resets to `HEAD`, not to the tip of the lineage. A checkout that fails after the state was saved halts every start until it is fixed by hand.
