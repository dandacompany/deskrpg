"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Lock } from "lucide-react";

import { useT } from "@/lib/i18n";
import type { SkillDetail } from "@/lib/hermes/plugin-client-types";

import { skillErrorText } from "./skill-error-text";
import { SkillsApiError, type SkillsApi } from "./skills-api";
import { useSkillJob } from "./use-skill-job";

export type SkillDetailPaneProps = {
  api: SkillsApi;
  name: string;
  canManage: boolean;
  onChanged(): void;
  /** Archiving or deleting removed this skill from the list — the parent clears its selection. */
  onRemoved?(): void;
  /** Poll interval (ms) for the Hub uninstall job. Shortened in tests. */
  pollIntervalMs?: number;
};

type Confirm = "archive" | "uninstall" | null;

/** Why a file is locked — executable code (`scripts/`·`assets/`), or read-only due to its origin. */
const lockReason = (path: string) =>
  path.startsWith("scripts/") || path.startsWith("assets/")
    ? "skills.file.locked"
    : "skills.file.readOnly";

/**
 * Detail view for a single skill — origin / curator-managed status, file tree (with lock marks),
 * editor, and pin / archive / delete. Saving carries the hash received at read time as `baseHash`;
 * on a 409 `skill_changed` it keeps the edited content as-is and offers a reload.
 */
