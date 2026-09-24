/**
 * Pull the **irreversible decisions** of the employee detail screen out into pure functions.
 *
 * Deleting an employee removes that persona's NPC seats and tasks along with it via CASCADE. Even if the text loses the numbers,
 * or the post-delete notice disagrees with the server field names, the screen wears a face as if nothing happened (it really did —
 * code reading `unboundNpcs` met a server sending `deletedNpcs`, and the notice had quietly vanished).
 * So these three verdicts are pinned here, not in the screen.
 */

/** The numbers to put in the delete question. A confirmation pressed without knowing the count is not a confirmation. */
export function deleteConfirmParams(
  name: string,
  usage: { npcs?: unknown; channels?: unknown } | null | undefined,
): { name: string; npcs: string; channels: string } {
  const toCount = (value: unknown) => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) && parsed > 0 ? String(Math.trunc(parsed)) : "0";
  };
  return { name, npcs: toCount(usage?.npcs), channels: toCount(usage?.channels) };
}

/** Read the notice numbers from the delete response. The server fields are `deletedNpcs` and `channels`. */
export function deletedNoticeFrom(data: unknown): { npcs: number; channels: number } | null {
  if (!data || typeof data !== "object") return null;
  const npcs = Number((data as { deletedNpcs?: unknown }).deletedNpcs ?? 0);
  const channels = Number((data as { channels?: unknown }).channels ?? 0);
  if (!Number.isFinite(npcs) || npcs <= 0) return null;
  return { npcs: Math.trunc(npcs), channels: Number.isFinite(channels) ? Math.trunc(channels) : 0 };
}

/**
 * Only the owner touches persona, appearance, AI model, account and delete. Shared users get as far as checking status.
 * Appearance is not separate — the wizard's ③ appearance step is its editor (the same editor used to appear twice).
 */
export function visibleSections(isOwner: boolean): ReadonlyArray<"status" | "persona" | "account"> {
  return isOwner ? ["status", "persona", "account"] : ["status"];
}
