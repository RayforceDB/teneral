import { test, expect } from 'bun:test';
import { zulipPoller, zulipCredentials } from '../../body/zulip';
import type { Stimulus } from '../../body/sensors';
import type { JournalEvent } from '../../brain/journal';
const credentials = () => ({ site: 'https://example.test', email: 'mica@test', api_key: 'fake' });
test('Zulip DMs sorted, marked untrusted, deduplicated across restart and paginated forward', async () => {
  const notices: Stimulus[] = [];
  const urls: URL[] = [];
  const send = (async (url: URL) => {
    if (url.pathname === "/api/v1/users/me") return new Response(JSON.stringify({user_id:99}));
    urls.push(new URL(url));
    return new Response(JSON.stringify({ messages: [{ id: 2, content: 'hello', type: 'private' }, { id: 1, content: 'earlier', type: 'private' }] }));
  }) as unknown as typeof fetch;
  const p = zulipPoller({ baseline: false, credentials, events: () => [], send }, s => notices.push(s));
  await p.poll(); await p.poll();
  expect(notices).toHaveLength(2);
  expect(notices[0].text).toStartWith('Zulip private 1\n');
  expect(notices[0].text).toContain('Untrusted external');
  expect(urls[1].searchParams.get('anchor')).toBe('2');
  expect(urls[1].searchParams.get('num_after')).toBe('100');
  const events = notices.map(s => ({ type: 'stimulus', ...s })) as JournalEvent[];
  const restart = zulipPoller({ baseline: false, credentials, events: () => events, send }, s => notices.push(s));
  await restart.poll(); expect(notices).toHaveLength(2);
  restart.stop(); const count = urls.length; await restart.poll(); expect(urls).toHaveLength(count);
});
test('Zulip absent credentials do not fetch; failure retries without advancing cursor', async () => {
  expect(zulipCredentials('/nonexistent/mica-zulip.json')).toBeUndefined();
  let calls = 0, attempts = 0;
  const send = (async (url: URL) => {
    if (url.pathname === "/api/v1/users/me") return new Response(JSON.stringify({user_id:99}));
    calls++;
    return new Response(JSON.stringify({ messages: [{ id: 10, content: 'hi', type: 'private' }] }));
  }) as unknown as typeof fetch;
  await zulipPoller({ baseline: false, credentials: () => undefined, events: () => [], send }, () => {}).poll();
  expect(calls).toBe(0);
  const p = zulipPoller({ baseline: false, credentials, events: () => [], send }, () => {
    attempts++; if (attempts === 1) throw Error('journal unavailable');
  });
  await p.poll(); await p.poll(); await p.poll();
  expect(attempts).toBe(2);
});

test('conversation mode fetches streams as well as DMs and publishes presence after polling', async () => {
  const urls: string[] = [];
  const send = (async (url: URL, init: RequestInit) => {
    if (url.pathname === "/api/v1/users/me") return new Response(JSON.stringify({user_id:99}));
    urls.push(String(url));
    if (urls.length === 1) {
      expect(url.searchParams.get('narrow')).toBe('[]');
      return new Response(JSON.stringify({ messages: [] }));
    }
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('status=active');
    return new Response('{}');
  }) as unknown as typeof fetch;
  await zulipPoller({ baseline: false, credentials, events: () => [], send, conversations: true }, () => {}).poll();
  expect(urls[1]).toEndWith('/users/me/presence');
});

test('own echoes are silent; private wakes, plain stream is held, mention wakes', async () => {
  const notices: Stimulus[] = [];
  const anchors: string[] = [];
  const pages = [
    [{id: 1, sender_id: 99, sender_email: 'different@test', content: 'own reply', type: 'stream'}],
    [{id: 2, sender_id: 100, sender_email: 'mica@test', sender_full_name: 'Mica', content: 'own reply', type: 'private'},
     {id: 3, sender_id: 99, sender_email: 'different@test', content: 'own reply', type: 'private'}],
    [{id: 4, sender_id: 98, sender_email: 'a@test', content: 'stream chatter', type: 'stream'},
     {id: 5, sender_id: 97, sender_email: 'b@test', content: 'hello @mica', type: 'stream', flags: ['mentioned']}],
  ];
  const send = (async (url: URL) => {
    if (url.pathname === "/api/v1/users/me") return new Response(JSON.stringify({user_id:99}));
    anchors.push(url.searchParams.get('anchor')!);
    return new Response(JSON.stringify({messages: pages.shift() ?? []}));
  }) as unknown as typeof fetch;
  const p = zulipPoller({baseline:false,credentials, events: () => [], send}, s => notices.push(s));
  await p.poll(); expect(notices).toHaveLength(0);
  await p.poll();
  expect(notices).toHaveLength(1);
  expect(notices[0].text).toStartWith('Zulip private 2\n');
  await p.poll();
  expect(anchors).toEqual(['newest', '1', '3']);
  expect(notices).toHaveLength(2);
  expect(notices[1].text).toStartWith('Zulip mention 5\n');
  expect(notices[1].text).toContain('stream chatter');
});

test('ordinary stream pages stay silent until a later private message carries their context', async () => {
  const notices: Stimulus[] = [];
  const pages = [
    [{id: 10, sender_id: 98, type: 'stream', content: 'background only'}],
    [{id: 11, sender_id: 97, type: 'private', content: 'a real question'}],
  ];
  const send = (async (url: URL) => new Response(JSON.stringify(
    url.pathname === '/api/v1/users/me' ? {user_id: 99} : {messages: pages.shift() ?? []},
  ))) as unknown as typeof fetch;
  const p = zulipPoller({baseline:false,credentials, events: () => [], send}, s => notices.push(s));
  await p.poll();
  expect(notices).toHaveLength(0);
  await p.poll();
  expect(notices).toHaveLength(1);
  expect(notices[0].text).toStartWith('Zulip private 11\n');
  expect(notices[0].text).toContain('background only');
});

test('only the configured numeric Zulip sender becomes an owner source; both sources restore the cursor', async () => {
  const notices: Stimulus[] = [];
  const send = (async (url: URL) => new Response(JSON.stringify(
    url.pathname === '/api/v1/users/me' ? {user_id: 99} : {messages: [
      {id: 20, sender_id: 100, type: 'private', content: 'owner'},
      {id: 21, sender_id: 101, type: 'private', content: 'outsider'},
    ]},
  ))) as unknown as typeof fetch;
  const p = zulipPoller({baseline:false,credentials, events: () => [], send, ownerId: 100}, s => notices.push(s));
  await p.poll();
  expect(notices.map(n => n.source)).toEqual(['owner:zulip', 'agent:zulip']);
  expect(notices[0].text).toContain('API-verified owner message.');
  expect(notices[1].text).toContain('Untrusted external');
  const anchors: string[] = [];
  const restartSend = (async (url: URL) => new Response(JSON.stringify(
    url.pathname === '/api/v1/users/me' ? {user_id: 99} : (anchors.push(url.searchParams.get('anchor')!), {messages: []}),
  ))) as unknown as typeof fetch;
  const events = notices.map(s => ({type: 'stimulus', ...s})) as JournalEvent[];
  await zulipPoller({baseline:false,credentials, events: () => events, send: restartSend, ownerId: 100}, () => {}).poll();
  expect(anchors).toEqual(['21']);
});

