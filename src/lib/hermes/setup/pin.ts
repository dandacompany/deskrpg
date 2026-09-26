/**
 * Pinned coordinates of the `deskrpg-hermes-plugin` that the wizard installs.
 *
 * The value itself is used by the Python running on the host (`PIN`/`PLUGIN_VERSION` in `host-helper.ts`),
 * and the screen only shows it to people. The screen used to hand-copy the first 12 characters, so
 * whenever the plugin was bumped and only one side was updated, the screen lied — now both places read
 * the same constant, and `pin.test.ts` checks it against the Python-side literal to prevent drift.
 */
export const PLUGIN_PIN = "4a2e66495032464985985ed195ae3c3c77cece0d";
export const PLUGIN_VERSION = "0.24.4";
/** Short form for the screen. There is no room to show the full commit. */
export const PLUGIN_PIN_SHORT = PLUGIN_PIN.slice(0, 12);
