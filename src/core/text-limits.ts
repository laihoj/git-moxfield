/**
 * Limits on the text people type. Pure, so the forms that cap their inputs, the server
 * actions that sanity-check them and the services that enforce them all import the same
 * numbers instead of typing their own.
 */

/** Maximum commit message length in characters (Unicode code points, after NFC and trimming). */
export const MAX_COMMIT_MESSAGE_LENGTH = 2000;

/** Maximum free-text note length in characters (Unicode code points, after NFC and trimming). */
export const MAX_NOTE_LENGTH = 20_000;
