"use client";

import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { EventBus } from "@/game/EventBus";
import { meetingErrorCode } from "@/lib/meeting-error";
import { MeetingEntryController, type EntryState, type ArrivalState } from "./entry-controller";

export function useMeetingEntry(socket: Socket | null, channelId: string | null) {
  const [state, setState] = useState<EntryState>({ status: "idle" });
  const controller = useRef<MeetingEntryController | null>(null);
  useEffect(() => {
    const entry = new MeetingEntryController((event) => {
      if (event === "request") EventBus.emit("meeting:request-entry");
      if (event === "cancel") EventBus.emit("meeting:cancel-entry");
      if (event === "exit") {
        EventBus.emit("meeting:mode", { active: false });
        EventBus.emit("meeting:presentation-exit");
      }
    }, setState);
    controller.current = entry;
    const arrival = (next: ArrivalState) => entry.arrival(next);
    const request = () => entry.request();
    const joined = () => {
      if (entry.state.status !== "joining") return;
      EventBus.emit("meeting:presentation-enter");
      if (entry.state.status === "joining") entry.fail("map_unavailable");
    };
    const camera = (result: { ok: boolean }) => {
      if (entry.state.status !== "joining") return;
      if (!result.ok) entry.fail("map_unavailable");
      else {
        entry.joined();
        EventBus.emit("meeting:mode", { active: true });
      }
    };
    // The reason code goes straight into the translation-key lookup and the on-screen text —
    // if it's not a string, it becomes [object Object].
    const failed = ({ reasonCode }: { reasonCode: unknown }) => {
      if (!["idle", "failed"].includes(entry.state.status))
        entry.fail(meetingErrorCode(reasonCode));
    };
    // The "오피스로" (Back to office) button on the map — leaves the meeting screen. The top nav has no exit button.
    const exit = () => entry.cancel();
    const disconnect = () => {
      if (entry.state.status === "walking") entry.fail("driver_disconnected");
      // Keep the join screen up to receive the reconnect snapshot, and keep controls locked in meeting mode.
    };
    EventBus.on("meeting:entry-state", arrival);
    EventBus.on("meeting:entry-intent", request);
    EventBus.on("meeting:exit-intent", exit);
    EventBus.on("meeting:joined", joined);
    EventBus.on("meeting:presentation-result", camera);
    EventBus.on("meeting:join-failed", failed);
    socket?.on("disconnect", disconnect);
    return () => {
      EventBus.off("meeting:entry-state", arrival);
      EventBus.off("meeting:entry-intent", request);
      EventBus.off("meeting:exit-intent", exit);
      EventBus.off("meeting:joined", joined);
      EventBus.off("meeting:presentation-result", camera);
      EventBus.off("meeting:join-failed", failed);
      socket?.off("disconnect", disconnect);
      entry.cancel();
      controller.current = null;
    };
  }, [socket, channelId]);
  return {
    state,
    request: () => controller.current?.request(),
    cancel: () => controller.current?.cancel(),
  };
}
