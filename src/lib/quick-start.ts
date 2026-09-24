import { defaultOfficeAppearance, type CharacterAppearance } from "@/game/three/office-appearance";

/**
 * The **pure logic** of quick start. Neither the DB nor `fetch` come in here — the route
 * calls the existing domain functions (character/channel/placement routes), and this
 * file only makes decisions like "what to create".
 *
 * The core constraint of this feature is not creating new domain rules. Seat assignment
 * is handled by `npc-seating.ts` — it isn't here.
 */

/** The office environment, same as the default choice on the channel-creation screen. */
export const QUICK_START_ENVIRONMENT_ID = "trading";

/** The default look. The first male look (`office-jun`) — same as the character-creation default. */
export const QUICK_START_APPEARANCE: CharacterAppearance = defaultOfficeAppearance();

const MAX_CHARACTER_NAME = 50;
const MAX_CHANNEL_NAME = 100;

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/** The character name reuses the nickname as-is — folded if missing or too long. */
export function quickStartCharacterName(nickname: string | null | undefined): string {
  const base = clean(nickname);
  return (base || "Player").slice(0, MAX_CHARACTER_NAME);
}

/** Same for the channel name. One office per person is enough. */
export function quickStartChannelName(nickname: string | null | undefined): string {
  const base = clean(nickname);
  return (base ? `${base}'s Office` : "My Office").slice(0, MAX_CHANNEL_NAME);
}

/** Where the browser goes once quick start finishes. The character isn't carried — the server decides "who I am". */
export function quickStartGamePath(input: { channelId: string }): string {
  const params = new URLSearchParams({ channelId: input.channelId });
  return `/game?${params.toString()}`;
}
