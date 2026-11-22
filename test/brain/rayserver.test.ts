import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendEvent, readEvents } from '../../brain/journal';
import { EPISODE_KIND } from '../../brain/remembered';
import { endStale, pidFile, serverAt, startRayServer } from '../../brain/rayserver';
import { library } from './rayforce';

const dir = (name: string): string => mkdtempSync(join(tmpdir(), `teneral-rayserver-${name}-`));
const BRAIN = join(import.meta.dir, '..', '..', 'brain');
/** The program of the pinned build lies beside its library. */
const program = library === null ? null : join(dirname(library), 'rayforce');
const real = library !== null && program !== null && existsSync(program);

/** A program that takes the server's arguments and accepts connections on the port it is given, as the database's does. */
function standIn(): string {
  const at = dir('stand-in');
  writeFileSync(join(at, 'serve.ts'), "const port = Number(process.argv[process.argv.indexOf('--port') + 1]!.split(':')[1]);\nBun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } });\nawait new Promise(() => {});\n");
  writeFileSync(join(at, 'server'), `#!/bin/sh\nexec ${process.execPath} ${join(at, 'serve.ts')} "$@"\n`);
  chmodSync(join(at, 'server'), 0o755);
  return join(at, 'server');
}

test('the server\'s program lies beside the library, and its process number beside the journal', () => {
  expect(serverAt('/organs')).toBe('/organs/rayforce/rayforce');
  expect(pidFile('/install/memory/journal.jsonl')).toBe('/install/memory/rayforce.pid');
});

test('a server is started on a port of this machine, is known by its process, and is gone when stopped', async () => {
  const journal = join(dir('journal'), 'memory', 'journal.jsonl');
  const logs: string[] = [];
  const server = await startRayServer(standIn(), journal, { log: (line) => logs.push(line) });
  expect(server.port).toBeGreaterThan(1023);
  expect(server.alive()).toBe(true);
  expect(readFileSync(pidFile(journal), 'utf8')).toBe(`${server.pid}\n`);
  expect(logs).toEqual([`[memory] the database runs in a process of its own (${server.pid}), on port ${server.port}`]);
  server.stop();
  await Bun.sleep(100);
  expect(server.alive()).toBe(false);
  expect(existsSync(pidFile(journal))).toBe(false);
  // Stopping what is stopped is nothing.
  server.stop();
});

test('a program that is not there, ends at once, or never listens is an error said in words, and leaves nothing behind', async () => {
  const journal = join(dir('journal'), 'journal.jsonl');
  await expect(startRayServer('/no/such/rayforce', journal)).rejects.toThrow("the database's program is not at /no/such/rayforce");
  await expect(startRayServer('/bin/false', journal)).rejects.toThrow("the database's server ended as soon as it was started");
  const deaf = join(dir('deaf'), 'server');
  writeFileSync(deaf, '#!/bin/sh\nexec sleep 30\n'); chmodSync(deaf, 0o755);
  await expect(startRayServer(deaf, journal, { waitMs: 300 })).rejects.toThrow('did not accept connections within 300 ms');
  expect(existsSync(pidFile(journal))).toBe(false);
});

test('a process number left behind is forgotten, and a process that is something else by now is left alone', () => {
  const journal = join(dir('journal'), 'journal.jsonl');
  // This very process, which was not started as the database's program.
  writeFileSync(pidFile(journal), `${process.pid}\n`);
  endStale(journal, '/organs/rayforce/rayforce');
  expect(existsSync(pidFile(journal))).toBe(false);
  for (const left of ['not a number\n', '1\n', '-5\n', '99999999\n']) {
    writeFileSync(pidFile(journal), left);
    endStale(journal, '/organs/rayforce/rayforce');
    expect(existsSync(pidFile(journal))).toBe(false);
  }
  endStale(journal, '/organs/rayforce/rayforce');
});

/** Runs `source` as a program of its own and gives back the lines it printed as JSON: the library has one runtime for a process, and this one's may be taken. */
async function alone(source: string): Promise<unknown[]> {
  const file = join(dir('alone'), 'run.ts');
  writeFileSync(file, source);
  const child = Bun.spawn([process.execPath, file], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, TENERAL_ORGANS: '' } });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if ((await child.exited) !== 0) throw new Error(`${err}\n${out}`);
  return out.split('\n').filter((line) => line.startsWith('{') || line.startsWith('[')).map((line) => JSON.parse(line) as unknown);
}

