// Judges whether applying a preset may overwrite a persona (identity/soul) the user has written.
//
// The NPC hiring modal has two branches through which a preset arrives.
//
//   Clicking an appearance preset card → the user picked "appearance." Replacing the persona is a side effect.
//   Changing the persona select        → the user picked "persona." Replacing it is the request itself.
//
// Only the first case protects a persona the user has already touched. Protecting it in the
// second case too would silently ignore an explicit request to change the persona.
//
// The decision treats identity/soul together, **the persona as a single unit**, rather than
// judging each separately. Judging field by field would, in the common case where only identity
// was edited, swap in the preset for soul alone — producing a persona half the user's and half
// the preset's, whose displayed preset name then correctly points to neither.
export type PresetApplySource = "appearance" | "persona";

export type PersonaCustomizedState = {
  identity: boolean;
  soul: boolean;
};

/**
 * @param source     Which action the preset arrived from.
 * @param customized Whether the user directly edited each field.
 * @returns true means replace identity and soul together with the preset's text.
 */
export function shouldReplacePresetText(
  source: PresetApplySource,
  customized: PersonaCustomizedState,
): boolean {
  if (source === "persona") return true;
  return !customized.identity && !customized.soul;
}
