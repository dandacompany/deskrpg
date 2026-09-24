/**
 * Judges **who owns** this NPC's persona.
 *
 * For an NPC attached to Hermes, the profile's SOUL.md owns the persona. DeskRPG cannot
 * change it — `instructions` never replaces the existing system prompt, only appends to it
 * (`effective + "\n\n" + ephemeral` in `agent/conversation_loop.py`), and there's no switch
 * on the HTTP surface to turn off loading SOUL.md.
 *
 * So leaving the edit field open means **the screen lies** — the user writes a personality,
 * confirms it saved, but the NPC never reads it. When the profile owns it, show
 * "게이트웨이가 관리합니다" instead of the input.
 */
export function isPersonaOwnedByProfile(input: {
  adapterType: string | null | undefined;
  /** When an existing agent already in the gateway was picked (legacy path). */
  existingAgentSelected?: boolean;
}): boolean {
  if (input.existingAgentSelected) return true;
  return input.adapterType === "hermes";
}
