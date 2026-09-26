"use client";

/**
 * Picks a profile's Hermes toolsets/skills through a checklist instead of typing names.
 *
 * Selection state is owned by the caller (a controlled component). Passing `null` makes the
 * server's current state the default, and the value is reported via `onLoaded` right after
 * loading. Saving is also the caller's job — sent to config PUT as
 * `{ enabledToolsets, disabledSkills }`. The list sent up carries only names from the loaded
 * rows (excluding essential skills) — the plugin rejects an unknown name with a 400, so
 * seeding happens through `onLoaded`. On an old plugin (`plugin_upgrade_required`), nothing
 * is rendered and `onUnsupported` is called so the caller falls back to text input.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";

import { useT } from "@/lib/i18n";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";
import type { SkillRow, ToolsetRow } from "@/lib/hermes/plugin-client-types";

import {
  classifyLoad,
  groupSkills,
  initialSelection,
  toggleSkill,
  toggleToolset,
} from "./picker-model";
import Modal from "@/components/ui/Modal";

import ToolProviderPanel from "./ToolProviderPanel";

export type ToolsetSkillPickerProps = {
  profileBase: string; // `/api/gateways/${gatewayId}/plugin/profiles/${encodeURIComponent(name)}`
  enabledToolsets: string[] | null; // null = use the server's current state as the default
  onEnabledToolsetsChange(next: string[]): void;
  disabledSkills: string[] | null;
  onDisabledSkillsChange(next: string[]): void;
  onLoaded?(initial: { enabledToolsets: string[]; disabledSkills: string[] }): void;
  onUnsupported?(): void; // plugin_upgrade_required -> the caller falls back to text input
  disabled?: boolean;
  /**
   * Whether this is the gateway owner (plugin 0.10.0 `profile_tool_providers`). When true,
   * a tool with a provider choice gets a "Configure" button, and checking a tool that needs
   * configuration opens the config panel immediately. Key writes are owner-only.
   */
  canManageToolProviders?: boolean;
};

type Phase = "loading" | "ok" | "error" | "unsupported";
type Body = Record<string, unknown>;
type LoadResult = {
  key: string;
  phase: Exclude<Phase, "loading">;
  toolsets: ToolsetRow[];
  skills: SkillRow[];
  errorBody: Body | null;
};

const HIDDEN_TOOLSETS: ReadonlySet<string> = new Set(["clarify"]);

const EMPTY = { toolsets: [] as ToolsetRow[], skills: [] as SkillRow[], errorBody: null };

/** Flows as an error when the body isn't a JSON object (an HTML error page, empty body,
 *  truncated JSON) — the same code as `NpcHireWizard`'s `parseJsonBody`, an already
 *  registered and translated code. */
async function readBody(response: Response): Promise<Body> {
  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { errorCode: "malformed_response" };
    }
    return body as Body;
  } catch {
    return { errorCode: "malformed_response" };
  }
}