export default function SkillDetailPane({
  api,
  name,
  canManage,
  onChanged,
  onRemoved,
  pollIntervalMs,
}: SkillDetailPaneProps) {
  const t = useT();
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [path, setPath] = useState("SKILL.md");
  const [text, setText] = useState("");
  const [hash, setHash] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  // Prevents a stale, late-arriving file response from overwriting the editor when switching files fast.
  const fileSeq = useRef(0);
  // Hub uninstall is a 202 job like install — it must finish before it drops off the list.
  const uninstallJob = useSkillJob(api, { intervalMs: pollIntervalMs });
  const uninstallDone = uninstallJob.state === "succeeded" || uninstallJob.state === "unknown";
  useEffect(() => {
    if (!uninstallDone) return;
    onChanged();
    onRemoved?.();
    // The parent callback is recreated every render — call it only once, when the job finishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uninstallDone]);

  const loadFile = useCallback(
    async (p: string) => {
      const seq = ++fileSeq.current;
      try {
        const f = await api.readFile(name, p);
        if (seq !== fileSeq.current) return;
        setPath(p);
        setText(f.content);
        setHash(f.hash);
        setConflict(false);
        setError(null);
        setSaved(false);
      } catch (e) {
        if (seq === fileSeq.current) setError(skillErrorText(t, e));
      }
    },
    [api, name, t],
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const d = await api.detail(name);
        if (!alive) return;
        setDetail(d);
        await loadFile("SKILL.md");
      } catch (e) {
        if (alive) setError(skillErrorText(t, e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, name, loadFile, t]);

  if (!detail) {
    return error ? <p className="p-3 text-xs text-danger">{error}</p> : null;
  }
  const current = detail.files.find((f) => f.path === path);
  const editable = canManage && Boolean(current?.editable);
  const isLocal = detail.skill.source === "local";
  const isHub = detail.skill.source === "hub";
  const working = busy || uninstallJob.state === "running";

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(skillErrorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      setSaved(false);
      try {
        const res = await api.writeFile(name, path, text, hash);
        setHash(res.hash);
        setConflict(false);
        setSaved(true);
        onChanged();
      } catch (e) {
        if (e instanceof SkillsApiError && e.code === "skill_changed") setConflict(true);
        else throw e;
      }
    });
  const pin = () =>
    run(async () => {
      await api.setPinned(name, !detail.skill.pinned);
      setDetail(await api.detail(name));
      onChanged();
    });
  const archive = () =>
    run(async () => {
      await api.archive(name);
      setConfirm(null);
      onChanged();
      onRemoved?.();
    });
  const uninstall = async () => {
    setConfirm(null);
    await uninstallJob.start("hub", () => api.hubUninstall(name));
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3 text-sm">
      <div className="text-text">
        <strong>{name}</strong>{" "}
        <span className="text-xs text-text-muted">
          {t(`skills.source.${detail.skill.source}`)} ·{" "}
          {t(
            detail.skill.curatorManaged ? "skills.curatorManaged.yes" : "skills.curatorManaged.no",
          )}
        </span>
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {detail.files.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              data-file={f.path}
              data-locked={String(!f.editable)}
              onClick={() => void loadFile(f.path)}
              title={f.editable ? undefined : t(lockReason(f.path))}
              className={`flex items-center gap-1 ${
                f.path === path ? "text-primary" : "text-text-muted"
              } hover:text-text`}
            >
              {f.path}
              {!f.editable && <Lock className="h-3 w-3" aria-label={t(lockReason(f.path))} />}
            </button>
          </li>
        ))}
      </ul>
      {conflict && (
        <div className="rounded border border-border p-2 text-xs text-text">
          {t("skills.conflict")}{" "}
          <button
            type="button"
            data-action="reload"
            className="text-primary"
            onClick={() => void loadFile(path)}
          >
            {t("skills.reload")}
          </button>
        </div>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
      {canManage && current && !current.editable && (
        <p className="text-[11px] text-text-dim">{t(lockReason(current.path))}</p>
      )}
      <textarea
        value={text}
        readOnly={!editable}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        aria-label={path}
        className="min-h-0 flex-1 rounded border border-border bg-surface-raised p-2 font-mono text-xs text-text"
      />
      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          {editable && (
            <button
              type="button"
              data-action="save"
              disabled={working}
              onClick={() => void save()}
              className="rounded bg-primary px-3 py-1 text-white disabled:opacity-50"
            >
              {t("skills.save")}
            </button>
          )}
          {saved && <span className="text-xs text-text-muted">{t("skills.saved")}</span>}
          {isLocal && (
            <>
              <button
                type="button"
                data-action="pin"
                disabled={working}
                onClick={() => void pin()}
                className="rounded px-3 py-1 text-text hover:bg-surface-raised disabled:opacity-50"
              >
                {t(detail.skill.pinned ? "skills.unpin" : "skills.pin")}
              </button>
              <button
                type="button"
                data-action="archive"
                disabled={working || detail.skill.pinned}
                title={detail.skill.pinned ? t("skills.error.skill_pinned") : undefined}
                onClick={() => setConfirm("archive")}
                className="rounded px-3 py-1 text-danger hover:bg-surface-raised disabled:opacity-50"
              >
                {t("skills.archive")}
              </button>
              {detail.skill.pinned && (
                <span data-hint="skill-pinned" className="text-[11px] text-text-dim">
                  {t("skills.error.skill_pinned")}
                </span>
              )}
            </>
          )}
          {isHub && (
            <button
              type="button"
              data-action="uninstall"
              disabled={working}
              onClick={() => setConfirm("uninstall")}
              className="rounded px-3 py-1 text-danger hover:bg-surface-raised disabled:opacity-50"
            >
              {t("skills.uninstall")}
            </button>
          )}
        </div>
      )}
      {uninstallJob.state !== "idle" && (
        <div data-job-state={uninstallJob.state} className="text-xs text-text">
          {t(`skills.job.${uninstallJob.state}`)}
          {uninstallJob.state === "failed" && uninstallJob.job?.outputTail && (
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-surface-raised p-2 text-text-muted">
              {uninstallJob.job.outputTail}
            </pre>
          )}
        </div>
      )}
      {confirm && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-border p-2 text-xs">
          <span className="text-text">
            {t(confirm === "archive" ? "skills.archive.confirm" : "skills.uninstall.confirm")}
          </span>
          <button
            type="button"
            data-action={confirm === "archive" ? "confirm-archive" : "confirm-uninstall"}
            disabled={working}
            onClick={() => void (confirm === "archive" ? archive() : uninstall())}
            className="text-danger disabled:opacity-50"
          >
            {t("common.confirm")}
          </button>
          <button type="button" onClick={() => setConfirm(null)} className="text-text-muted">
            {t("common.cancel")}
          </button>
        </div>
      )}
    </div>
  );
}
