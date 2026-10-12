import { describe, expect, it } from 'vitest';

import {
  describeCreator,
  describeInviteStatus,
  describeSessionOrigin,
  initials,
  roleLabel,
  theShareLinks,
} from './accounts';

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

  it('names who made a link: an admin, or the command line', () => {
    expect(describeCreator('Mikko')).toBe('By Mikko');
    expect(describeCreator(null)).toBe('Created on the command line');
  });

  it('counts the share links a revocation reaches', () => {
    expect(theShareLinks(0)).toBe('any share links');
    expect(theShareLinks(1)).toBe('the share link');
    expect(theShareLinks(3)).toBe('the 3 share links');
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