test('self echoes refetched after restart remain silent', async () => {
  let emitted = 0;
  const send = (async (url: URL) => new Response(JSON.stringify(url.pathname === "/api/v1/users/me" ? {user_id:99} : {messages: [
    {id: 5, sender_id: 99, sender_email: 'different@test'},
  ]}))) as unknown as typeof fetch;
  for (let restart = 0; restart < 2; restart++) {
    const p = zulipPoller({baseline:false,credentials, events: () => [], send}, () => { emitted++; });
    await p.poll(); p.stop();
  }
  expect(emitted).toBe(0);
});

test('identity failures preserve cursor; cache is reused and invalidated on credential rotation', async()=>{
 let key='first', lookups=0, reads=0; const notices:Stimulus[]=[];
 const send=(async(url:URL)=>{
  if(url.pathname==='/api/v1/users/me') {
   lookups++;
   if(lookups===1) return new Response('{}');
   return new Response(JSON.stringify({user_id:key==='first'?99:100}));
  }
  reads++;
  return new Response(JSON.stringify({messages:[{id:reads,sender_id:key==='first'?99:100}]}));
 }) as unknown as typeof fetch;
 const p=zulipPoller({baseline:false,credentials:()=>({...credentials(),api_key:key}),events:()=>[],send},s=>notices.push(s));
 await p.poll();expect(reads).toBe(0);
 await p.poll();await p.poll();expect(lookups).toBe(2);expect(reads).toBe(2);
 key='second';await p.poll();expect(lookups).toBe(3);expect(notices).toHaveLength(0);
});

test('a message whose stimulus could not be journaled is fetched and told again', async () => {
  // The second message is fetched, but writing its stimulus fails (a stop in the middle of it).
  // The cursor moves only past what was told, so the next poll asks from 1 again and tells it.
  const notices: Stimulus[] = [];
  const asked: string[] = [];
  const pages = [
    [{id: 1, sender_id: 100, type: 'private', content: 'first'}],
    [{id: 2, sender_id: 100, type: 'private', content: 'second'}],
    [{id: 2, sender_id: 100, type: 'private', content: 'second'}],
  ];
  let calls = 0;
  const send = (async (url: URL) => {
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({user_id: 99}));
    asked.push(url.searchParams.get('anchor') ?? '');
    return new Response(JSON.stringify({messages: pages.shift() ?? []}));
  }) as unknown as typeof fetch;
  const emit = (s: Stimulus) => {
    calls++;
    if (calls === 2) throw new Error('stopped before id 2 reached the journal');
    notices.push(s);
  };
  const p = zulipPoller({baseline: false, credentials, events: () => [], send}, emit);
  await p.poll();
  expect(notices).toHaveLength(1);
  await p.poll();
  expect(notices).toHaveLength(1);
  await p.poll();
  expect(asked).toEqual(['newest', '1', '1']);
  expect(notices).toHaveLength(2);
  expect(notices[1]!.text).toStartWith('Zulip private 2\n');
});

import { zulipLive, zulipReactionPoller, ZULIP_REACTION_SOURCE, ZULIP_QUEUE_CURSOR_KIND, type ZulipQueueCursor } from '../../body/zulip';

test('Zulip reaction queue baselines history, emits add/remove, and checkpoints after delivery', async () => {
  const notices: Stimulus[] = [];
  const checkpoints: any[] = [];
  const registrations: string[] = [];
  let eventCalls = 0;
  const send = (async (url: URL, init: RequestInit = {}) => {
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({user_id:99}));
    if (url.pathname === '/api/v1/register') {
      registrations.push(String(init.body));
      return new Response(JSON.stringify({queue_id:'q1',last_event_id:10}));
    }
    eventCalls++;
    expect(url.searchParams.get('queue_id')).toBe('q1');
    return new Response(JSON.stringify({events:eventCalls === 1 ? [
      {id:11,type:'reaction',op:'add',message_id:7,user_id:42,emoji_name:'old',emoji_code:'1',reaction_type:'unicode_emoji'},
    ] : [
      {id:12,type:'reaction',op:'add',message_id:7,user_id:99,emoji_name:'self',emoji_code:'2',reaction_type:'unicode_emoji'},
      {id:13,type:'reaction',op:'add',message_id:7,user_id:42,emoji_name:'wave',emoji_code:'1f44b',reaction_type:'unicode_emoji'},
      {id:14,type:'message',id2:0},
      {id:15,type:'reaction',op:'remove',message_id:7,user_id:42,emoji_name:'wave',emoji_code:'1f44b',reaction_type:'unicode_emoji'},
    ]}));
  }) as unknown as typeof fetch;
  const events: JournalEvent[] = [];
  const p = zulipReactionPoller({credentials, events:()=>events, send, checkpoint:c=>{
    checkpoints.push(c);
    events.push({type:'note',kind:ZULIP_QUEUE_CURSOR_KIND,data:c} as JournalEvent);
  }}, s=>{ notices.push(s); events.push({type:'stimulus',...s} as JournalEvent); });
  await p.poll();
  expect(notices).toHaveLength(0);
  expect(registrations[0]).toContain('event_types');
  expect(registrations[0]).toContain('reaction');
  const registration = new URLSearchParams(registrations[0]);
  expect(JSON.parse(registration.get('client_capabilities')!)).toEqual({ notification_settings_null: true });
  expect(JSON.parse(registration.get('event_types')!)).toEqual(['reaction']);
  expect(checkpoints).toEqual([{queueId:'q1',eventId:11,site:'https://example.test',email:'mica@test'}]);
  await p.poll();
  expect(notices).toHaveLength(2);
  expect(notices.every(n=>n.source===ZULIP_REACTION_SOURCE)).toBe(true);
  expect(notices[0].text).toContain('"op":"add"');
  expect(notices[0].text).toContain('"message_id":7');
  expect(notices[1].text).toContain('"op":"remove"');
  expect(notices[0].text).toContain('not owner authority');
  expect(checkpoints.at(-1).eventId).toBe(15);
  // Restart from the journal cursor: no registration, no historical or duplicate wake.
  const anchors: string[]=[];
  const restartedSend=(async(url:URL)=>{
    if(url.pathname==='/api/v1/users/me')return new Response(JSON.stringify({user_id:99}));
    anchors.push(url.searchParams.get('last_event_id')!);
    return new Response(JSON.stringify({events:[]}));
  }) as unknown as typeof fetch;
  await zulipReactionPoller({credentials,events:()=>events,send:restartedSend},()=>{throw Error('duplicate')}).poll();
  expect(anchors).toEqual(['15']);
});

