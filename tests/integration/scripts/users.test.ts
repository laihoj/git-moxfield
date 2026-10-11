/**
 * `pnpm users …` (scripts/users.ts) against an in-memory database: the commands print
 * working links, refuse ambiguous input, and the links they print do what they say.
 */
import { describe, expect, it } from 'vitest';

import { createAuthService, SYSTEM_ACTOR } from '@/server/auth/service';
import { parseConfig, type AppConfig } from '@/server/config';
import { tokenOfPath } from '@tests/support/auth';
import { runCommand } from '@tests/support/cli';
import { openTestDatabase } from '@tests/support/db';
import { recordingLogger } from '@tests/support/services';

import { runUsersCommand, USAGE } from '../../../scripts/users';

async function cli(env: Record<string, string> = {}) {
  const db = await openTestDatabase();
  const config: AppConfig = parseConfig(env);
  const auth = createAuthService({ db, config, logger: recordingLogger() });
  const run = (...argv: string[]) => runCommand((io) => runUsersCommand(argv, { db, config, io }));
  return { db, auth, run };
}

/** The last line that looks like a URL. */
function printedUrl(lines: string[]): URL {
  const line = lines.findLast((entry) => /^https?:\/\//.test(entry));
  if (line === undefined) throw new Error(`No URL in ${JSON.stringify(lines)}`);
  return new URL(line);
}

describe('pnpm users', () => {
  it('prints invite links that create members or admins', async () => {
    const { auth, run } = await cli();
    const member = await run('invite', '--note', 'for Mikko');
    expect(member.code).toBe(0);
    expect(member.out[0]).toContain('new member (for Mikko)');
    const memberUrl = printedUrl(member.out);
    expect(memberUrl.origin).toBe('http://localhost:3000');
    expect(memberUrl.pathname).toMatch(/^\/invite\/gmi_[A-Za-z0-9_-]{43}$/);

    const admin = await run('--', 'invite', '--admin', '--base-url', 'https://decks.example.com/');
    const adminUrl = printedUrl(admin.out);
    expect(adminUrl.origin).toBe('https://decks.example.com');
    const accepted = await auth.acceptInvite(tokenOfPath(adminUrl.pathname), 'Operator', null);
    expect(accepted).toMatchObject({ ok: true, signIn: { user: { role: 'admin' } } });
  });

  it('uses PUBLIC_APP_URL as the base of printed links', async () => {
    const { run } = await cli({ PUBLIC_APP_URL: 'http://192.168.1.20:3000' });
    expect(printedUrl((await run('invite')).out).origin).toBe('http://192.168.1.20:3000');
  });

  it('lists users', async () => {
    const { auth, run } = await cli();
    expect((await run('list')).out[0]).toContain('No users yet');
    const invite = await auth.createInvite(SYSTEM_ACTOR, { role: 'member' });
    await auth.acceptInvite(tokenOfPath(invite.path), 'Mikko', null);
    const listed = await run('list');
    expect(listed.code).toBe(0);
    expect(listed.out).toEqual([
      expect.stringMatching(/ Mikko {2}member, active, 0 decks, 0 keys, never seen$/),
    ]);
  });

  it('prints a recovery link for a user found by name or id, and refuses ambiguous names', async () => {
    const { auth, run } = await cli();
    const create = async (name: string) => {
      const invite = await auth.createInvite(SYSTEM_ACTOR, { role: 'member' });
      const outcome = await auth.acceptInvite(tokenOfPath(invite.path), name, null);
      if (!outcome.ok) throw new Error(outcome.message);
      return outcome.signIn.user;
    };
    const mikko = await create('Mikko');
    const anna = await create('Anna');
    const otherAnna = await create('anna');

    const byName = await run('recover', 'mikko');
    expect(byName.code).toBe(0);
    const link = printedUrl(byName.out);
    expect(link.pathname).toMatch(/^\/signin\/gml_[A-Za-z0-9_-]{43}$/);
    const signIn = await auth.consumeLoginLink(tokenOfPath(link.pathname), 'New laptop');
    expect(signIn?.user.id).toBe(mikko.id);

    const ambiguous = await run('recover', 'Anna');
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err.join('\n')).toContain(anna.id);
    expect(ambiguous.err.join('\n')).toContain(otherAnna.id);
    expect((await run('recover', anna.id)).code).toBe(0);
    expect((await run('recover', 'Nobody')).code).toBe(1);
  });

  it('prints the setup code until the installation is claimed', async () => {
    const { auth, run } = await cli();
    const first = await run('claim-code');
    expect(first.code).toBe(0);
    expect(first.out[0]).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect((await run('claim-code')).out).toEqual(first.out);

    expect(await auth.claim(first.out[0] ?? '', 'Owner', null)).toMatchObject({ ok: true });
    const after = await run('claim-code');
    expect(after.code).toBe(1);
    expect(after.err[0]).toContain('already claimed');
  });

  it('explains its usage', async () => {
    const { run } = await cli();
    expect(await run()).toMatchObject({ code: 2, err: [USAGE] });
    expect(await run('--help')).toMatchObject({ code: 0, out: [USAGE] });
    for (const argv of [
      ['frobnicate'],
      ['invite', '--admn'],
      ['recover'],
      ['invite', '--base-url', 'ftp://x'],
    ]) {
      const result = await run(...argv);
      expect(result.code).toBe(2);
      expect(result.err[0]).toContain('Usage: pnpm users');
    }
  });
});
