/**
 * Limits on the text people type. Pure, so the forms that cap their inputs, the server
 * actions that sanity-check them and the services that enforce them all import the same
 * numbers instead of typing their own.
 */

/** Maximum commit message length in characters (Unicode code points, after NFC and trimming). */
export const MAX_COMMIT_MESSAGE_LENGTH = 2000;

/** Longest display name of a user (visible characters, after normalizing). */
export const MAX_DISPLAY_NAME_LENGTH = 40;

/** Longest label of a bookmarklet key (`Laptop Chrome`). */
export const MAX_KEY_LABEL_LENGTH = 60;

/** Longest note on an invite, a reminder for admins. */
export const MAX_INVITE_NOTE_LENGTH = 200;

/** Longest label of a share link (`For Mikko`). */
export const MAX_SHARE_LINK_LABEL_LENGTH = 60;

/** Maximum free-text note length in characters (Unicode code points, after NFC and trimming). */
export const MAX_NOTE_LENGTH = 20_000;

/** Longest text taken for a Moxfield deck URL or id; real deck URLs are well under 200 characters. */
export const MAX_DECK_INPUT_LENGTH = 2048;

/** Longest card search query considered; card names are far shorter. */
export const MAX_CARD_QUERY_LENGTH = 200;

/** Longest text taken for a setup code (UTF-16 units, as typed: `XXXX-XXXX-XXXX`, with room for spaces). */
export const MAX_SETUP_CODE_INPUT_LENGTH = 64;