test('Zulip reaction queue replaces an expired queue without replaying its baseline', async () => {
  const events: JournalEvent[] = [{ type:'note', kind:ZULIP_QUEUE_CURSOR_KIND, data:{queueId:'old',eventId:4,site:'https://example.test',email:'mica@test'} } as JournalEvent];
  const checkpoints: any[] = []; let queues = 0; let notices = 0;
  const send = (async (url: URL) => new Response(JSON.stringify(
    url.pathname === '/api/v1/users/me' ? {user_id:99} :
    url.pathname === '/api/v1/register' ? {queue_id:`q${++queues}`,last_event_id:0} :
    url.searchParams.get('queue_id') === 'old' ? {result:'error',code:'BAD_EVENT_QUEUE_ID',msg:'expired'} :
    url.searchParams.get('last_event_id') === '0' ? {events:[{id:1,type:'reaction',op:'add',message_id:1,user_id:10,emoji_name:'old',emoji_code:'1',reaction_type:'unicode_emoji'}]} : {events:[]},
  ), {status:url.pathname === '/api/v1/events' && url.searchParams.get('queue_id') === 'old' ? 400 : 200})) as unknown as typeof fetch;
  const p = zulipReactionPoller({credentials,events:()=>events,send,checkpoint:c=>{checkpoints.push(c);events.push({type:'note',kind:ZULIP_QUEUE_CURSOR_KIND,data:c} as JournalEvent)}},()=>{notices++});
  await p.poll(); // only discard the dead queue; do not register and discard another event in one call
  expect(checkpoints).toEqual([]);
  await p.poll(); // new baseline: historical reactions stay silent
  expect(notices).toBe(0); expect(checkpoints.at(-1)).toMatchObject({queueId:'q1',eventId:1});
  await p.poll(); // ordinary empty event list uses the new cursor
  expect(notices).toBe(0); expect(queues).toBe(1);
});

test('Zulip reaction queue retries a partial batch and does not checkpoint before emit returns', async () => {
  const events: JournalEvent[]=[]; const checkpoints:any[]=[]; let batches=0; let notices=0;
  const send=(async(url:URL)=>new Response(JSON.stringify(
    url.pathname==='/api/v1/users/me'?{user_id:99}:
    url.pathname==='/api/v1/register'?{queue_id:'q',last_event_id:0}:
    {events:batches++===0?[]:[
      {id:1,type:'reaction',op:'add',message_id:1,user_id:10,emoji_name:'a',emoji_code:'1',reaction_type:'unicode_emoji'},
      {id:2,type:'reaction',op:'add',message_id:1,user_id:11,emoji_name:'b',emoji_code:'2',reaction_type:'unicode_emoji'},
    ]},
  ))) as unknown as typeof fetch;
  const emit=(s:Stimulus)=>{
    notices++;
    events.push({type:'stimulus',...s} as JournalEvent);
    if(notices===1) throw Error('journal failed after append');
  };
  const p=zulipReactionPoller({credentials,events:()=>events,send,checkpoint:c=>{checkpoints.push(c);events.push({type:'note',kind:ZULIP_QUEUE_CURSOR_KIND,data:c} as JournalEvent)}},emit);
  await p.poll(); await p.poll();
  expect(checkpoints).toHaveLength(1); // baseline only
  await p.poll();
  expect(notices).toBe(2); // first event re-read, suppressed from journal, second delivered
  expect(checkpoints.at(-1).eventId).toBe(2);
});

test('only verified owner uploads enter the image store; HTML and bytes stay bounded', async () => {
  const notices: Stimulus[] = [], kept: Buffer[] = [], fetched: string[] = [];
  const png = Buffer.from('89504e470d0a1a0a000000', 'hex');
  const send = (async (url: URL) => {
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({user_id:99}));
    if (url.pathname === '/api/v1/messages') return new Response(JSON.stringify({messages: [
      {id:40,sender_id:100,type:'private',content:'[pic](/user_uploads/1/a/pic.png)'},
      {id:41,sender_id:101,type:'private',content:'[outsider](/user_uploads/1/a/outsider.png)'},
    ]}));
    if (url.pathname === '/api/v1/messages/40') return new Response(JSON.stringify({message:{content:'<p>look <a href="/user_uploads/1/a/pic.png">pic</a><img src="/user_uploads/thumbnail/1/a/pic.png/840x560.webp"></p>'}}));
    fetched.push(url.pathname); return new Response(png);
  }) as unknown as typeof fetch;
  await zulipPoller({baseline:false,credentials,events:()=>[],send,ownerId:100,keepImage:async b=>{kept.push(b);return '[image: memory/images/'+('a'.repeat(64))+'.png]'}},s=>notices.push(s)).poll();
  expect(fetched).toEqual(['/user_uploads/1/a/pic.png']);
  expect(kept).toEqual([png]);
  expect(notices[0].source).toBe('owner:zulip');
  expect(notices[0].text).toEndWith('[image: memory/images/'+('a'.repeat(64))+'.png]');
  expect(notices[1].text).not.toContain('[image:');
});

test('an inline image whose src is a thumbnail downloads the data-original-src original', async () => {
  // Zulip renders <img src="/user_uploads/thumbnail/..."> with the full image in
  // data-original-src; reading src alone yields only the downscaled thumbnail, which the
  // download filter discards, so the message used to emit with no image marker at all.
  // The raw markdown has no upload link (apply_markdown=false), so the trigger must not
  // depend on seeing "/user_uploads/" in the raw text.
  const notices: Stimulus[] = [], kept: Buffer[] = [], fetched: string[] = [];
  const png = Buffer.from('89504e470d0a1a0a000000', 'hex');
  const send = (async (url: URL) => {
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({user_id:99}));
    if (url.pathname === '/api/v1/messages') return new Response(JSON.stringify({messages: [
      {id:50,sender_id:100,type:'private',content:'look at the screenshot'},
    ]}));
    if (url.pathname === '/api/v1/messages/50') return new Response(JSON.stringify({message:{content:'<p>shot<br><img alt="image.png" class="inline-image" data-original-src="/user_uploads/2/b/shot.png" src="/user_uploads/thumbnail/2/b/shot.png/840x560.webp"><br>done</p>'}}));
    fetched.push(url.pathname); return new Response(png);
  }) as unknown as typeof fetch;
  await zulipPoller({baseline:false,credentials,events:()=>[],send,ownerId:100,keepImage:async b=>{kept.push(b);return '[image: memory/images/'+('b'.repeat(64))+'.png]'}},s=>notices.push(s)).poll();
  expect(fetched).toEqual(['/user_uploads/2/b/shot.png']);
  expect(kept).toEqual([png]);
  expect(notices[0].source).toBe('owner:zulip');
  expect(notices[0].text).toEndWith('[image: memory/images/'+('b'.repeat(64))+'.png]');
});

