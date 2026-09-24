/**
 * Judges "a paragraph that contains only a link on its own line" — only that paragraph
 * gets promoted to a preview card.
 *
 * A link inside a sentence is left as-is (it would break the flow of the text). A link
 * a person titled themselves (`[title](URL)`) is also left as-is — a card would
 * overwrite that title with someone else's og:title. File links are excluded too — they
 * already get a download icon (`chat-file-link.ts`).
 *
 * A pure function. Takes only the minimal shape of the hast node react-markdown gives.
 */
import { chatFileLink } from "@/lib/chat-file-link";

type MinimalNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: { href?: unknown };
  children?: MinimalNode[];
};

function textOf(node: MinimalNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

export function soleLinkUrl(node: { children?: MinimalNode[] } | undefined): string | null {
  const children = (node?.children ?? []).filter(
    (child) => !(child.type === "text" && !(child.value ?? "").trim()),
  );
  if (children.length !== 1) return null;

  const only = children[0];
  if (only.tagName !== "a") return null;
  const href = only.properties?.href;
  if (typeof href !== "string") return null;

  // Only when the visible text is the raw URL. A trailing `/` is handled differently by browsers/markdown.
  const label = textOf(only).trim();
  if (label !== href && label !== href.replace(/\/$/, "")) return null;

  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  if (chatFileLink(href)) return null;
  return href;
}
