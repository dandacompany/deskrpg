"use client";
import type { ArtifactProvenance as Provenance } from "@/lib/artifact-provenance";
import { useLocale, useT } from "@/lib/i18n";
import { taskTimeMs } from "@/lib/plugin-time";

/**
 * How a board artifact came to be — the card, who ran it and when, and the cards it built on. Card
 * names open that card.
 */
export default function ArtifactProvenance({
  provenance,
  onOpenCard,
}: {
  provenance: Provenance;
  onOpenCard(taskId: string): void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const { task, run, parents, moreParents } = provenance;
  const at = taskTimeMs(run?.ended_at ?? run?.started_at ?? null);
  const card = (id: string, title: string, attr: string) => (
    <button
      key={id}
      type="button"
      data-provenance-card={attr}
      onClick={() => onOpenCard(id)}
      className="underline text-primary break-all text-left"
    >
      {title}
    </button>
  );
  return (
    <div
      data-artifact-provenance=""
      className="px-4 py-2 border-b border-border text-xs text-text-secondary space-y-0.5"
    >
      <div className="flex flex-wrap items-center gap-x-1.5">
        <span className="text-text-dim">{t("artifacts.made.card")}</span>
        {card(task.id, task.title, "task")}
        {provenance.workerName && <span>· {provenance.workerName}</span>}
        {at !== null && <span>· {new Date(at).toLocaleString(locale)}</span>}
      </div>
      {(parents.length > 0 || moreParents > 0) && (
        <div className="flex flex-wrap items-center gap-x-1.5">
          <span className="text-text-dim">{t("artifacts.made.parents")}</span>
          {parents.map((p) => card(p.id, p.title, "parent"))}
          {moreParents > 0 && (
            <span className="text-text-dim">
              {t("artifacts.made.moreParents", { count: moreParents })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
