"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { accentClasses, type ChatAccent } from "@/components/chat-accent";
import { useT } from "@/lib/i18n";
import {
  filterCandidates,
  findMentionQuery,
  reduceDropdown,
  serializeSegments,
  type MentionCandidate,
  type Segment,
} from "./mention-model";

export type MentionEditorHandle = { clear(): void; focus(): void };

type Props = {
  candidates: MentionCandidate[];
  /** The serialized value (`@[name]` format). The DOM is the editor's source of truth; the parent uses this value for things like character counts. */
  value: string;
  onChange: (serialized: string) => void;
  /** Enter while the dropdown is closed. */
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  accent?: ChatAccent;
};

const CHIP_ATTR = "data-mention-id";

/** Editor DOM → segments. A chip is a `[data-mention-id]` element; everything else is text. */
function readSegments(root: HTMLElement): Segment[] {
  const out: Segment[] = [];
  root.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out.push({ kind: "text", text: n.textContent ?? "" });
    } else if (n instanceof HTMLElement && n.hasAttribute(CHIP_ATTR)) {
      out.push({
        kind: "mention",
        id: n.getAttribute(CHIP_ATTR) ?? "",
        name: n.getAttribute("data-mention-name") ?? "",
      });
    } else if (n instanceof HTMLElement && n.tagName === "BR") {
      // The <br> contenteditable inserts on an empty line — ignore it
    } else {
      out.push({ kind: "text", text: n.textContent ?? "" });
    }
  });
  return out;
}

/**
 * The text before the caret. If the selection is on a text node inside the editor, this is up
 * to that node's caret; otherwise (test environment, no focus) the entire last text node is
 * treated as "before the caret".
 */
function textBeforeCaret(root: HTMLElement): { node: Text; offset: number; before: string } | null {
  const sel = typeof window !== "undefined" ? window.getSelection?.() : null;
  const anchor = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  if (
    anchor &&
    anchor.collapsed &&
    anchor.startContainer.nodeType === Node.TEXT_NODE &&
    anchor.startContainer.parentNode === root
  ) {
    const node = anchor.startContainer as Text;
    const offset = anchor.startOffset;
    return { node, offset, before: (node.textContent ?? "").slice(0, offset) };
  }
  const last = root.lastChild;
  if (last && last.nodeType === Node.TEXT_NODE) {
    const node = last as Text;
    return { node, offset: node.length, before: node.textContent ?? "" };
  }
  return null;
}

function makeChip(c: MentionCandidate, chipClass: string): HTMLElement {
  const chip = document.createElement("span");
  chip.setAttribute(CHIP_ATTR, c.id);
  chip.setAttribute("data-mention-name", c.name);
  chip.setAttribute("contenteditable", "false");
  chip.className = `inline-block align-baseline rounded px-1.5 py-0.5 mx-0.5 text-sm font-semibold ${chipClass} select-none`;
  chip.textContent = `@${c.name}`;
  return chip;
}

/** Places the caret at an offset inside a text node — it must be "after" the space following a chip, so continued typing lands after that space. */
function placeCaretIn(node: Text, offset: number) {
  const sel = typeof window !== "undefined" ? window.getSelection?.() : null;
  if (!sel || typeof document.createRange !== "function") return;
  try {
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    /* An environment without the selection API — leave the caret position to the browser */
  }
}

/**
 * A single-line editor that names an NPC with `@`.
 *
 * A `<textarea>` can only hold characters, so it can't render a "chip". Putting a
 * `contenteditable="false"` span inside a contenteditable makes the browser treat it like a
 * single character — one backspace deletes it whole, and arrow keys skip over it. It's only
 * serialized to `@[name]` at send time, so the server's `parseAllMentions` needs no changes.
 */
