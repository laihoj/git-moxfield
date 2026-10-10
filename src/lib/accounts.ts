/**
 * Shared wording for accounts (ADR 0006): roles, how a browser signed in, invite states.
 * The account, admin and sign-in pages describe the same things with the same words.
 */
import type { InviteStatus, SessionOrigin, UserRole } from '@/server/auth/types';

/** `Admin`, `Member`. */
export function roleLabel(role: UserRole): string {
  return role === 'admin' ? 'Admin' : 'Member';
}

/** How a signed-in browser got its session, as a phrase: `Signed in with the bookmarklet`. */
export function describeSessionOrigin(origin: SessionOrigin): string {
  switch (origin) {
    case 'bookmarklet':
      return 'Signed in with the bookmarklet';
    case 'device-link':
      return 'Signed in with a device link';
    case 'recovery-link':
      return 'Signed in with a recovery link';
    case 'invite':
      return 'Joined with an invite';
    case 'claim':
      return 'Set up git-moxfield';
  }
}

export interface InviteStatusPresentation {
  label: string;
  /** A `Badge` tone. */
  tone: 'accent' | 'add' | 'neutral' | 'outline';
}

/** Badge of an invite's state. Withdrawn is the word the invitee sees too. */
export function describeInviteStatus(status: InviteStatus): InviteStatusPresentation {
  switch (status) {
    case 'pending':
      return { label: 'Pending', tone: 'accent' };
    case 'used':
      return { label: 'Accepted', tone: 'add' };
    case 'expired':
      return { label: 'Expired', tone: 'neutral' };
    case 'revoked':
      return { label: 'Withdrawn', tone: 'outline' };
  }
}

/**
 * Initials for an avatar: the first letters of the first two words (`Jaakko Laiho` →
 * `JL`, `jaakko` → `J`), by code point so an emoji or accented letter stays whole.
 */
export function initials(displayName: string): string {
  const words = displayName
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== '');
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0] ?? '');
  const result = letters.join('').toLocaleUpperCase();
  return result === '' ? '?' : result;
}
