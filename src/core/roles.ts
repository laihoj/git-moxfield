/** The roles of an account (ADR 0006): `admin` also manages users and invites, never others' decks. */
export const USER_ROLES = ['admin', 'member'] as const;
export type UserRole = (typeof USER_ROLES)[number];
