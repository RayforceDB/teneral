import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The individual's signing key: one ed25519 SSH key, made once and kept beside the other
// credentials in the auth directory, readable only by the owner. What it offers to the species is
// signed with it: the commits (git's own SSH signatures, `gpg.format=ssh`) and the text of a
// witness report. `ssh-keygen` does all of it; nothing here implements a signature.
//
// What a signature by this key says: this came from this individual's install. Nothing more. The
// agent has a shell where the key lies, so the key cannot say that the content is safe, or that
// the owner looked at it.

/** The private key's file in the auth directory; the public one is beside it with `.pub`. */
export const KEY_FILE = 'offer-key';
/** The namespace git signs commits in, and the one a witness report is signed in. */
export const GIT_NAMESPACE = 'git';
export const WITNESS_NAMESPACE = 'teneral-witness';

export interface Ran { code: number; stdout: Buffer; stderr: string }

/** One program, with what it is given on stdin, in this process's environment unless `env` gives another. */
export function run(cmd: string[], o: { cwd?: string; stdin?: Buffer | string; env?: Record<string, string | undefined>; timeoutMs?: number } = {}): Ran {
  let p: ReturnType<typeof Bun.spawnSync>;
  try {
    p = Bun.spawnSync(cmd, {
      cwd: o.cwd, stdin: o.stdin === undefined ? 'ignore' : Buffer.from(o.stdin), stdout: 'pipe', stderr: 'pipe',
      timeout: o.timeoutMs ?? 600_000, ...(o.env ? { env: o.env } : {}),
    });
  } catch (err) {
    // A program that is not installed: said as a failure of the command, not thrown from the middle of something.
    return { code: 127, stdout: Buffer.alloc(0), stderr: `could not run ${cmd[0]}: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { code: p.exitCode ?? 1, stdout: Buffer.from(p.stdout ?? ''), stderr: (p.stderr ?? '').toString() };
}

function must(what: string, r: Ran): Buffer {
  if (r.code !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout.toString()).trim()}`);
  return r.stdout;
}

export interface Key {
  /** The private key's file. Its content is never read here. */
  file: string;
  /** The public key as one line: `ssh-ed25519 AAAA... teneral <id>`. */
  public: string;
  /** `SHA256:...`, as ssh-keygen names the key. */
  fingerprint: string;
}

/** `SHA256:...` of the public key in `file`. */
function fingerprintOf(file: string): string {
  const said = must('ssh-keygen -l', run(['ssh-keygen', '-l', '-E', 'sha256', '-f', file])).toString();
  const found = /\b(SHA256:[A-Za-z0-9+/]+)/.exec(said);
  if (!found) throw new Error(`ssh-keygen gave no fingerprint for ${file}`);
  return found[1]!;
}

/** The key that is there, or null when there is none yet. Throws for one that is half there or cannot be read. */
export function readKey(auth: string): Key | null {
  const file = join(auth, KEY_FILE);
  if (!existsSync(file) && !existsSync(`${file}.pub`)) return null;
  if (!existsSync(file) || !existsSync(`${file}.pub`)) {
    throw new Error(`${file} and ${file}.pub belong together and one of them is missing; put it back, or remove the other for a new key (which the maintainer does not know yet)`);
  }
  return { file, public: readFileSync(`${file}.pub`, 'utf8').trim(), fingerprint: fingerprintOf(`${file}.pub`) };
}

/**
 * The individual's key, made now if there is none. Made aside and moved into place, private half
 * first, so a key that is there is a whole one; one that is there is never replaced.
 */
export function ensureKey(auth: string, id: string): Key {
  const known = readKey(auth);
  if (known !== null) return known;
  mkdirSync(auth, { recursive: true, mode: 0o700 });
  const aside = mkdtempSync(join(auth, '.offer-key-'));
  try {
    const made = join(aside, 'key');
    must('ssh-keygen', run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', `teneral ${id}`, '-f', made]));
    chmodSync(made, 0o600);
    const file = join(auth, KEY_FILE);
    renameSync(made, file);
    renameSync(`${made}.pub`, `${file}.pub`);
  } finally {
    rmSync(aside, { recursive: true, force: true });
  }
  return readKey(auth)!;
}

/** A detached, armored signature of `text` by `key`, in `namespace`. */
export function signText(key: Key, namespace: string, text: string): string {
  return must('ssh-keygen -Y sign', run(['ssh-keygen', '-Y', 'sign', '-q', '-f', key.file, '-n', namespace], { stdin: text })).toString();
}

/**
 * The fingerprint of the key that made `signature` over exactly `text` in `namespace`, or null when
 * the signature does not hold. It says which key signed, never whose key that is: no list of
 * known keys is consulted here.
 */
export function signerOf(namespace: string, text: Buffer | string, signature: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'teneral-sig-'));
  try {
    const file = join(dir, 'sig');
    writeFileSync(file, signature);
    const r = run(['ssh-keygen', '-Y', 'check-novalidate', '-n', namespace, '-s', file], { stdin: text });
    if (r.code !== 0) return null;
    return /\b(SHA256:[A-Za-z0-9+/]+)/.exec(r.stdout.toString() + r.stderr)?.[1] ?? null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A commit taken apart: its header lines, its message, and its signature if it carries one. */
function parts(dir: string, commit: string): { payload: Buffer; signature: string | null; message: string } {
  // Bytes, not text: the signature is over the object exactly as it is stored, less the signature itself.
  const raw = must('git cat-file', run(['git', 'cat-file', 'commit', commit], { cwd: dir })).toString('latin1');
  const end = raw.indexOf('\n\n');
  const head = (end === -1 ? raw : raw.slice(0, end)).split('\n');
  const rest = end === -1 ? '' : raw.slice(end);
  const kept: string[] = [];
  const sig: string[] = [];
  let inSig = false;
  for (const line of head) {
    if (line.startsWith('gpgsig ')) {
      inSig = true;
      sig.push(line.slice('gpgsig '.length));
    } else if (inSig && line.startsWith(' ')) {
      sig.push(line.slice(1));
    } else {
      inSig = false;
      kept.push(line);
    }
  }
  return {
    payload: Buffer.from(kept.join('\n') + rest, 'latin1'),
    signature: sig.length > 0 ? `${sig.join('\n')}\n` : null,
    message: Buffer.from(rest.slice(2), 'latin1').toString('utf8'),
  };
}

/** The fingerprint of the SSH key whose signature `commit` carries and which holds; null for none, or one that does not hold. */
export function commitSigner(dir: string, commit: string): string | null {
  const { payload, signature } = parts(dir, commit);
  if (signature === null || !signature.includes('BEGIN SSH SIGNATURE')) return null;
  return signerOf(GIT_NAMESPACE, payload, signature);
}

const text = (dir: string, ...args: string[]): string => must(`git ${args[0]}`, run(['git', ...args], { cwd: dir })).toString().trim();

/**
 * Sign the commits of `tip` that `base` does not have, with `key`: each is written again with the
 * same tree, author, date and message, on the signed copy of its parents, and the name of the new
 * tip is returned. A commit this key already signed, on parents that did not change, is kept. The
 * committer becomes whoever git is configured as here.
 */
export function signCommits(dir: string, base: string, tip: string, key: Key): string {
  const range = text(dir, 'rev-list', '--reverse', '--topo-order', '--parents', `${base}..${tip}`).split('\n').filter(Boolean);
  const copy = new Map<string, string>();
  let last = text(dir, 'rev-parse', '--verify', `${tip}^{commit}`);
  for (const line of range) {
    const [commit = '', ...parents] = line.split(' ');
    const onto = parents.map((p) => copy.get(p) ?? p);
    if (onto.every((p, i) => p === parents[i]) && commitSigner(dir, commit) === key.fingerprint) {
      copy.set(commit, commit);
    } else {
      const [name = '', email = '', date = ''] = text(dir, 'show', '-s', '--format=%an%n%ae%n%aI', commit).split('\n');
      const made = must('git commit-tree', run(
        ['git', '-c', 'gpg.format=ssh', '-c', `user.signingkey=${key.file}`, 'commit-tree', '-S', ...onto.flatMap((p) => ['-p', p]), text(dir, 'rev-parse', `${commit}^{tree}`)],
        { cwd: dir, stdin: parts(dir, commit).message, env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date } },
      )).toString().trim();
      copy.set(commit, made);
    }
    last = copy.get(commit)!;
  }
  return last;
}