test('a non-image owner attachment does not abort the batch; the message and later ones still emit', async () => {
  // Regression: an owner message whose upload is not a showable image (here a .md) made
  // keepImage throw inside the batch loop, aborting the whole poll pass so every pending
  // message was dropped. The attachment must degrade to a note and the rest of the batch emit.
  const notices: Stimulus[] = [];
  const mdBytes = Buffer.from('# not an image');
  const send = (async (url: URL) => {
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({ user_id: 99 }));
    if (url.pathname === '/api/v1/messages') return new Response(JSON.stringify({ messages: [
      { id: 10, sender_id: 100, type: 'private', content: 'see the report [r](/user_uploads/1/a/r.md)' },
      { id: 11, sender_id: 100, type: 'private', content: 'follow up' },
    ] }));
    if (url.pathname === '/api/v1/messages/10') return new Response(JSON.stringify({ message: { content: '<a href="/user_uploads/1/a/r.md">r</a>' } }));
    if (url.pathname.startsWith('/user_uploads/')) return new Response(mdBytes, { headers: { 'content-type': 'text/markdown' } });
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
  const keepImage = () => { throw new Error('not a PNG, JPEG, GIF or WebP image'); };
  await zulipPoller({ baseline: false, credentials, events: () => [], send, ownerId: 100, keepImage }, s => notices.push(s)).poll();
  expect(notices).toHaveLength(2); // both the .md message and the follow-up emit
  expect(notices[0].source).toBe('owner:zulip');
  expect(notices[0].text).toContain('see the report');
  expect(notices[0].text).toContain('[Zulip attachment could not be shown]');
  expect(notices[1].text).toContain('follow up');
});

test('owner attachment failures do not lose the message or download untrusted files', async () => {
  const notices: Stimulus[] = [];
  const send = (async (url: URL) => {
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({user_id:99}));
    if (url.pathname === '/api/v1/messages') return new Response(JSON.stringify({messages:[{id:42,sender_id:100,type:'private',content:'[big](/user_uploads/1/a/big.png)'}]}));
    if (url.pathname === '/api/v1/messages/42') return new Response(JSON.stringify({message:{content:'<a href="/user_uploads/1/a/big.png">big</a>'}}));
    return new Response(new Uint8Array(10*1024*1024+1));
  }) as unknown as typeof fetch;
  let kept = 0;
  await zulipPoller({baseline:false,credentials,events:()=>[],send,ownerId:100,keepImage:()=>{kept++;return ''}},s=>notices.push(s)).poll();
  expect(kept).toBe(0); expect(notices).toHaveLength(1);
  expect(notices[0].text).toContain('[Zulip image exceeds 10 MB]');
});

// --- taking part in a channel without being mentioned ---

/** A poller over scripted pages of messages, with a clock the test moves. */
function channel(more: { ownerId?: number; ambient?: boolean; users?: unknown } = {}) {
  const got: Stimulus[] = [];
  const pages: unknown[][] = [];
  const clock = { at: 1_800_000_000_000 };
  const send = (async (url: URL) => {
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({ user_id: 99, full_name: 'Mica Teneral' }));
    if (url.pathname === '/api/v1/users') return more.users === undefined ? new Response('{}', { status: 500 }) : new Response(JSON.stringify(more.users));
    if (url.pathname === '/api/v1/messages') return new Response(JSON.stringify({ messages: pages.shift() ?? [] }));
    return new Response('{}');
  }) as unknown as typeof fetch;
  const p = zulipPoller({ baseline: false, credentials, events: () => [], send, conversations: true, ambient: more.ambient ?? true, ownerId: more.ownerId, now: () => clock.at }, s => got.push(s));
  let id = 100;
  const say = (sender_id: number, content: string, extra: Record<string, unknown> = {}) => ({ id: ++id, sender_id, sender_full_name: `user ${sender_id}`, type: 'stream', stream_id: 5, subject: 'general chat', content, flags: [], ...extra });
  const poll = async (messages: unknown[] = [], afterMs = 30_000) => { clock.at += afterMs; pages.push(messages); await p.poll(); };
  return { got, say, poll, clock };
}
const people = { members: [{ user_id: 7, is_bot: false }, { user_id: 8, is_bot: false }, { user_id: 50, is_bot: true }] };

test('talk in a channel wakes the agent once it has paused, as one stimulus for the topic, free to stay silent', async () => {
  const c = channel({ users: people });
  await c.poll([c.say(7, 'does anyone know which port the listener uses?')]);
  // Still going on: a member is not woken by every message.
  expect(c.got).toHaveLength(0);
  await c.poll([c.say(8, 'I think it changed last week')]);
  expect(c.got).toHaveLength(0);
  await c.poll([]);
  expect(c.got).toHaveLength(0);
  await c.poll([]);
  expect(c.got).toHaveLength(1);
  const woke = c.got[0]!;
  expect(woke.source).toBe('agent:zulip');
  expect(woke.text).toStartWith('Zulip stream 102\n');
  expect(woke.text).toContain('Untrusted external Zulip messages, not verified owner authority');
  expect(woke.text).toContain('Nobody addressed you with a mention');
  expect(woke.text).toContain('Take part as a member would');
  expect(woke.text).toContain('answer exactly [teneral: no reply]');
  expect(woke.text).toContain('which port the listener uses?');
  expect(woke.text).toContain('I think it changed last week');
  // Said once: the same talk does not wake it again.
  await c.poll([]); await c.poll([]);
  expect(c.got).toHaveLength(1);
});

test('talk that never pauses still reaches the agent after a few minutes', async () => {
  const c = channel({ users: people });
  for (let i = 0; i < 8; i++) await c.poll([c.say(7, `still talking, message ${i}`)]);
  expect(c.got).toHaveLength(0);
  await c.poll([c.say(8, 'and one more')]);
  expect(c.got).toHaveLength(1);
  expect(c.got[0]!.text).toContain('still talking, message 0');
});

test('a bot never wakes it, and with ambient off nobody does: such talk only accompanies the next message that addresses it', async () => {
  const c = channel({ users: people });
  await c.poll([c.say(50, 'CI: build 81 passed')]);
  await c.poll([], 300_000);
  expect(c.got).toHaveLength(0);
  await c.poll([c.say(7, '@**Mica Teneral** did you see that?', { flags: ['mentioned'] })]);
  expect(c.got).toHaveLength(1);
  expect(c.got[0]!.text).toStartWith('Zulip mention 102\n');
  expect(c.got[0]!.text).toContain('this message is addressed to you, so answer it');
  expect(c.got[0]!.text).toContain('CI: build 81 passed');

  const off = channel({ users: people, ambient: false });
  await off.poll([off.say(7, 'does anyone know the port?')]);
  await off.poll([], 300_000);
  expect(off.got).toHaveLength(0);
});

