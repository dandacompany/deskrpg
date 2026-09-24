// Tells the user, in one line, "what it's doing right now" while an NPC is producing an
// answer.
//
// Why this is kept separate from the body: Hermes's `tool.progress` is a progress signal,
// not an answer. Measured live (v0.20.2), the `_thinking` tool sends the entire finished
// answer once more in delta — streaming this as a chat chunk used to make the answer show
// up twice in 1:1 conversation. So only **the tool name** is used here, and the delta body
// is never passed through.
//
// Tool names are a list measured live against Hermes `/v1/toolsets` (27 of them). An
// unrecognized name falls back to a generic phrase — so internal identifiers never leak
// onto the user's screen.

/** The translation key used for the activity indicator. The string shown on screen is
 * decided by the locale. */
export type ActivityNotice = { key: string };

// Based on the 63 **function names** measured live against Hermes `/v1/toolsets`. It's the
// individual function name (`web_search`), not the toolset name (`web`), that's carried on
// the event — this was first written against toolset names and every one of them missed in
// live testing. Grouped by prefix so that new functions still land correctly for the most
// part as they're added.
const TOOL_PREFIXES: [string, string][] = [
  ["web_", "npc.activity.searching"],
  ["x_search", "npc.activity.searching"],
  ["session_search", "npc.activity.recalling"],
  ["search_files", "npc.activity.readingFile"],
  ["browser_", "npc.activity.browsing"],
  ["read_file", "npc.activity.readingFile"],
  ["write_file", "npc.activity.writingFile"],
  ["patch", "npc.activity.writingFile"],
  ["terminal", "npc.activity.runningCommand"],
  ["execute_code", "npc.activity.runningCommand"],
  ["process", "npc.activity.runningCommand"],
  ["memory", "npc.activity.recalling"],
  ["image_generate", "npc.activity.makingImage"],
  ["video_generate", "npc.activity.makingImage"],
  ["xai_video", "npc.activity.makingImage"],
  ["vision_analyze", "npc.activity.lookingAtImage"],
  ["video_analyze", "npc.activity.lookingAtImage"],
  ["browser_vision", "npc.activity.lookingAtImage"],
  ["todo", "npc.activity.organizing"],
  ["skill", "npc.activity.organizing"],
  ["a2a_", "npc.activity.askingAround"],
  ["delegate_task", "npc.activity.askingAround"],
  ["clarify", "npc.activity.askingAround"],
  ["text_to_speech", "npc.activity.speaking"],
  ["_thinking", "npc.activity.thinking"],
];

const GENERIC = "npc.activity.working";

/**
 * @param toolName The tool_name sent by Hermes. If empty, there's nothing to show.
 * @returns The activity to show, or null when nothing should be shown.
 */
export function describeActivity(toolName: string): ActivityNotice | null {
  const name = toolName.trim();
  if (!name) return null;
  // Let the longer prefix win — `browser_vision` is more specific than `browser_`.
  let best: { key: string; length: number } | null = null;
  for (const [prefix, key] of TOOL_PREFIXES) {
    if (!name.startsWith(prefix)) continue;
    if (!best || prefix.length > best.length) best = { key, length: prefix.length };
  }
  return { key: best?.key ?? GENERIC };
}

/** Does this activity have a phrase shown on screen — the locale guard checks this list. */
export function allActivityKeys(): string[] {
  return [...new Set([...TOOL_PREFIXES.map(([, key]) => key), GENERIC])].sort();
}
