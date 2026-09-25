"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/** The part of a socket.io client this hook uses — a real `Socket` fits it as-is. */
export type MeetingStopSocket = {
  on(event: string, handler: (payload?: unknown) => void): unknown;
  off(event: string, handler: (payload?: unknown) => void): unknown;
  emit(event: string, payload: unknown): unknown;
};

/**
 * The meeting's stop button. The server only ends the meeting once the current turn winds
 * down, so the first click sends `meeting:stop` and the button stays locked ("stopping…")
 * until `meeting:end`, `meeting:error` or a disconnect. A stop the server drops silently
 * unlocks after `timeoutMs` so the host can try again.
 */
export function useMeetingStop(
  socket: MeetingStopSocket | null | undefined,
  channelId: string,
  timeoutMs = 20_000,
) {
  // Remembers which channel is stopping, so switching channels drops it during render.
  const [stoppingChannel, setStoppingChannel] = useState<string | null>(null);
  const stoppingRef = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    stoppingRef.current = null;
    setStoppingChannel(null);
  }, []);

  useEffect(() => {
    if (!socket) return;
    socket.on("meeting:end", clear);
    socket.on("meeting:error", clear);
    socket.on("disconnect", clear);
    return () => {
      socket.off("meeting:end", clear);
      socket.off("meeting:error", clear);
      socket.off("disconnect", clear);
    };
  }, [socket, clear]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const stop = useCallback(() => {
    if (!socket || stoppingRef.current === channelId) return;
    stoppingRef.current = channelId;
    setStoppingChannel(channelId);
    socket.emit("meeting:stop", { channelId });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(clear, timeoutMs);
  }, [socket, channelId, timeoutMs, clear]);

  return { stopping: stoppingChannel === channelId, stop };
}
