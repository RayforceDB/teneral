import { expect, test } from 'bun:test';
import { mended } from '../../brain/loop';

const parameters = { type: 'object', properties: { who: { type: 'string' }, before: { type: 'string' }, traits: { type: 'object' }, ids: { type: 'array' }, n: { type: 'number' }, k: { type: 'integer' }, yes: { type: 'boolean' } } };

test('arguments a model wrote in the wrong shape are put right where they can mean only one thing', () => {
  expect(mended(parameters, { who: 'zulip:7', traits: '{"role": "maintains the parser"}', ids: '["a","b"]', n: '2.5', k: '3', yes: 'true', before: 5 }))
    .toEqual({ who: 'zulip:7', traits: { role: 'maintains the parser' }, ids: ['a', 'b'], n: 2.5, k: 3, yes: true, before: '5' });
});

test('what fits is the very same object, and what cannot be read as what is asked for is left for the tool to refuse', () => {
  const fine = { who: 'x', traits: { a: 'b' }, n: 1 };
  expect(mended(parameters, fine)).toBe(fine);
  // JSON of another shape than asked for, text that is not JSON, and text where text is asked for, even if it looks like JSON.
  const odd = { traits: '[1,2]', ids: 'a, b', n: 'many', k: '2.5', yes: 'maybe', who: '{"a":1}', other: '{"kept": "as it is"}' };
  expect(mended(parameters, odd)).toBe(odd);
  for (const args of ['raw text', null, undefined, [1], 5]) expect(mended(parameters, args)).toBe(args as never);
  expect(mended(undefined, fine)).toBe(fine);
});
