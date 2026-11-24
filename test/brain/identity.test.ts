import { expect, test } from 'bun:test';
import { judge, judgeRequest, nearest, verdicts, type Asked, type Held } from '../../brain/identity';
import type { Provider } from '../../brain/provider';

const held: Held[] = [
  { mark: 'F1', text: 'The staging host is alpha' },
  { mark: 'F2', text: 'Reports go out to the finance team every Friday' },
  { mark: 'F3', text: 'Olga answers for releases of the parser' },
  { mark: 'F4', text: 'The owner wants answers in Russian' },
];

test('the held things nearest to a new one are picked by the words they share, the rarer the word the more; nothing is near what shares none', () => {
  expect(nearest('Staging now runs on the host called beta', held).map((one) => one.mark)).toEqual(['F1']);
  expect(nearest('The finance team gets its reports on Mondays', held).map((one) => one.mark)).toEqual(['F2']);
  expect(nearest('The parser was rewritten in a week', held).map((one) => one.mark)).toEqual([]);
  expect(nearest('Lunch is at noon', held)).toEqual([]);
  expect(nearest('the and for that', held)).toEqual([]);
  expect(nearest('anything', [])).toEqual([]);
});

test('the judge is shown no source: each new thing, the few held things near it, and one line to answer for each', () => {
  const asked: Asked[] = [{ text: 'Staging runs on beta', near: [held[0]!] }];
  const [system, user] = judgeRequest('facts', asked);
  expect(system!.content).toContain('You are not shown where they come from');
  expect(system!.content).toContain('When in doubt, say new');
  expect(user!.content).toBe('These are facts. New items, each with the held items nearest to it:\n\n1. Staging runs on beta\n   F1: The staging host is alpha');
});

test('a verdict counts only in form and only for a mark that was put beside that item; anything else is new', () => {
  const asked: Asked[] = [{ text: 'a', near: [held[0]!] }, { text: 'b', near: [held[1]!, held[2]!] }, { text: 'c', near: [held[3]!] }, { text: 'd', near: [held[0]!] }];
  expect(verdicts('1: same F1\n2) replaces `F3`\n3: same F1\n4: surely the same\n9: same F1\nand some talk', asked)).toEqual([
    { is: 'same', mark: 'F1' }, { is: 'replaces', mark: 'F3' }, { is: 'new' }, { is: 'new' },
  ]);
  expect(verdicts('', asked)).toEqual(asked.map(() => ({ is: 'new' })));
});

test('only what has something near it is asked about, nobody is asked when nothing has, and a request that fails decides nothing', async () => {
  const seen: string[] = [];
  const provider = (text: string): Provider => async (messages) => { seen.push(String(messages[1]!.content)); return { text, toolCalls: [], usage: { input: 10, output: 2 } } as never; };
  const items: Asked[] = [{ text: 'new and alone', near: [] }, { text: 'Staging runs on beta', near: [held[0]!] }];
  const done = await judge(provider('1: replaces F1'), 'facts', items);
  // The one asked about is numbered 1 in the request, and its verdict lands on the second item.
  expect(done.verdicts).toEqual([{ is: 'new' }, { is: 'replaces', mark: 'F1' }]);
  expect(done.asked).toBe(1);
  expect(seen[0]).toContain('1. Staging runs on beta');
  expect(seen[0]).not.toContain('new and alone');
  expect((await judge(provider('1: same F1'), 'facts', [{ text: 'x', near: [] }])).asked).toBe(0);
  expect(seen).toHaveLength(1);
  const failing: Provider = async () => { throw new Error('no'); };
  expect((await judge(failing, 'facts', items)).verdicts).toEqual([{ is: 'new' }, { is: 'new' }]);
});
