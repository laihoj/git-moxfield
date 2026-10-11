/**
 * The words of a version reference (`compare?from=v3&to=working`): the one list the
 * links, the pickers and the server's parser (`server/services/refs.ts`) agree on.
 * A version is also referred to by `v12` (see `versionLabel`) or a commit id prefix.
 */

/** The latest version. */
export const HEAD_REF = 'head';

/** The latest observed Moxfield state (not committed). */
export const WORKING_REF = 'working';

/** The empty deck. */
export const EMPTY_REF = 'empty';
