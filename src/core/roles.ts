/**
 * The roles an account can have (ADR 0006). `admin` manages users and invites and grants
 * no access to other users' decks; `member` does neither. One list for the database
 * schema, the services that validate input, the forms and the tests.
 */
export const USER_ROLES = ['admin', 'member'] as const;
export type UserRole = (typeof USER_ROLES)[number];
