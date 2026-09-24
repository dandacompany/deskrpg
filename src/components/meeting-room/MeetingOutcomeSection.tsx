"use client";

/**
 * Wires one meeting minutes' outcome panel to server state. Both the meeting-end screen and the
 * minutes view use it with the same minutes id — that's why the suggestion doesn't disappear
 * when the end screen is closed.
 *
 * The register/summarize permission (`canManage`) and whether it's registered are taken from
 * what the minutes fetch returns, not guessed by the client.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useT } from "@/lib/i18n";
import { getLocalizedMessage } from "@/lib/i18n/error-codes";
import type { MeetingOutcome, MeetingSummaryStatus } from "@/lib/meeting-outcome";
import type { OutcomeRegistration } from "@/lib/meeting-outcome-draft";

import MeetingOutcomePanel from "./MeetingOutcomePanel";

type Loaded = {
  /** Which minutes this value belongs to. When the minutes change, don't render until the new value arrives. */
  minutesId: string;
  outcome: MeetingOutcome | null;
  summaryStatus: MeetingSummaryStatus;
  canManage: boolean;
};

export type MeetingOutcomeSectionProps = {
  minutesId: string;
  /** The channel this meeting happened in — used to ask whether the connected plugin can create pending-approval cards. */
  channelId: string;
  npcs: Array<{ id: string; name: string }>;
  /** Called when the summary is regenerated — a chance to refresh the topic/conclusion display on the outer screen. */
  onSummaryChanged?: (summary: { keyTopics: string[]; conclusions: string | null }) => void;
  /** Called when registration finishes — for follow-up actions like navigating to the created card. */
  onRegistered?: (registered: NonNullable<MeetingOutcome["registered"]>) => void;
  /** Called when the user chooses not to register. Passing this adds a "don't register" button (meeting-end screen only). */
  onDeclined?: () => void;
  /**
   * Called when the outcome is read — whether this user still has follow-ups left to register. If not,
   * the end screen doesn't auto-exit; it just shows a notice. Reported as `false` once even if the
   * minutes can't be read.
   */
  onOutcomeLoaded?: (pending: boolean) => void;
};

async function readError(res: Response): Promise<string> {
  try {
    // The meeting route answers with `{errorCode}`; the kanban gate (no gateway / old plugin / someone else's board) answers with `{code}`.
    const data = (await res.json()) as { errorCode?: string; code?: string; error?: string };
    return data.errorCode || data.code || data.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export default function MeetingOutcomeSection({
  minutesId,
  channelId,
  npcs,
  onSummaryChanged,
  onRegistered,
  onDeclined,
  onOutcomeLoaded,
}: MeetingOutcomeSectionProps) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // Treat it as unsupported while unknown — never render even briefly a button that would fail on click.
  const [registerSupported, setRegisterSupported] = useState(false);
  // Don't re-fetch the minutes when the notification callback changes.
  const report = useRef(onOutcomeLoaded);
  useEffect(() => {
    report.current = onOutcomeLoaded;
  }, [onOutcomeLoaded]);

  useEffect(() => {
    let cancelled = false;
    // Same approach as the swarm button: judge by the capability the plugin advertises (not by version).
    void fetch(`/api/channels/${encodeURIComponent(channelId)}/automation/status`)
      .then(async (res) => (res.ok ? ((await res.json()) as { capabilities?: string[] }) : null))
      .then((status) => {
        if (!cancelled)
          setRegisterSupported(status?.capabilities?.includes("initial_status") ?? false);
      })
      .catch(() => {
        // If the status can't be read, it stays treated as unsupported.
      });
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/meetings/${minutesId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res));
        return (await res.json()) as {
          minutes: { outcome: MeetingOutcome | null; summaryStatus?: MeetingSummaryStatus };
          canManage?: boolean;
        };
      })
      .then((data) => {
        if (cancelled) return;
        const followUps = data.minutes.outcome?.followUps.length ?? 0;
        report.current?.(
          followUps > 0 && data.canManage === true && !data.minutes.outcome?.registered,
        );
        setLoaded({
          minutesId,
          outcome: data.minutes.outcome,
          summaryStatus: data.minutes.summaryStatus ?? "ok",
          canManage: data.canManage === true,
        });
      })
      .catch(() => {
        // Don't render the panel if the minutes can't be read. The outer screen shows the minutes body separately.
        if (!cancelled) report.current?.(false);
      });
    return () => {
      cancelled = true;
    };
  }, [minutesId]);

  const register = useCallback(
    async (body: OutcomeRegistration) => {
      const res = await fetch(`/api/meetings/${minutesId}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(getLocalizedMessage(t, await readError(res)));
      const data = (await res.json()) as { registered: NonNullable<MeetingOutcome["registered"]> };
      setLoaded((prev) =>
        prev?.outcome
          ? { ...prev, outcome: { ...prev.outcome, registered: data.registered } }
          : prev,
      );
      onRegistered?.(data.registered);
    },
    [minutesId, onRegistered, t],
  );

  const retry = useCallback(async () => {
    const res = await fetch(`/api/meetings/${minutesId}/summarize`, { method: "POST" });
    if (!res.ok) throw new Error(getLocalizedMessage(t, await readError(res)));
    const data = (await res.json()) as {
      summaryStatus: MeetingSummaryStatus;
      keyTopics: string[];
      conclusions: string | null;
      outcome: MeetingOutcome | null;
    };
    setLoaded((prev) =>
      prev ? { ...prev, outcome: data.outcome, summaryStatus: data.summaryStatus } : prev,
    );
    onSummaryChanged?.({ keyTopics: data.keyTopics, conclusions: data.conclusions });
  }, [minutesId, onSummaryChanged, t]);

  if (!loaded || loaded.minutesId !== minutesId) return null;
  const registered = loaded.outcome?.registered ?? null;
  return (
    <MeetingOutcomePanel
      // Regenerating the summary swaps the draft for the new outcome.
      key={`${minutesId}:${loaded.summaryStatus}:${loaded.outcome?.followUps.length ?? 0}`}
      outcome={loaded.outcome}
      summaryStatus={loaded.summaryStatus}
      npcs={npcs}
      canRegister={loaded.canManage}
      registerSupported={registerSupported}
      registered={registered}
      onRegister={register}
      onRetrySummary={retry}
      onDecline={onDeclined}
    />
  );
}
