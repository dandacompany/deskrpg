"use client";

import Link from "next/link";

import Modal from "@/components/ui/Modal";
import { CopyCommand } from "@/components/CopyCommand";
import { useT } from "@/lib/i18n";
import { isSetupBlocker, type GateBlocker } from "@/lib/gate-failure";

/**
 * Shows "what isn't ready yet" as steps when blocked by a gate.
 *
 * It does not fix anything — only guidance and navigation (design, 2026-09-20). Accepting a
 * key inside the popup or nesting a wizard inside it would split the failure path across
 * screens and create a state that's hard to back out of.
 */
type StepKind =
  "gateway_not_bound" | "plugin_unauthorized" | "plugin_absent" | "plugin_upgrade_required";

const STEPS: { kind: StepKind; labelKey: string; hintKey: string }[] = [
  {
    kind: "gateway_not_bound",
    labelKey: "gateChecklist.step.gateway",
    hintKey: "gateChecklist.hint.gateway",
  },
  {
    kind: "plugin_unauthorized",
    labelKey: "gateChecklist.step.ownerKey",
    hintKey: "gateChecklist.hint.ownerKey",
  },
  {
    kind: "plugin_absent",
    labelKey: "gateChecklist.step.plugin",
    hintKey: "gateChecklist.hint.plugin",
  },
  {
    kind: "plugin_upgrade_required",
    labelKey: "gateChecklist.step.version",
    hintKey: "gateChecklist.hint.version",
  },
];

export default function GateChecklistModal({
  blocker,
  onClose,
  onRetry,
}: {
  blocker: GateBlocker | null;
  onClose: () => void;
  onRetry?: () => void;
}) {
  const t = useT();
  if (!blocker) return null;

  const blockedIndex = STEPS.findIndex((step) => step.kind === blocker.kind);

  return (
    <Modal open onClose={onClose} title={t("gateChecklist.title")} size="sm">
      {isSetupBlocker(blocker) ? (
        <ol className="space-y-3">
          {STEPS.map((step, index) => {
            const state =
              index < blockedIndex ? "done" : index === blockedIndex ? "blocked" : "pending";
            return (
              <li key={step.kind} className="text-sm">
                <span className="mr-2" aria-hidden="true">
                  {state === "done" ? "✅" : state === "blocked" ? "❌" : "⬜"}
                </span>
                <span className={state === "blocked" ? "font-semibold" : undefined}>
                  {t(step.labelKey)}
                </span>
                {state === "blocked" && (
                  <div className="mt-2 space-y-2 pl-6 text-text-muted">
                    <p>
                      {blocker.kind === "plugin_upgrade_required"
                        ? t(step.hintKey, { minVersion: blocker.minVersion })
                        : t(step.hintKey)}
                    </p>
                    {(blocker.kind === "plugin_absent" ||
                      blocker.kind === "plugin_upgrade_required") && (
                      <CopyCommand command={blocker.command} />
                    )}
                    {(blocker.kind === "gateway_not_bound" ||
                      blocker.kind === "plugin_unauthorized") && (
                      <Link href="/gateways" className="underline">
                        {t("gateChecklist.openGateways")}
                      </Link>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="space-y-3 text-sm">
          <p>
            {blocker.kind === "unreachable"
              ? t("gateChecklist.unreachable")
              : blocker.kind === "timeout"
                ? t("gateChecklist.timeout")
                : blocker.kind === "other"
                  ? `${blocker.code}: ${blocker.message}`
                  : null}
          </p>
          {onRetry && (
            <button type="button" onClick={onRetry} className="underline">
              {t("gateChecklist.retry")}
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}
