import { describe, expect, it } from 'vitest';

import { describeInviteStatus, describeSessionOrigin, initials, roleLabel } from './accounts';

describe('initials', () => {
  it.each([
    ['Jaakko Laiho', 'JL'],
    ['jaakko', 'J'],
    ['  Mikko   K.  ', 'MK'],
    ['Anna Maria Virtanen', 'AM'],
    ['Ääni Örn', 'ÄÖ'],
    ['🐉 Dragon', '🐉D'],
    ['', '?'],
    ['   ', '?'],
  ])('%j → %j', (name, expected) => {
    expect(initials(name)).toBe(expected);
  });
});

describe('account wording', () => {
  it('labels roles', () => {
    expect(roleLabel('admin')).toBe('Admin');
    expect(roleLabel('member')).toBe('Member');
  });

  it('says how every kind of session started', () => {
    expect(describeSessionOrigin('bookmarklet')).toBe('Signed in with the bookmarklet');
    expect(describeSessionOrigin('device-link')).toBe('Signed in with a device link');
    expect(describeSessionOrigin('recovery-link')).toBe('Signed in with a recovery link');
    expect(describeSessionOrigin('invite')).toBe('Joined with an invite');
    expect(describeSessionOrigin('claim')).toBe('Set up git-moxfield');
  });

  it('labels invite states with the words the invitee sees', () => {
    expect(describeInviteStatus('pending')).toEqual({ label: 'Pending', tone: 'accent' });
    expect(describeInviteStatus('used')).toEqual({ label: 'Accepted', tone: 'add' });
    expect(describeInviteStatus('expired')).toEqual({ label: 'Expired', tone: 'neutral' });
    expect(describeInviteStatus('revoked')).toEqual({ label: 'Withdrawn', tone: 'outline' });
  });
});
