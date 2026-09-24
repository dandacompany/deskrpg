"use strict";

/**
 * Chooses the password input path for `deskrpg create-user`.
 *
 * Why the branching: with only `--password PW`, the password stays in shell history and
 * `ps` output as plaintext. On a shared shell or multi-user server, other users can see it
 * too. But the argument can't just be removed either — scripts and CI call it that way.
 *
 * So there's a priority order: explicit stdin > explicit argument > interactive prompt. The
 * first two are followed as-is since the caller has stated its intent, and it only prompts
 * when there's nothing at all.
 *
 * All input/output is injected — this decision itself has to be testable without knowing
 * about a TTY or streams.
 */
async function resolvePassword(options) {
  const {
    passwordArg = null,
    fromStdin = false,
    readStdin,
    promptPassword,
    isTty = false,
  } = options || {};

  if (fromStdin) {
    const piped = await readStdin();
    // A pipe normally ends with a newline (`echo pw | deskrpg …`). Only that trailing
    // newline is stripped and nothing else is touched — the password itself may contain
    // whitespace.
    return String(piped).replace(/\r?\n$/, "");
  }

  if (passwordArg !== null && passwordArg !== undefined) return passwordArg;

  if (!isTty) {
    // Non-interactive, and no path was given at all. Showing a prompt here would leave the
    // script silently hanging — so it tells the caller what to do instead of asking.
    throw new Error("password required: pass --password PW, or pipe it with --password-stdin");
  }

  return await promptPassword();
}

module.exports = { resolvePassword };