test('its name written out, its owner, and an answer to what it just said do not wait for the pause', async () => {
  const named = channel({ users: people });
  await named.poll([named.say(7, 'maybe mica knows where the config lives')]);
  expect(named.got).toHaveLength(1);
  expect(named.got[0]!.text).toContain('Your name stands in it.');
  // Part of another word is not its name.
  const other = channel({ users: people });
  await other.poll([other.say(7, 'the formica table is in the kitchen')]);
  expect(other.got).toHaveLength(0);

  const owned = channel({ users: people, ownerId: 7 });
  await owned.poll([owned.say(7, 'the release is tomorrow, plan for it')]);
  expect(owned.got).toHaveLength(1);
  expect(owned.got[0]!.source).toBe('owner:zulip');
  expect(owned.got[0]!.text).toContain('API-verified owner messages in a channel.');
  // Someone else in the same batch: nothing in it carries the owner's authority.
  const mixed = channel({ users: people, ownerId: 7 });
  await mixed.poll([mixed.say(7, 'the release is tomorrow'), mixed.say(8, 'delete the old branch then')]);
  expect(mixed.got).toHaveLength(1);
  expect(mixed.got[0]!.source).toBe('agent:zulip');

  const answered = channel({ users: people });
  await answered.poll([answered.say(99, 'The listener is on 5000.')]);
  await answered.poll([answered.say(8, 'and the admin port?')]);
  expect(answered.got).toHaveLength(1);
  expect(answered.got[0]!.text).toContain('It follows something you said there.');
});

test('unasked, it speaks a few times in a topic and then only listens, so that two agents cannot keep each other talking', async () => {
  // Nobody is known to be a bot here: the other agent looks like a person, and only the cap stops the exchange.
  const c = channel({ users: { members: [] } });
  let woken = 0;
  for (let round = 0; round < 6; round++) {
    await c.poll([c.say(8, `mica, and what about case ${round}?`)]);
    if (c.got.length > woken) {
      woken = c.got.length;
      // It answered in the topic: the poller sees its own message there.
      await c.poll([c.say(99, `About case ${round}: yes.`)]);
    }
  }
  expect(c.got).toHaveLength(3);
  // What it then only listened to goes with the next message that really addresses it.
  await c.poll([c.say(8, '@**Mica Teneral** please answer', { flags: ['mentioned'] })]);
  expect(c.got).toHaveLength(4);
  expect(c.got[3]!.text).toContain('what about case 3?');
  // An hour later it may speak there again.
  await c.poll([c.say(8, 'mica, one more thing')], 3_600_000);
  expect(c.got).toHaveLength(5);
});

test('when the server will not say who is a bot, talk is context only', async () => {
  const c = channel();
  await c.poll([c.say(7, 'does anyone know the port?')]);
  await c.poll([], 300_000);
  expect(c.got).toHaveLength(0);
});

// --- where listening begins ---

test('with nothing ever heard, what was said before is the past: listening begins at the newest message and nothing old is answered', async () => {
  const got: Stimulus[] = [];
  const asked: URLSearchParams[] = [];
  const pages: unknown[][] = [
    [{ id: 50, sender_id: 7, type: 'private', content: 'a question from last week' }],
    [],
    [{ id: 51, sender_id: 7, type: 'private', content: 'are you there now?' }],
  ];
  const send = (async (url: URL) => {
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({ user_id: 99, full_name: 'Mica' }));
    asked.push(url.searchParams);
    return new Response(JSON.stringify({ messages: pages.shift() ?? [] }));
  }) as unknown as typeof fetch;
  const p = zulipPoller({ credentials, events: () => [], send }, s => got.push(s));
  await p.poll();
  expect(got).toHaveLength(0);
  // One message asked for to find where to begin, then forward from it.
  expect([asked[0]!.get('anchor'), asked[0]!.get('num_before')]).toEqual(['newest', '1']);
  expect([asked[1]!.get('anchor'), asked[1]!.get('num_after')]).toEqual(['50', '100']);
  await p.poll();
  expect(got).toHaveLength(1);
  expect(got[0]!.text).toStartWith('Zulip private 51\n');
  expect(got[0]!.text).toContain('naming this message as zulip:51');
});

test('a message that quotes the agent is taken as an answer to it, and is shown with its stream, its time and that it was edited', async () => {
  const c = channel({ users: people });
  await c.poll([c.say(8, '@_**Mica Teneral|99** [said](https://example.test/#narrow/channel/5/topic/x/near/90):\n```quote\nThe listener is on 5000.\n```\nstill true?', { display_recipient: 'engineering', timestamp: 1_800_000_000, last_edit_timestamp: 1_800_000_050 })]);
  expect(c.got).toHaveLength(1);
  expect(c.got[0]!.text).toContain('It quotes something you said.');
  const shown = JSON.parse(c.got[0]!.text.split('\n').at(-1)!);
  expect(shown).toMatchObject({ stream: 'engineering', topic: 'general chat', at: '2027-01-15T08:00:00.000Z', edited: true, sender_id: 8 });
  // A quote of someone else is ordinary talk.
  const other = channel({ users: people });
  await other.poll([other.say(8, '@_**Ann|7** [said](https://example.test/#narrow/near/90):\n```quote\nhm\n```\nagreed')]);
  expect(other.got).toHaveLength(0);
});

// --- edits, deletions, the event queue as a bell, and a connection that was down ---

/** A poller whose /messages pages and single messages are scripted; `clock` moves by 30 s a poll. */
function live(more: { ownerId?: number } = {}) {
  const c = channel({ users: people, ...more });
  return c;
}

test('an edit rewrites talk that still waits; a mention added by an edit wakes the agent; an edit of what woke it is told as an edit', async () => {
  const got: Stimulus[] = [];
  const pages: unknown[][] = [];
  const single = new Map<number, unknown>();
  const clock = { at: 1_800_000_000_000 };
  const send = (async (url: URL) => {
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({ user_id: 99, full_name: 'Mica Teneral' }));
    if (url.pathname === '/api/v1/users') return new Response(JSON.stringify(people));
    const one = /^\/api\/v1\/messages\/(\d+)$/.exec(url.pathname);
    if (one) return single.has(Number(one[1])) ? new Response(JSON.stringify({ message: single.get(Number(one[1])) })) : new Response('{}', { status: 400 });
    if (url.pathname === '/api/v1/messages') return new Response(JSON.stringify({ messages: pages.shift() ?? [] }));
    return new Response('{}');
  }) as unknown as typeof fetch;
  const p = zulipPoller({ baseline: false, credentials, events: () => [], send, conversations: true, ambient: true, now: () => clock.at }, s => got.push(s));
  const msg = (id: number, sender_id: number, content: string, extra: Record<string, unknown> = {}) => ({ id, sender_id, sender_full_name: `user ${sender_id}`, type: 'stream', stream_id: 5, subject: 'plans', content, flags: [], ...extra });
  const poll = async (messages: unknown[] = []) => { clock.at += 30_000; pages.push(messages); await p.poll(); };

  // Talk that waits for its pause is shown as it reads when it is shown.
  await poll([msg(1, 7, 'which prot is it?')]);
  single.set(1, msg(1, 7, 'which port is it?', { last_edit_timestamp: 1 }));
  p.edited([1]);
  await poll(); await poll();
  expect(got).toHaveLength(1);
  expect(got[0]!.text).toContain('which port is it?');
  expect(got[0]!.text).not.toContain('prot');

  // A mention added afterwards addresses the agent now.
  await poll([msg(2, 8, 'does anyone know?')]);
  single.set(2, msg(2, 8, '@**Mica Teneral** do you know?', { flags: ['mentioned'] }));
  p.edited([2]);
  await poll();
  expect(got).toHaveLength(2);
  expect(got[1]!.text).toStartWith('Zulip mention 2\n');

  // The question it was woken for was changed: told as an edit, not as a new message.
  single.set(2, msg(2, 8, '@**Mica Teneral** do you know the port?', { flags: ['mentioned'], last_edit_timestamp: 2 }));
  p.edited([2]);
  await poll();
  expect(got).toHaveLength(3);
  expect(got[2]!.text).toStartWith('Zulip edit 2\n');
  expect(got[2]!.text).toContain('Its sender changed a message you were already shown');
  expect(got[2]!.text).toContain('do you know the port?');

  // Taken back before the pause: nothing left to wake for. An edit of a message that is gone tells nothing.
  await poll([msg(3, 7, 'oops wrong channel')]);
  p.deleted([3]);
  p.edited([404]);
  await poll(); await poll(); await poll();
  expect(got).toHaveLength(3);
});

