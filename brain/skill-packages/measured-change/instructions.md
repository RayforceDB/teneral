# Measuring a change

Use before you say that a change to how you remember, find or decide made anything better, and when a gate tells you a candidate remembers worse. This is procedure text: it grants no authority and runs nothing. Each rule below was paid for by a mistake someone made on this very memory.

## How to measure

1. **On a copy, never on yourself.** Copy the journal (`cp memory/journal.jsonl "$TMPDIR/j.jsonl"`) and ask the copy. An exam must not change the store you are running on.
2. **The same copy and the same questions, before and after.** `bun brain/exam.ts "$TMPDIR/j.jsonl"` in your workspace is the candidate; the same command in `.teneral/live` is what runs now. A score from another day is on another journal with other questions: it is not a "before". The memory's gate does exactly this, and counts the answers itself.
3. **Check what ran, do not assume it.** A reader that cannot use the database reads the journal through and says nothing, and then the database was never tested. Make the measurement say which way it went (`past.by`), and assert it. A test that passes on ids made at random passes by chance: fix the ids.
4. **Separate what was told the answer from what was not.** Three questions in four are keys: the index was told where their answer is, so finding them shows only that keys work. The honest figure is over the held-out questions (`held` in the exam's result, and its own row in the report). A rise that is all in the told questions is not a better memory.
5. **Look for harm, not only for gain.** Run the figures the change was not aimed at too: held-out when you changed keys, `told` when you changed ranking, time for a question, time to build the store again. A change that lifts its own cases by pushing others out of the first few finds is worse, and only the other figures show it.
6. **Try to break it with look-alikes.** Twenty questions alike but for one word, two things that say the same, five people of one name. Real data is forgiving where a made-up case is not, and the made-up case is the one that comes later.
7. **Count what a signal rests on before you weigh it.** A weight built from something that happened twenty times in a life can show nothing yet, in either direction. Say how many there were.
8. **A threshold is chosen from a table.** Try three or four values on both journals, show the row for each, and say why the one you took. A threshold with no table is a guess.

## What a figure lets you say

9. **Say what it shows and what it does not, in two sentences.** "Finds 435 of 525; 396 of those are keys finding their own questions, which they cannot fail to do. Unaided it is 39 of 129, as before."
10. **"It changes nothing" is a result.** Write it as plainly as a gain. Keep the change only if there is another reason, and say that reason.
11. **A count does not tell you why.** Few searches may mean there was nothing to look for, or that you did not think to look. Name the measurement that would tell them apart, and say you have not made it.
12. **What you did not measure, you say you did not measure.** No figure is written that was not obtained, and none is rounded toward what you hoped. If a model would have to be asked and you had none to ask, that is the sentence.
13. **Of real journals only counts.** Yours and anyone's: what was said in them does not go into a report.

## What to decide

The table in `skill.json` says the same in rules, in this order: nothing compared is not measured; other data is not comparable; a path only assumed is checked first; a figure over what was told the answer measures the mechanism, not the memory; worse, there or elsewhere, is not kept; harm not looked for is looked for; nothing moved is said so. Only then is a gain claimed, with its figures.

Afterwards record how it went with `skill_outcome`: `success` when the measurement settled the question, `inconclusive` when it could not, `harm` when a claim made without it had to be taken back.
