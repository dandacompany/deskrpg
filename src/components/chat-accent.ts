/**
 * The chat input's accent color.
 *
 * Previously, callers passed a palette name ("amber"/"indigo") and the class was assembled as a
 * string (`bg-${accent}-500/20`). Tailwind generates classes by scanning source as text, so an
 * assembled name never produces CSS, and the color silently disappears with no error. So the
 * accent is now chosen only from **pre-written brand-token classes**.
 *
 * The text color is `text-text` for both accents — only the background tint distinguishes NPC
 * from meeting, and contrast is guaranteed by the body text color in every theme.
 */
export type ChatAccent = "npc" | "meeting";

type AccentClasses = {
  /** Selected candidate in the dropdown */
  option: string;
  /** Mention chip embedded in the body */
  chip: string;
  /** Input focus border */
  focusBorder: string;
  /** Send button (active) */
  sendButton: string;
};

export const CHAT_ACCENT: Record<ChatAccent, AccentClasses> = {
  npc: {
    option: "bg-npc/15 text-text",
    chip: "bg-npc/15 text-text",
    focusBorder: "focus:border-npc",
    sendButton: "bg-npc hover:bg-npc-dark text-white",
  },
  meeting: {
    option: "bg-meeting/15 text-text",
    chip: "bg-meeting/15 text-text",
    focusBorder: "focus:border-meeting",
    sendButton: "bg-meeting hover:opacity-90 text-white",
  },
};

export function accentClasses(accent: ChatAccent = "npc"): AccentClasses {
  return CHAT_ACCENT[accent] ?? CHAT_ACCENT.npc;
}
