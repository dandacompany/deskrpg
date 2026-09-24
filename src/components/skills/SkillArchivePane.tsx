"use client";
import { useCallback, useEffect, useState } from "react";

import { useT } from "@/lib/i18n";
import type { ArchivedSkill } from "@/lib/hermes/plugin-client-types";

import { skillErrorText } from "./skill-error-text";
import type { SkillsApi } from "./skills-api";

export type SkillArchivePaneProps = {
  api: SkillsApi;
  canManage: boolean;
  /** A restore or purge changed the list (installed count / archive count). */
  onChanged(): void;
};

/**
 * Archive pane — restores or permanently purges archived local skills. Purging is only enabled
 * once the skill name is typed exactly (the original stays in the Hermes ledger and can only be
 * revived via CLI).
 */
export default function SkillArchivePane({ api, canManage, onChanged }: SkillArchivePaneProps) {
  const t = useT();
  const [rows, setRows] = useState<ArchivedSkill[] | null>(null);
  const [purging, setPurging] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api.listArchived());
    } catch (e) {
      setError(skillErrorText(t, e));
    }
  }, [api, t]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      onChanged();
    } catch (e) {
      setError(skillErrorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5 text-sm">
      {error && <p className="mb-2 text-xs text-danger">{error}</p>}
      {rows?.length === 0 && <p className="text-text-dim">{t("skills.archiveEmpty")}</p>}
      <ul className="max-w-2xl divide-y divide-border">
        {rows?.map((r) => (
          <li key={r.name} className="flex flex-wrap items-center gap-3 py-2">
            <span className="min-w-0 flex-1 truncate text-text">{r.name}</span>
            {r.archivedAt && (
              <span className="text-xs text-text-muted">{r.archivedAt.slice(0, 10)}</span>
            )}
            {canManage && (
              <>
                <button
                  type="button"
                  data-action="restore"
                  disabled={busy}
                  onClick={() => void run(() => api.restore(r.name))}
                  className="text-primary disabled:opacity-50"
                >
                  {t("skills.restore")}
                </button>
                <button
                  type="button"
                  data-action="purge"
                  disabled={busy}
                  onClick={() => {
                    setPurging(r.name);
                    setTyped("");
                  }}
                  className="text-danger disabled:opacity-50"
                >
                  {t("skills.purge")}
                </button>
              </>
            )}
            {canManage && purging === r.name && (
              <div className="w-full rounded border border-border p-2 text-xs">
                <p className="text-text">{t("skills.purge.confirm")}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <input
                    name="purge-name"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={r.name}
                    aria-label={t("skills.purge.confirm")}
                    className="rounded bg-surface-raised px-2 py-1 text-text"
                  />
                  <button
                    type="button"
                    data-action="confirm-purge"
                    disabled={busy || typed !== r.name}
                    onClick={() =>
                      void run(async () => {
                        await api.purge(r.name);
                        setPurging(null);
                      })
                    }
                    className="text-danger disabled:opacity-50"
                  >
                    {t("skills.purge")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPurging(null)}
                    className="text-text-muted"
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
