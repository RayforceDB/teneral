import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { appendEvent, readEvents, type JournalEvent } from '../brain/journal';
import type { Sensor } from './sensors';

/** A surviving process group created by one bash call. Notes are the durable registry. */
export const JOB_KIND = 'body.job.v1';

export interface JobMember {
  pid: number;
  /** Linux /proc starttime, kept as a string: PID alone is reusable. */
  started: string;
}

export interface JobRecord {
  name: string;
  gen: string;
  pgid: number;
  cwd: string;
  command: string;
  members: JobMember[];
  state: 'running' | 'stopped';
  reason?: string;
}

export function jobName(value: string | undefined): string {
  const name = value?.trim() || `bash-${randomUUID().slice(0, 8)}`;
  if (!/^[a-z0-9][a-z0-9._-]{0,47}$/.test(name)) throw new Error('job name must be 1–48 characters: a-z, 0-9, dot, underscore or dash');
  return name;
}

function member(pid: number): (JobMember & { pgid: number; zombie: boolean }) | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    // After comm: state, ppid, pgrp … starttime is field 22, hence index 19 here.
    const fields = stat.slice(close + 1).trim().split(/\s+/);
    const pgid = Number(fields[2]);
    const started = fields[19];
    if (!Number.isSafeInteger(pgid) || pgid <= 0 || !started || !/^\d+$/.test(started)) return null;
    return { pid, started, pgid, zombie: fields[0] === 'Z' };
  } catch {
    return null;
  }
}

/** All non-zombie members of a group, with identities that survive a restart. */
export function groupMembers(pgid: number): JobMember[] {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return [];
  let names: string[];
  try { names = readdirSync('/proc'); } catch { return []; }
  const found: JobMember[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const p = member(Number(name));
    if (p !== null && !p.zombie && p.pgid === pgid) found.push({ pid: p.pid, started: p.started });
  }
  return found.sort((a, b) => a.pid - b.pid);
}

function record(value: unknown): JobRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const j = value as Partial<JobRecord>;
  if (typeof j.name !== 'string' || typeof j.gen !== 'string' || !Number.isSafeInteger(j.pgid) || (j.pgid ?? 0) <= 0
    || typeof j.cwd !== 'string' || typeof j.command !== 'string' || !Array.isArray(j.members)
    || (j.state !== 'running' && j.state !== 'stopped')) return null;
  const members = j.members.filter((m): m is JobMember => typeof m === 'object' && m !== null
    && Number.isSafeInteger((m as JobMember).pid) && (m as JobMember).pid > 0
    && typeof (m as JobMember).started === 'string' && /^\d+$/.test((m as JobMember).started));
  return { name: j.name, gen: j.gen, pgid: j.pgid!, cwd: j.cwd, command: j.command, members, state: j.state, ...(typeof j.reason === 'string' ? { reason: j.reason } : {}) };
}

export function jobHistory(events: JournalEvent[]): Map<string, JobRecord> {
  const jobs = new Map<string, JobRecord>();
  for (const e of events) {
    if (e.type !== 'note' || e.kind !== JOB_KIND) continue;
    const j = record(e.data);
    if (j !== null) jobs.set(j.name, j);
  }
  return jobs;
}

/** Register only survivors. The command's own bash is normally gone by now. */
export function trackBackground(journal: string, gen: string, name: string, pgid: number, cwd: string, command: string): JobRecord | null {
  const members = groupMembers(pgid);
  if (members.length === 0) return null;
  const job: JobRecord = { name, gen, pgid, cwd, command: command.slice(0, 500), members, state: 'running' };
  appendEvent(journal, gen, { type: 'note', kind: JOB_KIND, data: job });
  return job;
}

function sameMember(a: JobMember, b: JobMember): boolean {
  return a.pid === b.pid && a.started === b.started;
}

/** A PGID is safe to signal only while at least one originally recorded member still proves its identity. */
function verified(job: JobRecord): boolean {
  const now = groupMembers(job.pgid);
  return job.members.some((old) => now.some((p) => sameMember(old, p)));
}

