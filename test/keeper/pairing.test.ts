import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPairing } from '../../body/pairing';
import { PAIRING_MS, newCode, pairingCommand, pairingLine } from '../../keeper/pairing';

const install = (services?: Record<string, string[]>): string => {
  const root = mkdtempSync(join(tmpdir(), 'pairing-'));
  mkdirSync(join(root, '.teneral', 'owner'), { recursive: true });
  if (services) writeFileSync(join(root, '.teneral', 'owners.json'), JSON.stringify({ services }));
  return root;
};
const left = (root: string): string[] => readdirSync(join(root, '.teneral', 'owner'));

test('a code is eight characters none of which is read as another', () => {
  for (let i = 0; i < 50; i++) expect(newCode()).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
});

test('/owner lists the services and whose accounts are known', () => {
  expect(pairingCommand(install(), '')[0]).toContain('has not said which chats');
  const lines = pairingCommand(install({ zulip: ['7'], rayboard: [] }), '');
  expect(lines[0]).toContain('rayboard: no account of yours is known');
  expect(lines[1]).toContain('zulip: 7 is yours');
});

test('/owner <service> leaves a code for the body and shows it; nothing is said to the agent', () => {
  const root = install({ zulip: [] });
  const lines = pairingCommand(root, ' Zulip ', () => 1_000, () => 0);
  expect(lines.join('\n')).toContain('AAAA-AAAA');
  const files = left(root);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^\..*\.pairing$/);
  expect(readPairing(readFileSync(join(root, '.teneral', 'owner', files[0]!), 'utf8'))).toEqual({ service: 'zulip', code: 'AAAAAAAA', until: 1_000 + PAIRING_MS });
  expect(pairingCommand(root, 'matrix')[0]).toContain('listens to no chat called matrix');
  expect(left(root)).toHaveLength(1);
});

test('/owner forget <service> is a line of the owner\'s', () => {
  const root = install({ zulip: ['7'] });
  expect(pairingCommand(root, 'forget zulip')[0]).toContain('Done');
  const files = left(root);
  expect(files).toHaveLength(1);
  expect(readFileSync(join(root, '.teneral', 'owner', files[0]!), 'utf8')).toBe('No zulip account is me');
  expect(pairingCommand(root, 'forget')[0]).toContain('Name the service');
});

test('only /owner is taken as the command', () => {
  const root = install({ zulip: [] });
  expect(pairingLine(root, '/ownership of this')).toBeNull();
  expect(pairingLine(root, 'tell me about /owner')).toBeNull();
  expect(pairingLine(root, '/owner')).not.toBeNull();
});
