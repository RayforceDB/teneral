import { test, expect } from 'bun:test';
import { replyRoute } from '../../body/zulip-tools';
test('replies preserve private recipients or stream topic, never guess destinations', () => {
  expect(replyRoute({ type: 'private', sender_id: 2, display_recipient: [{ id: 1 }, { id: 2 }, { id: 3 }] }, 1))
    .toEqual({ type: 'direct', to: '[2]' });
  expect(replyRoute({ type: 'private', sender_id: 2, display_recipient: [{ id: 1 }, { id: 2 }, { id: 3 }] }, 1, true))
    .toEqual({ type: 'direct', to: '[2,3]' });
  expect(replyRoute({ type: 'private', sender_id: 2, display_recipient: [{ id: 1 }, { id: 2 }] }, 1))
    .toEqual({ type: 'direct', to: '[2]' });
  expect(() => replyRoute({ type: 'private', sender_id: 1, display_recipient: [{ id: 1 }, { id: 2 }, { id: 3 }] }, 1)).toThrow();
  expect(() => replyRoute({ type: 'private', sender_id: 'not-an-id', display_recipient: [{ id: 1 }, { id: 2 }, { id: 3 }] }, 1)).toThrow();
  expect(replyRoute({ type: 'stream', stream_id: 123, subject: 'topic' }, 1))
    .toEqual({ type: 'stream', to: '123', topic: 'topic' });
  expect(() => replyRoute({ type: 'private', display_recipient: [{ id: 1 }] }, 1)).toThrow();
  expect(() => replyRoute({ type: 'stream' }, 1)).toThrow();
});