const MentionEditor = forwardRef<MentionEditorHandle, Props>(function MentionEditor(
  { candidates, onChange, onSubmit, placeholder, disabled, autoFocus, accent = "npc" },
  ref,
) {
  const t = useT();
  const accentTheme = accentClasses(accent);
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState<{ start: number; query: string } | null>(null);
  // The text node holding the query — kept as a ref instead of React state since it's DOM (mutated directly when inserting a chip).
  const queryNodeRef = useRef<Text | null>(null);
  const [index, setIndex] = useState(0);
  const [empty, setEmpty] = useState(true);
  const composingRef = useRef(false);

  const filtered = useMemo(
    () => (query ? filterCandidates(query.query, candidates) : []),
    [query, candidates],
  );
  const open = query !== null;

  const sync = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const segs = readSegments(root);
    onChange(serializeSegments(segs));
    setEmpty(segs.every((s) => s.kind === "text" && s.text.length === 0));
    const caret = textBeforeCaret(root);
    const q = caret ? findMentionQuery(caret.before) : null;
    if (q && caret) {
      queryNodeRef.current = caret.node;
      setQuery((prev) => (prev && prev.start === q.start && prev.query === q.query ? prev : q));
      setIndex(0);
    } else {
      queryNodeRef.current = null;
      setQuery(null);
    }
  }, [onChange]);

  const insertChip = useCallback(
    (c: MentionCandidate) => {
      const root = rootRef.current;
      const node = queryNodeRef.current;
      if (!root || !query || !node) return;
      const { start } = query;
      const text = node.textContent ?? "";
      // Cut out the "@query" before the caret and put a chip + space in its place.
      const caret = textBeforeCaret(root);
      const end = caret && caret.node === node ? caret.offset : text.length;
      const before = text.slice(0, start);
      const after = text.slice(end);
      const chip = makeChip(c, accentTheme.chip);
      const space = document.createTextNode(after.startsWith(" ") ? after : ` ${after}`);
      node.textContent = before;
      node.after(chip, space);
      if (!before) node.remove();
      placeCaretIn(space, 1);
      setQuery(null);
      sync();
    },
    [query, accentTheme.chip, sync],
  );

  const clear = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    root.replaceChildren();
    setQuery(null);
    setEmpty(true);
    onChange("");
  }, [onChange]);

  useImperativeHandle(ref, () => ({ clear, focus: () => rootRef.current?.focus() }), [clear]);

  useEffect(() => {
    if (autoFocus && !disabled) rootRef.current?.focus();
  }, [autoFocus, disabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      e.stopPropagation(); // so simulation doesn't swallow the key
      if (e.nativeEvent.isComposing || composingRef.current) return;
      if (open) {
        const next = reduceDropdown({ open: true, index, count: filtered.length }, e.key);
        if (["ArrowDown", "ArrowUp", "Escape", "Enter", "Tab"].includes(e.key)) {
          e.preventDefault();
          if (next.select !== undefined) insertChip(filtered[next.select]);
          else if (!next.open) setQuery(null);
          else setIndex(next.index);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSubmit();
        return;
      }
      if (e.key === "Backspace") {
        // If a chip sits right before the caret, delete it whole (for environments where the browser can't).
        const sel = window.getSelection?.();
        const r = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
        if (r && r.collapsed) {
          let prev: Node | null = null;
          if (r.startContainer === rootRef.current)
            prev = rootRef.current.childNodes[r.startOffset - 1] ?? null;
          else if (r.startContainer.nodeType === Node.TEXT_NODE && r.startOffset === 0)
            prev = r.startContainer.previousSibling;
          if (prev instanceof HTMLElement && prev.hasAttribute(CHIP_ATTR)) {
            e.preventDefault();
            prev.remove();
            sync();
          }
        }
      }
    },
    [open, index, filtered, insertChip, onSubmit, sync],
  );

  return (
    <div className="relative flex-1 min-w-0">
      {open && (
        <ul
          role="listbox"
          className="absolute bottom-full left-0 mb-1 max-h-48 w-56 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-xl z-50"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-1.5 text-xs text-text-dim">{t("chat.mentionNoMatch")}</li>
          ) : (
            filtered.map((c, i) => (
              <li
                key={c.id}
                role="option"
                aria-selected={i === index}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertChip(c)}
                className={`cursor-pointer px-3 py-1.5 text-sm ${
                  i === index
                    ? `${accentTheme.option} font-medium`
                    : "text-text hover:bg-surface-raised"
                }`}
              >
                {c.name}
              </li>
            ))
          )}
        </ul>
      )}
      <div
        ref={rootRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="false"
        aria-label={placeholder}
        data-placeholder={placeholder}
        onInput={sync}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => (composingRef.current = true)}
        onCompositionEnd={() => {
          composingRef.current = false;
          sync();
        }}
        onBlur={() => setQuery(null)}
        className={`min-h-[36px] max-h-[120px] overflow-y-auto whitespace-pre-wrap break-words bg-surface text-text px-3 py-2 rounded-lg border focus:outline-none text-sm leading-5 ${
          disabled ? "border-border text-text-dim" : `border-border ${accentTheme.focusBorder}`
        } ${empty ? "before:content-[attr(data-placeholder)] before:text-text-dim before:pointer-events-none" : ""}`}
      />
    </div>
  );
});

export default MentionEditor;
