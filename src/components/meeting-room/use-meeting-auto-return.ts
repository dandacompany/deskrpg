"use client";

/**
 * Auto-return to the office after a meeting ends.
 *
 * While on the meeting screen, report calls are blocked (`inMeeting` in `reportCallBlocked`).
 * If follow-up work has been registered, or the user chose not to register any, there's
 * nothing left to do on this screen, so after a few seconds of notice it exits via
 * `meeting:exit-intent`, the same event as the "Back to office" button in the top-right
 * of the map. A meeting with no follow-up work doesn't exit — it only shows a hint, to
 * give time to read the summary. The transcript can be reopened from the archive later.
 *
 * `active` means "the end screen is showing." When it turns off (e.g. a new meeting
 * starts), the count in progress is discarded — it never exits while a meeting is
 * in progress.
 */
import { useCallback, useEffect, useState } from "react";

import { EventBus } from "@/game/EventBus";

export const AUTO_RETURN_SECONDS = 5;

export type AutoReturnState =
  | { status: "idle" }
  | { status: "counting"; remaining: number }
  | { status: "stayed" }
  | { status: "hint" }
  | { status: "returned" };

export function useMeetingAutoReturn(active: boolean, seconds = AUTO_RETURN_SECONDS) {
  const [state, setState] = useState<AutoReturnState>({ status: "idle" });
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) setState({ status: "idle" });
  }

  useEffect(() => {
    if (!active || state.status !== "counting") return;
    const timer = setTimeout(() => {
      if (state.remaining > 1) {
        setState({ status: "counting", remaining: state.remaining - 1 });
        return;
      }
      setState({ status: "returned" });
      EventBus.emit("meeting:exit-intent");
    }, 1000);
    return () => clearTimeout(timer);
  }, [active, state]);

  /** Registration is complete, or the user chose not to register. */
  const start = useCallback(() => {
    if (active) setState({ status: "counting", remaining: seconds });
  }, [active, seconds]);
  const stay = useCallback(() => setState({ status: "stayed" }), []);
  /** A meeting that won't auto-exit — only notifies that a report will come on exit. Leaves it alone while counting. */
  const hint = useCallback(() => {
    if (active) setState((prev) => (prev.status === "idle" ? { status: "hint" } : prev));
  }, [active]);

  return { state, start, stay, hint };
}