test('the event queue is the bell: a message rings the poller, edits and deletions are handed over, and only a reaction is worth a checkpoint', async () => {
  const rung: string[] = [];
  const checkpoints: unknown[] = [];
  const asked: URL[] = [];
  const batches: unknown[][] = [
    [{ id: 1, type: 'message' }, { id: 2, type: 'heartbeat' }],
    [{ id: 3, type: 'update_message', message_id: 40 }, { id: 4, type: 'update_message', message_id: 41, rendering_only: true }, { id: 5, type: 'delete_message', message_ids: [42, 43] }],
    [{ id: 6, type: 'reaction', op: 'add', message_id: 40, user_id: 7, emoji_name: '+1', emoji_code: '1f44d', reaction_type: 'unicode_emoji' }],
  ];
  let first = true;
  const send = (async (url: URL, init: RequestInit = {}) => {
    asked.push(new URL(String(url)));
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({ user_id: 99 }));
    if (url.pathname === '/api/v1/register') {
      expect(new URLSearchParams(String(init.body)).get('event_types')).toBe('["reaction","message","update_message","delete_message","subscription"]');
      return new Response(JSON.stringify({ queue_id: 'q1', last_event_id: 0 }));
    }
    if (first) { first = false; return new Response(JSON.stringify({ events: [] })); }
    return new Response(JSON.stringify({ events: batches.shift() ?? [] }));
  }) as unknown as typeof fetch;
  const got: Stimulus[] = [];
  const q = zulipReactionPoller({ credentials, events: () => [], send, wide: true, block: true, checkpoint: c => { checkpoints.push(c); },
    on: { message: () => rung.push('message'), edited: ids => rung.push(`edited ${ids}`), deleted: ids => rung.push(`deleted ${ids}`) } }, s => got.push(s));
  // A new queue knows nothing of what was said while there was none: the messages are fetched from their own cursor.
  expect(await q.poll()).toBe(true);
  expect(rung).toEqual(['message']);
  expect(checkpoints).toHaveLength(1);
  expect(await q.poll()).toBe(true);
  expect(rung).toEqual(['message', 'message']);
  expect(await q.poll()).toBe(true);
  expect(rung.slice(2)).toEqual(['edited 40', 'deleted 42,43']);
  // Nothing of those is a reaction: no note is journaled for them.
  expect(checkpoints).toHaveLength(1);
  expect(await q.poll()).toBe(true);
  expect(got).toHaveLength(1);
  expect(checkpoints).toHaveLength(2);
  // It waits at the server, and asks on from the last event it saw.
  const events = asked.filter(u => u.pathname === '/api/v1/events');
  expect(events.at(-1)!.searchParams.get('dont_block')).toBeNull();
  expect(events.at(-1)!.searchParams.get('last_event_id')).toBe('5');
  // No credentials, or a failure: false, so that the caller waits before asking again.
  expect(await zulipReactionPoller({ credentials: () => undefined, events: () => [], send }, () => {}).poll()).toBe(false);
});

test('a connection that was down for a while is said to the agent once, with its next wake', async () => {
  const c = live();
  let down = true;
  const got: Stimulus[] = [];
  const clock = { at: 1_800_000_000_000 };
  const pages: unknown[][] = [];
  const send = (async (url: URL) => {
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({ user_id: 99, full_name: 'Mica' }));
    if (down) return new Response('{}', { status: 502 });
    return new Response(JSON.stringify({ messages: pages.shift() ?? [] }));
  }) as unknown as typeof fetch;
  const p = zulipPoller({ baseline: false, credentials, events: () => [], send, now: () => clock.at }, s => got.push(s));
  for (let i = 0; i < 4; i++) { clock.at += 60_000; await p.poll(); }
  down = false;
  clock.at += 60_000;
  pages.push([{ id: 9, sender_id: 7, type: 'private', content: 'are you there?' }]);
  await p.poll();
  // Heard in the same poll that found the connection back, so it is told with the one after.
  pages.push([{ id: 10, sender_id: 7, type: 'private', content: 'hello?' }]);
  await p.poll();
  expect(got).toHaveLength(2);
  expect(got[1]!.text).toContain('The connection to Zulip was down for about 4 minutes');
  pages.push([{ id: 11, sender_id: 7, type: 'private', content: 'ok' }]);
  await p.poll();
  expect(got[2]!.text).not.toContain('was down');
  expect(c.got).toHaveLength(0);
});

test('the first message from a stream brings its roster with it, once, and a roster that cannot be had holds nothing up', async () => {
  const got: Stimulus[] = [];
  const heard: string[] = [];
  const pages: unknown[][] = [];
  const send = (async (url: URL) => {
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({ user_id: 99, full_name: 'Mica' }));
    if (url.pathname === '/api/v1/users') return new Response(JSON.stringify({ members: [{ user_id: 7, full_name: 'Ann Lee', is_bot: false }, { user_id: 50, full_name: 'CI', is_bot: true }, { user_id: 99, full_name: 'Mica', is_bot: false }] }));
    if (url.pathname === '/api/v1/streams/5/members') return new Response(JSON.stringify({ subscribers: [7, 50, 99, 1234] }));
    if (url.pathname === '/api/v1/streams/6/members') return new Response('{}', { status: 403 });
    if (url.pathname === '/api/v1/messages') return new Response(JSON.stringify({ messages: pages.shift() ?? [] }));
    return new Response('{}');
  }) as unknown as typeof fetch;
  const p = zulipPoller({ baseline: false, credentials, events: () => [], send, conversations: true,
    entered: (stream, members) => { heard.push(`${stream.name} ${JSON.stringify(members)}`); return members === null ? '' : `This is the first you hear from ${stream.name}.`; } }, s => got.push(s));
  const msg = (id: number, stream_id: number, name: string) => ({ id, sender_id: 7, sender_full_name: 'Ann Lee', type: 'stream', stream_id, display_recipient: name, subject: 't', content: '@**Mica** hello', flags: ['mentioned'] });
  pages.push([msg(1, 5, 'engineering'), msg(2, 5, 'engineering'), msg(3, 6, 'private-ish')]);
  await p.poll();
  // The agent itself is not among those it shares the stream with; someone the directory does not list is named by id.
  expect(heard).toEqual(['#engineering [{"id":"7","name":"Ann Lee","bot":false},{"id":"50","name":"CI","bot":true},{"id":"1234","name":"user 1234"}]', '#private-ish null']);
  expect(got).toHaveLength(3);
  expect(got[0]!.text).toContain('This is the first you hear from #engineering.');
  expect(got[1]!.text).not.toContain('first you hear');
  expect(got[2]!.text).toContain('@**Mica** hello');
});