export function jobStatus(job: JobRecord): 'running' | 'stopped' | 'gone' | 'unverified' {
  if (job.state === 'stopped') return 'stopped';
  const members = groupMembers(job.pgid);
  if (members.length === 0) return 'gone';
  return verified(job) ? 'running' : 'unverified';
}

function stop(journal: string, gen: string, job: JobRecord, reason: string): string {
  if (job.state === 'stopped') return 'stopped';
  const status = jobStatus(job);
  if (status === 'running') {
    try { process.kill(-job.pgid, 'SIGKILL'); } catch { /* it exited between verification and kill */ }
  } else if (status === 'unverified') {
    // Never signal a reused or otherwise unproven group. Keep the record open for inspection.
    return 'unverified';
  }
  appendEvent(journal, gen, { type: 'note', kind: JOB_KIND, data: { ...job, state: 'stopped', reason: status === 'gone' ? 'gone' : reason } });
  return status === 'gone' ? 'gone' : 'stopped';
}

export function stopJob(journal: string, gen: string, name: string): string {
  const job = jobHistory(readRegistry(journal)).get(name);
  if (job === undefined) throw new Error(`unknown background job: ${name}`);
  return stop(journal, gen, job, 'requested');
}

function readRegistry(journal: string): JournalEvent[] {
  return readEvents(journal);
}

export function listJobs(events: JournalEvent[]): string {
  const jobs = [...jobHistory(events).values()];
  if (jobs.length === 0) return 'No background jobs recorded.';
  return jobs.map((j) => `${j.name}: ${jobStatus(j)}; generation ${j.gen}; pgid ${j.pgid}; ${j.command}`).join('\n');
}

/** Called before a new generation starts any work. Same-generation restarts retain manageable jobs. */
export function stopPreviousJobs(journal: string, gen: string): string[] {
  const stopped: string[] = [];
  for (const job of jobHistory(readRegistry(journal)).values()) {
    if (job.gen === gen || job.state !== 'running') continue;
    const result = stop(journal, gen, job, 'generation-exit');
    if (result === 'stopped') stopped.push(job.name);
  }
  return stopped;
}

/** Normal process exits do not get a later generation to clean up after them. */
export function stopCurrentJobs(journal: string, gen: string): void {
  for (const job of jobHistory(readRegistry(journal)).values()) {
    if (job.gen === gen && job.state === 'running') stop(journal, gen, job, 'process-exit');
  }
}

/** What the agent is told when a job it left running has ended. It reads as the work sensor's other wakes do. */
export function endedText(job: Pick<JobRecord, 'name' | 'command'>): string {
  return `The background job ${job.name} that you left running has ended. It ran: ${job.command}\nNothing told you how it went: look once at what it left (its exit status, its log), then go on with what waited for it and record the state with work. If you told someone it was running, or that you would say how it went, tell them now, in the place where you said it. If you already have its result and have said it, there is nothing to do.`;
}

/**
 * Wakes the agent when a job of this generation that it left running has ended. Without this an
 * agent that says "the tests are running" and ends its turn hears nothing of them until a time it
 * set itself, or the clock's next tick. While a turn runs nothing is said: the agent may be
 * waiting for the job in that very turn; it is told when the turn is over. The record is closed
 * in the journal before the agent is told, so a job is told once, whatever happens after.
 */
export function endedJobs(journal: string, gen: string, busy: () => boolean, intervalMs = 2000, read: () => JournalEvent[] = () => readEvents(journal)): Sensor {
  return (emit) => {
    const timer = setInterval(() => {
      try {
        if (busy()) return;
        for (const job of jobHistory(read()).values()) {
          if (job.gen !== gen || job.state !== 'running' || jobStatus(job) !== 'gone') continue;
          appendEvent(journal, gen, { type: 'note', kind: JOB_KIND, data: { ...job, state: 'stopped', reason: 'ended' } });
          emit({ source: 'work', text: endedText(job) });
          // One at a time: the next is told after the turn this one starts.
          return;
        }
      } catch { console.error('[jobs] Could not look at the background jobs; will retry.'); }
    }, intervalMs);
    return () => clearInterval(timer);
  };
}
