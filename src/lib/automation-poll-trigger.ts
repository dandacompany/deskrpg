/**
 * The **fire-and-forget** layer for immediate polling right after an operation (R24).
 *
 * The Kanban/cron routes call `schedulePollNow(channelId)` after a change succeeds and then
 * return their response — never waiting for polling, and a polling failure never leaks into
 * the response (the poller records it on `last_error` instead). If the poller doesn't exist
 * yet (tests, early CLI), the registry just returns null and that's it.
 *
 * The real poller is reached through `automation-registry.ts` rather than importing
 * `@/server/*` directly — pulling the socket server module into the Next bundle breaks the
 * build (`app-server-boundary.test.ts`).
 *
 * Tests swap in a recorder in place of the real poller via `setPollNowForTests` — what's
 * being verified is "when" the route requests polling; polling itself is
 * `automation-poller.test.ts`'s job.
 */

import { requestPollNow } from "@/lib/automation-registry";

type PollNowFn = (channelId: string) => Promise<unknown>;

let pollNowImpl: PollNowFn = requestPollNow;

export function schedulePollNow(channelId: string): void {
  try {
    void pollNowImpl(channelId).catch((err: unknown) => {
      console.warn(
        `[automation-poll-trigger] pollNow(${channelId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  } catch (err) {
    console.warn(
      `[automation-poll-trigger] pollNow(${channelId}) threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Test-only — passing null reverts to going through the registry (the real poller). */
export function setPollNowForTests(fn: PollNowFn | null): void {
  pollNowImpl = fn ?? requestPollNow;
}