test('a queue registered for reactions alone is not taken up as the bell: after such a restart a new one is registered', async () => {
  const narrow = { type: 'note', kind: ZULIP_QUEUE_CURSOR_KIND, data: { queueId: 'old', eventId: 4, site: 'https://example.test', email: 'mica@test' } } as JournalEvent;
  const registered: string[] = [];
  const send = (async (url: URL) => {
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({ user_id: 99 }));
    if (url.pathname === '/api/v1/register') { registered.push('new'); return new Response(JSON.stringify({ queue_id: 'new', last_event_id: -1 })); }
    return new Response(JSON.stringify({ events: [] }));
  }) as unknown as typeof fetch;
  const kept: ZulipQueueCursor[] = [];
  const wide = zulipReactionPoller({ credentials, events: () => [narrow], send, wide: true, checkpoint: c => { kept.push(c); } }, () => {});
  await wide.poll();
  expect(registered).toEqual(['new']);
  expect(kept[0]).toMatchObject({ queueId: 'new', wide: true });
  // And the other way round: one that carries only reactions goes on with its own queue, and a wide one with a wide one.
  const again = zulipReactionPoller({ credentials, events: () => [narrow], send }, () => {});
  await again.poll();
  expect(registered).toEqual(['new']);
  const resumed = zulipReactionPoller({ credentials, events: () => [{ ...narrow, data: kept[0] } as JournalEvent], send, wide: true }, () => {});
  await resumed.poll();
  expect(registered).toEqual(['new']);
});

test('a queue bell while a fetch is busy is run after it, without overlapping requests', async () => {
  const got: Stimulus[] = [];
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  let reads = 0, concurrent = 0;
  const send = (async (url: URL) => {
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({ user_id: 99, full_name: 'Mica' }));
    if (url.pathname === '/api/v1/messages') {
      reads++;
      concurrent++;
      expect(concurrent).toBe(1);
      if (reads === 1) await first;
      concurrent--;
      return new Response(JSON.stringify({ messages: reads === 1 ? [] : [{ id: reads - 1, sender_id: 7, sender_full_name: 'Ann', type: 'private', content: 'hello', flags: [] }] }));
    }
    throw Error(`unexpected ${url.pathname}`);
  }) as unknown as typeof fetch;
  const p = zulipPoller({ baseline: false, credentials, events: () => [], send }, s => got.push(s));
  const running = p.poll();
  await Bun.sleep(0);
  expect(reads).toBe(1);
  // Any number of bells while busy coalesce into exactly one follow-up fetch.
  await Promise.all([p.poll(), p.poll(), p.poll()]);
  expect(reads).toBe(1);
  release();
  await running;
  for (let n = 0; n < 100 && got.length === 0; n++) await Bun.sleep(1);
  expect(reads).toBe(2);
  expect(got.map(s => s.text.split('\n', 1)[0])).toEqual(['Zulip private 1']);
  p.stop();
});

test('stopping the queue aborts its in-flight long poll and does not log a connection failure', async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    let signal: AbortSignal | undefined;
    const send = (async (url: URL, init: RequestInit = {}) => {
      if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({ user_id: 99 }));
      if (url.pathname === '/api/v1/register') return new Response(JSON.stringify({ queue_id: 'q', last_event_id: 0 }));
      if (url.searchParams.get('dont_block') === 'true') return new Response(JSON.stringify({ events: [] }));
      signal = init.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }) as unknown as typeof fetch;
    const q = zulipReactionPoller({ credentials, events: () => [], send, wide: true, block: true }, () => {});
    await q.poll();
    const waiting = q.poll();
    for (let n = 0; n < 100 && signal === undefined; n++) await Bun.sleep(1);
    q.stop();
    expect(await waiting).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(errors).toEqual([]);
  } finally { console.error = original; }
});

test('queue failures back off and recovery is observable without ids, credentials or message contents', async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    let calls = 0;
    const send = (async (url: URL) => {
      if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({ user_id: 99 }));
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ queue_id: 'q', last_event_id: 0 }));
      if (calls === 2) return new Response(JSON.stringify({ events: [] }));
      if (calls === 3) return new Response('{}', { status: 502 });
      return new Response(JSON.stringify({ events: [] }));
    }) as unknown as typeof fetch;
    const q = zulipReactionPoller({ credentials, events: () => [], send, wide: true, block: true }, () => {});
    expect(await q.poll()).toBe(true); // registered
    expect(await q.poll()).toBe(false); // one failure: caller backs off
    expect(await q.poll()).toBe(true); // recovery
    expect(errors.some(line => line.includes('reaction queue failed'))).toBe(true);
    expect(errors.some(line => line.includes('event queue connected again'))).toBe(true);
    expect(errors.join('\n')).not.toContain('fake');
    q.stop();
  } finally { console.error = original; }
});

test('each direct conversation is a place of its own, by who is in it besides the agent, and every message taken is reported for the record', async () => {
  const heard: string[] = [];
  const pages: unknown[][] = [[
    { id: 1, sender_id: 7, sender_full_name: 'Ann', type: 'private', content: 'hi', display_recipient: [{ id: 99 }, { id: 7 }] },
    { id: 2, sender_id: 99, sender_full_name: 'Mica', type: 'private', content: 'hello', display_recipient: [{ id: 99 }, { id: 7 }] },
    { id: 3, sender_id: 8, sender_full_name: 'Bo', type: 'private', content: 'hey', display_recipient: [{ id: 8 }, { id: 99 }, { id: 7 }] },
  ]];
  const send = (async (url: URL) => {
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({ user_id: 99, full_name: 'Mica' }));
    return new Response(JSON.stringify({ messages: pages.shift() ?? [] }));
  }) as unknown as typeof fetch;
  const p = zulipPoller({ baseline: false, credentials, events: () => [], send, heard: (m, how) => heard.push(`${m.sender?.name} in ${m.place}: ${how}`) }, () => {});
  await p.poll();
  expect(heard).toEqual(['Ann in dm:7: dm', 'Mica in dm:7: own', 'Bo in dm:7,8: dm']);
});


