/**
 * The limit for my character's bio. Keeps only a DB-independent constant — split out of
 * my-character.ts so the client form, server validation, and the conversation-preamble
 * injection (user-context.ts) all use the same value.
 */
export const BIO_MAX_LENGTH = 2000;
