/**
 * Pinned coordinates of the `deskrpg-hermes-plugin` that the wizard installs.
 *
 * The value itself is used by the Python running on the host (`PIN`/`PLUGIN_VERSION` in `host-helper.ts`),
 * and the screen only shows it to people. The screen used to hand-copy the first 12 characters, so
 * whenever the plugin was bumped and only one side was updated, the screen lied — now both places read
 * the same constant, and `pin.test.ts` checks it against the Python-side literal to prevent drift.
 */
export const PLUGIN_PIN = "64645b99ed7c911df1042e5fd879921120c69b7d";
export const PLUGIN_VERSION = "0.27.0";
/** Short form for the screen. There is no room to show the full commit. */
export const PLUGIN_PIN_SHORT = PLUGIN_PIN.slice(0, 12);