test('a subscription the event queue tells of reaches the poller, which wakes the agent for the new stream with its roster', async () => {
  const told: unknown[] = [];
  const batches: unknown[][] = [[{ id: 1, type: 'subscription', op: 'add', subscriptions: [{ stream_id: 5, name: 'project' }] }, { id: 2, type: 'subscription', op: 'peer_add', stream_ids: [5] }]];
  let first = true;
  const qsend = (async (url: URL) => {
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({ user_id: 99 }));
    if (url.pathname === '/api/v1/register') return new Response(JSON.stringify({ queue_id: 'q', last_event_id: 0 }));
    if (first) { first = false; return new Response(JSON.stringify({ events: [] })); }
    return new Response(JSON.stringify({ events: batches.shift() ?? [] }));
  }) as unknown as typeof fetch;
  const q = zulipReactionPoller({ credentials, events: () => [], send: qsend, wide: true, on: { message: () => {}, edited: () => {}, deleted: () => {}, joined: (streams) => told.push(...streams) } }, () => {});
  await q.poll(); await q.poll();
  expect(told).toEqual([{ id: '5', name: '#project' }]);

  const got: Stimulus[] = [];
  const send = (async (url: URL) => {
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({ user_id: 99, full_name: 'Mica' }));
    if (url.pathname === '/api/v1/users') return new Response(JSON.stringify({ members: [{ user_id: 7, full_name: 'Ann Lee', is_bot: false }] }));
    if (url.pathname === '/api/v1/streams/5/members') return new Response(JSON.stringify({ subscribers: [7, 99] }));
    return new Response(JSON.stringify({ messages: [] }));
  }) as unknown as typeof fetch;
  const p = zulipPoller({ baseline: false, credentials, events: () => [], send, conversations: true, entered: (stream, members) => `This is the first you hear from ${stream.name}. There with you: ${members?.map((m) => m.name).join(', ')}.` }, s => got.push(s));
  p.joined([{ id: '5', name: '#project' }]);
  await p.poll();
  expect(got).toHaveLength(1);
  expect(got[0]!.text).toStartWith('Zulip joined 5\nYou were added to #project on Zulip.');
  expect(got[0]!.text).toContain('There with you: Ann Lee.');
  await p.poll();
  expect(got).toHaveLength(1);
});

test('a hung poll pass releases the busy latch so the sensor retries instead of going silent', async () => {
  // The whole point of the watchdog: an await inside poll() that never resolves (here the page
  // fetch hangs) must not leave `busy` latched, or every later interval returns early and the
  // sensor silently stops delivering. With a short test deadline the latch is force-released and
  // a subsequent healthy poll fetches and emits again.
  const notices: Stimulus[] = [];
  let hang = true, pageFetches = 0;
  const send = (async (url: URL) => {
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({ user_id: 99 }));
    if (hang) return new Promise<Response>(() => {}); // never resolves
    pageFetches++;
    return new Response(JSON.stringify({ messages: [{ id: 7, content: 'late hello', type: 'private' }] }));
  }) as unknown as typeof fetch;
  const p = zulipPoller({ baseline: false, credentials, events: () => [], send, pollDeadlineMs: 5 }, s => notices.push(s));
  // First pass hangs on the page fetch; its watchdog force-releases the busy latch.
  const hung = p.poll();
  await new Promise(r => setTimeout(r, 20)); // let the 5ms watchdog fire and release busy
  hang = false; // from here the page fetch is healthy
  await p.poll(); // busy is now free, so this fetches and emits instead of early-returning
  expect(pageFetches).toBeGreaterThan(0);
  expect(notices).toHaveLength(1);
  expect(notices[0].text).toStartWith('Zulip private 7\n');
  await Promise.race([hung, new Promise(r => setTimeout(r, 50))]); // let the hung pass settle
  p.stop();
});

async function stalledOwnerPass(recoveryHasMessage: boolean) {
  const got: Stimulus[] = [];
  const anchors: string[] = [];
  let release!: () => void;
  const firstRendered = new Promise<void>(resolve => { release = resolve; });
  let page = 0, rendered = 0;
  const send = (async (url: URL) => {
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({ user_id: 99 }));
    if (url.pathname === '/api/v1/messages/7') {
      if (++rendered === 1) await firstRendered;
      return new Response(JSON.stringify({ message: { id: 7, content: 'owner DM' } }));
    }
    if (url.pathname === '/api/v1/messages') {
      anchors.push(url.searchParams.get('anchor')!);
      page++;
      const owner = { id: 7, sender_id: 100, sender_full_name: 'Owner', type: 'private', content: 'owner DM' };
      return new Response(JSON.stringify({ messages: page === 1 || (page === 2 && recoveryHasMessage) ? [owner] : [] }));
    }
    throw Error(`unexpected ${url.pathname}`);
  }) as unknown as typeof fetch;
  const p = zulipPoller({ baseline: false, credentials, events: () => [], send, ownerId: 100, keepImage: () => '', pollDeadlineMs: 5 }, s => got.push(s));
  const stalled = p.poll();
  for (let n = 0; n < 200 && rendered === 0; n++) await Bun.sleep(1);
  expect(rendered).toBe(1); // the first pass is suspended before emit and cursor advancement
  await Bun.sleep(20); // the watchdog releases busy and invalidates that pass
  await p.poll();
  release(); // the stale pass resumes only after recovery has finished
  await stalled;
  await Bun.sleep(10);
  const delivered = got.map(s => s.text.split('\n', 1)[0]);
  p.stop();
  return { anchors, delivered };
}

test('a watchdog-expired pass cannot deliver an owner DM a second time after its recovery', async () => {
  const r = await stalledOwnerPass(true);
  expect(r.anchors).toEqual(['newest', 'newest']);
  expect(r.delivered).toEqual(['Zulip private 7']);
});

test('a stale pass finishing does not release the latch under the running recovery', async () => {
  const got: Stimulus[] = [];
  let page = 0;
  let releaseFirst!: () => void, releaseSecond!: () => void;
  const first = new Promise<void>(r => { releaseFirst = r; });
  const second = new Promise<void>(r => { releaseSecond = r; });
  const send = (async (url: URL) => {
    if (url.pathname === '/api/v1/users/me') return new Response(JSON.stringify({ user_id: 99 }));
    if (url.pathname === '/api/v1/messages') {
      page++;
      if (page === 1) await first; else if (page === 2) await second;
      return new Response(JSON.stringify({ messages: [] }));
    }
    throw Error(`unexpected ${url.pathname}`);
  }) as unknown as typeof fetch;
  const p = zulipPoller({ baseline: false, credentials, events: () => [], send, ownerId: 100, keepImage: () => '', pollDeadlineMs: 60 }, s => got.push(s));
  const pass1 = p.poll();
  for (let n = 0; n < 200 && page < 1; n++) await Bun.sleep(1);
  await Bun.sleep(90);              // the watchdog expires pass 1
  const pass2 = p.poll();           // the recovery starts and stalls
  for (let n = 0; n < 200 && page < 2; n++) await Bun.sleep(1);
  releaseFirst(); await pass1;      // the stale pass finishes while the recovery runs
  const pass3 = p.poll();           // must coalesce into the recovery
  await Bun.sleep(5);
  const pages = page;
  releaseSecond(); await pass2; await pass3; await Bun.sleep(10);
  p.stop();
  expect(pages).toBe(2);
});