test.skipIf(!real)('as the client of a server, a query runs there: its result, its error, and source of any text come through whole', async () => {
  const journal = join(dir('journal'), 'journal.jsonl');
  const [answers] = await alone(`
import { openRay, RayError } from ${JSON.stringify(join(BRAIN, 'ray.ts'))};
import { startRayServer } from ${JSON.stringify(join(BRAIN, 'rayserver.ts'))};
const server = await startRayServer(${JSON.stringify(program)}, ${JSON.stringify(journal)});
const ray = openRay({ library: ${JSON.stringify(library)}, server: { port: server.port } });
const out: Record<string, unknown> = {};
out.sum = Number(ray.query('(+ 1 2)'));
// Quotes, a backslash and a line break in the source: it goes over as a value, so none of them ends anything.
out.text = ray.query('(count "a \\\\"quoted\\\\" back\\\\\\\\slash\\nline")');
ray.run('(set kept 41)');
out.kept = Number(ray.query('(+ kept 1)'));
// What is bound is bound there, and asked of there.
ray.bind('people', { name: { type: 'str', data: ['ann', 'bo', 'cy'] }, age: { type: 'i64', data: BigInt64Array.from([30n, 41n, 52n]) }, kind: { type: 'sym', data: ['a', 'b', 'a'] } });
const t = ray.table('(select {from: people where: (> age 35)})');
out.rows = t.rows; out.names = t.columns.name; out.kinds = t.columns.kind;
out.transport = ray.transport;
try { ray.query('(+ 1 no_such_name)'); out.error = 'none'; } catch (err) { out.error = err instanceof RayError ? err.code : String(err); }
// The server is ended under the client: what is asked next is an error of kind io, and this process goes on.
server.stop(); await Bun.sleep(200);
try { ray.query('(+ 1 2)'); out.gone = 'answered'; } catch (err) { out.gone = err instanceof RayError ? err.code : String(err); }
ray.close();
console.log(JSON.stringify(out, (_, v) => typeof v === 'bigint' ? Number(v) : v));
`) as [Record<string, unknown>];
  expect(answers.sum).toBe(3);
  expect(Number(answers.text)).toBe('a "quoted" back\\slash\nline'.length);
  expect(answers.kept).toBe(42);
  expect(answers).toMatchObject({ rows: 2, names: ['bo', 'cy'], kinds: ['b', 'a'], error: 'name', gone: 'io' });
  // On one machine the two speak through shared memory.
  expect(answers.transport).toBe('shm');
}, 60_000);

test.skipIf(!real)('a running agent\'s past is asked of the server, and of the journal from the moment the server is gone', async () => {
  const root = dir('install');
  const journal = join(root, 'memory', 'journal.jsonl');
  appendEvent(journal, 'g1', { type: 'stimulus', source: 'terminal', text: 'what about the parted average over symbols?' });
  const [first] = readEvents(journal);
  appendEvent(journal, 'g1', { type: 'note', kind: EPISODE_KIND, data: { from: first!.id, to: first!.id, start: first!.ts, end: first!.ts, title: 'Parted average', text: 'The parted average over a symbol column was wrong because the group map was built per part.', outcome: 'done' } });
  const lines = await alone(`
import { openServedPast } from ${JSON.stringify(join(BRAIN, 'past.ts'))};
import { readFileSync, existsSync } from 'node:fs';
const organs = ${JSON.stringify(dirname(dirname(library!)))};
const logs: string[] = [];
const past = await openServedPast(${JSON.stringify(journal)}, organs, (line) => logs.push(line));
const found = () => past.find('parted average symbol', { kinds: ['memory'], limit: 3 }).map((hit) => hit.event.type);
const out: Record<string, unknown> = { by: past.by, found: found(), ray: past.ray !== undefined };
const pid = Number(readFileSync(${JSON.stringify(pidFile(journal))}, 'utf8'));
out.server = readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\\0')[0];
process.kill(pid, 'SIGKILL'); await Bun.sleep(200);
out.after = { found: found(), by: past.by, ray: past.ray !== undefined };
past.sync(); past.persist();
past.close();
out.pidFile = existsSync(${JSON.stringify(pidFile(journal))});
out.logs = logs.map((line) => line.replace(/\\(\\d+\\), on port \\d+/, '(N), on port P'));
console.log(JSON.stringify(out));
`) as [Record<string, unknown>];
  expect(lines[0]).toEqual({
    by: 'store', found: ['note'], ray: true, server: program,
    // The same answer, by another road; the handle to the database is no longer handed out.
    after: { found: ['note'], by: 'journal', ray: false },
    pidFile: false,
    logs: [
      '[memory] the database runs in a process of its own (N), on port P',
      '[memory] the database is gone, the journal is read through from here on: rayforce: io: connection closed',
    ],
  });
  // What the server kept is beside the journal, to be found by the next body.
  expect(existsSync(join(root, 'memory', 'store-v1'))).toBe(true);
}, 60_000);

test.skipIf(!real)('a server an earlier body left running is ended before the next one is started', async () => {
  const journal = join(dir('journal'), 'journal.jsonl');
  const first = await startRayServer(program!, journal);
  // As after a body that was killed: its server runs on, and only the file knows of it.
  const second = await startRayServer(program!, journal);
  await Bun.sleep(100);
  expect(first.alive()).toBe(false);
  expect(second.alive()).toBe(true);
  expect(second.port).not.toBe(first.port);
  second.stop();
}, 30_000);

test('without the pinned build there is no server to start: the journal is read through', async () => {
  const { openServedPast } = await import('../../brain/past');
  const journal = join(dir('journal'), 'journal.jsonl');
  appendEvent(journal, 'g1', { type: 'stimulus', source: 'terminal', text: 'hello' });
  const none = await openServedPast(journal, null);
  expect(none.by).toBe('journal');
  const empty = await openServedPast(journal, dir('organs'));
  expect(empty.by).toBe('journal');
  expect(existsSync(pidFile(journal))).toBe(false);
});