export default function ToolsetSkillPicker(props: ToolsetSkillPickerProps): JSX.Element | null {
  const t = useT();
  const { profileBase } = props;
  const [query, setQuery] = useState("");
  // The one open tool-config panel. For a tool that finished saving, only "needs key" is
  // cleared without refetching the list — refetching would let onLoaded reset the checked
  // state back to the server value, losing checks that haven't been saved yet.
  const [openTool, setOpenTool] = useState<string | null>(null);
  const [configuredNow, setConfiguredNow] = useState<Record<string, boolean>>({});
  const [reloadSeq, setReloadSeq] = useState(0);
  // The requesting key is attached to the result — if the key differs from the current
  // request, it's "loading." This makes loading happen right away when profileBase changes
  // or a retry happens, without synchronously resetting loading inside the effect.
  const loadKey = `${profileBase}\n${reloadSeq}`;
  const [result, setResult] = useState<LoadResult | null>(null);

  // Callbacks are kept in a ref so a refetch isn't triggered even if the parent passes a new inline function.
  const callbacks = useRef({ onLoaded: props.onLoaded, onUnsupported: props.onUnsupported });
  useEffect(() => {
    callbacks.current = { onLoaded: props.onLoaded, onUnsupported: props.onUnsupported };
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let responses: Response[];
      let bodies: Body[];
      try {
        responses = await Promise.all([
          fetch(`${profileBase}/toolsets`),
          fetch(`${profileBase}/skills`),
        ]);
        bodies = await Promise.all(responses.map(readBody));
      } catch {
        // A network failure — with no code to show, this falls back to the generic message (loadFailed).
        if (!cancelled) setResult({ key: loadKey, phase: "error", ...EMPTY });
        return;
      }
      if (cancelled) return;
      // A gate failure (401/409/428, ...) carries an errorCode, but even a non-2xx without
      // one is never rendered as an "ok" empty list — it falls back to the generic message.
      const bare = responses.findIndex((r, i) => !r.ok && typeof bodies[i].errorCode !== "string");
      if (bare >= 0) {
        setResult({ key: loadKey, phase: "error", ...EMPTY });
        return;
      }
      const verdict = classifyLoad(bodies);
      if (verdict === "unsupported") {
        setResult({ key: loadKey, phase: "unsupported", ...EMPTY });
        callbacks.current.onUnsupported?.();
        return;
      }
      if (verdict === "error") {
        const errorBody = bodies.find((b) => typeof b.errorCode === "string") ?? null;
        setResult({ key: loadKey, phase: "error", ...EMPTY, errorBody });
        return;
      }
      const [toolsetBody, skillBody] = bodies;
      const listed = Array.isArray(toolsetBody.toolsets)
        ? (toolsetBody.toolsets as ToolsetRow[])
        : [];
      // clarify can't work in chat: Hermes' api_server has no way to deliver its question. NPCs ask
      // with deskrpg_ask_user instead, so the switch is hidden — and dropped from the saved list.
      const toolsets = listed.filter((ts) => !HIDDEN_TOOLSETS.has(ts.name));
      const skills = Array.isArray(skillBody.skills) ? (skillBody.skills as SkillRow[]) : [];
      setResult({ key: loadKey, phase: "ok", toolsets, skills, errorBody: null });
      callbacks.current.onLoaded?.(initialSelection(toolsets, skills));
    })();
    return () => {
      cancelled = true;
    };
  }, [profileBase, loadKey]);

  const current = result?.key === loadKey ? result : null;
  const phase: Phase = current?.phase ?? "loading";
  const toolsets = current?.toolsets ?? EMPTY.toolsets;
  const skills = current?.skills ?? EMPTY.skills;
  const errorBody = current?.errorBody ?? null;

  const serverDefaults = useMemo(() => initialSelection(toolsets, skills), [toolsets, skills]);
  const enabledToolsets = props.enabledToolsets ?? serverDefaults.enabledToolsets;
  const disabledSkills = props.disabledSkills ?? serverDefaults.disabledSkills;
  const groups = useMemo(() => groupSkills(skills, query), [skills, query]);

  if (phase === "unsupported") return null;

  if (phase === "loading") {
    return <p className="text-xs text-text-muted">{t("hermes.picker.loading")}</p>;
  }

  if (phase === "error") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-danger">
          {getLocalizedErrorMessage(t, errorBody, "hermes.picker.loadFailed")}
        </p>
        <button
          type="button"
          onClick={() => setReloadSeq((n) => n + 1)}
          className="rounded bg-surface-raised px-3 py-1.5 text-xs font-semibold text-text hover:bg-surface-raised/80"
        >
          {t("hermes.picker.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <fieldset className="space-y-1 rounded border border-border p-3">
        <legend className="px-1 text-xs font-semibold text-text">
          {t("hermes.picker.toolsets")}
        </legend>
        <p className="text-xs text-text-dim" data-clarify-note>
          {t("hermes.picker.clarifyNote")}
        </p>
        {toolsets.map((ts) => {
          const configurable = Boolean(props.canManageToolProviders && ts.hasProviders);
          const configured = configuredNow[ts.name] ?? ts.configured;
          return (
            <div key={ts.name} className="space-y-1">
              <div className="flex items-start gap-2">
                <label className="flex min-w-0 flex-1 items-start gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    className="mt-1"
                    data-toolset={ts.name}
                    checked={enabledToolsets.includes(ts.name)}
                    disabled={props.disabled}
                    onChange={(e) => {
                      props.onEnabledToolsetsChange(
                        toggleToolset(enabledToolsets, ts.name, e.target.checked, toolsets),
                      );
                      // Like `hermes tools`, checking an unconfigured tool immediately asks for its provider/key.
                      if (e.target.checked && configurable && configured === false)
                        setOpenTool(ts.name);
                    }}
                  />
                  <span className="min-w-0">
                    <span className="font-medium">{ts.label || ts.name}</span>
                    {configured === false && (
                      <span className="ml-2 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-text-muted">
                        {t("hermes.picker.needsKey")}
                      </span>
                    )}
                    {ts.description && (
                      <span className="block text-xs text-text-muted">{ts.description}</span>
                    )}
                  </span>
                </label>
                {configurable && (
                  <button
                    type="button"
                    data-configure-tool={ts.name}
                    onClick={() => setOpenTool(ts.name)}
                    className="shrink-0 rounded bg-surface-raised px-2 py-1 text-xs font-semibold text-text hover:bg-surface-raised/80"
                  >
                    {t("hermes.toolProviders.configure")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </fieldset>

      {/* Per-tool provider config is shown as a popup rather than expanded inline in the
          list — a tool with 10+ providers (TTS, web) pushed the list around and lost track
          of which tool was being viewed. Only one is open at a time. */}
      {openTool && (
        <Modal
          open
          size="md"
          onClose={() => setOpenTool(null)}
          title={t("hermes.toolProviders.title", {
            tool: toolsets.find((ts) => ts.name === openTool)?.label || openTool,
          })}
        >
          <Modal.Body>
            <ToolProviderPanel
              profileBase={profileBase}
              toolset={openTool}
              disabled={props.disabled}
              onSaved={() => setConfiguredNow((cur) => ({ ...cur, [openTool]: true }))}
            />
          </Modal.Body>
          <Modal.Footer>
            <button
              type="button"
              onClick={() => setOpenTool(null)}
              className="rounded bg-surface-raised px-3 py-1.5 text-xs font-semibold text-text hover:bg-surface-raised/80"
            >
              {t("hermes.toolProviders.close")}
            </button>
          </Modal.Footer>
        </Modal>
      )}

      <fieldset className="space-y-2 rounded border border-border p-3">
        <legend className="px-1 text-xs font-semibold text-text">
          {t("hermes.picker.skills")}
        </legend>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("hermes.picker.searchSkills")}
          className="w-full rounded border border-border bg-bg px-3 py-2 text-sm text-text focus:outline-none focus:border-primary-light"
        />
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {groups.length === 0 ? (
            <p className="text-xs text-text-muted">{t("hermes.picker.noSkills")}</p>
          ) : (
            groups.map((group) => (
              <div key={group.category || "__uncategorized"} className="space-y-1">
                <p className="text-xs font-semibold text-text-muted">
                  {group.category || t("hermes.picker.uncategorized")}
                </p>
                {group.skills.map((skill) => (
                  <label key={skill.name} className="flex items-start gap-2 text-sm text-text">
                    {/* Checked means "on" — the inverse of disabledSkills. */}
                    <input
                      type="checkbox"
                      className="mt-1"
                      data-skill={skill.name}
                      checked={skill.essential || !disabledSkills.includes(skill.name)}
                      disabled={props.disabled || skill.essential}
                      onChange={(e) =>
                        props.onDisabledSkillsChange(
                          toggleSkill(disabledSkills, skill.name, e.target.checked, skills),
                        )
                      }
                    />
                    <span className="min-w-0">
                      <span className="font-medium">{skill.name}</span>
                      {skill.essential && (
                        <span className="ml-2 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-text-muted">
                          {t("hermes.picker.essential")}
                        </span>
                      )}
                      {skill.description && (
                        <span className="block text-xs text-text-muted">{skill.description}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            ))
          )}
        </div>
      </fieldset>
    </div>
  );
}
