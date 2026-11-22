import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';

// The database in a process of its own. The agent's body starts it, is its client (brain/ray.ts),
// and stops it; nothing but the body speaks to it. It listens on this machine alone, on a port
// nobody else holds, and what it keeps is the store beside the journal (brain/store.ts), which is
// made from the journal and can be made again. So nothing of the agent's is in this process that
// is not also in its journal, and when the process dies the agent reads its journal through until
// it is started again.
//
// Why a process of its own: a fault in the database is then not a fault in the agent; a query
// blocks only the one who asked; and what the two exchange is the database's own protocol, which
// it keeps from build to build, not the layout of its values in memory, which it does not.

/** The program of the pinned build, beside its library: TENERAL_ORGANS holds one entry for each thing the brain or the body pins. */
export function serverAt(organsDir: string): string {
  return join(organsDir, 'rayforce', 'rayforce');
}

/** Where the number of a body's own server process is kept, so that the next body can end one that outlived its own. */
export function pidFile(journal: string): string {
  return join(dirname(journal), 'rayforce.pid');
}

export interface RayServer {
  port: number;
  pid: number;
  /** Whether the process is still there. */
  alive(): boolean;
  /** Ends it. Nothing is lost by that: the store is on disk, or is made again from the journal. */
  stop(): void;
}

/** A port on this machine that nobody listens on now. Another process could take it before the server does; the start then fails and says so. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port was given'))));
    });
  });
}

/** Whether something accepts connections at this port of this machine. */
async function accepts(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {}, error() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/** What a process was started as, or '' when there is no such process or it cannot be read. */
function commandOf(pid: number): string {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '); } catch { return ''; }
}

/**
 * Ends the server an earlier body of this journal left behind: one that was killed had no chance
 * to stop its own. Only a process that was started as this very program is ended; a number that
 * has gone to something else since is left alone.
 */
export function endStale(journal: string, program: string): void {
  const file = pidFile(journal);
  let pid = 0;
  try { pid = Number(readFileSync(file, 'utf8').trim()); } catch { return; }
  if (Number.isInteger(pid) && pid > 1 && commandOf(pid).startsWith(`${program} `)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone meanwhile */ }
  }
  rmSync(file, { force: true });
}

/**
 * Starts the database's server for the body of `journal` and returns once it accepts connections.
 * Throws when the program cannot be started or does not come up in `waitMs`.
 */
export async function startRayServer(program: string, journal: string, o: { cores?: number; waitMs?: number; log?: (line: string) => void } = {}): Promise<RayServer> {
  if (!existsSync(program)) throw new Error(`the database's program is not at ${program}`);
  endStale(journal, program);
  const port = await freePort();
  // On this machine alone, and with no terminal: it serves and does nothing else.
  const command = [program, '--port', `127.0.0.1:${port}`, '-c', String(Math.max(1, Math.floor(o.cores ?? 2)))];
  // It must not outlive the body that started it: a body that is killed, as one is at the end of a
  // smoke run, stops nothing itself. Where the system can tie a process's life to its parent's, it is asked to.
  const tied = Bun.which('setpriv');
  const child = Bun.spawn(tied === null ? command : [tied, '--pdeathsig', 'KILL', ...command], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  });
  // A body that has nothing left to do ends although its server still runs, and takes the server with it.
  child.unref();
  process.once('exit', () => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  let ended = false;
  void child.exited.then(() => { ended = true; });
  const stop = (): void => {
    if (!ended) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    rmSync(pidFile(journal), { force: true });
  };
  const deadline = Date.now() + (o.waitMs ?? 5_000);
  for (;;) {
    if (ended) throw new Error(`the database's server ended as soon as it was started (${program})`);
    if (await accepts(port)) break;
    if (Date.now() > deadline) { stop(); throw new Error(`the database's server did not accept connections within ${o.waitMs ?? 5_000} ms`); }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  mkdirSync(dirname(pidFile(journal)), { recursive: true });
  writeFileSync(pidFile(journal), `${child.pid}\n`);
  o.log?.(`[memory] the database runs in a process of its own (${child.pid}), on port ${port}`);
  return { port, pid: child.pid, alive: () => !ended, stop };
}
