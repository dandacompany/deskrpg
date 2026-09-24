"use client";

import { useCallback, useEffect, useState } from "react";

import { APP_VERSION, isNewer } from "@/lib/app-meta";
import type { AppMeta as ServerAppMeta } from "@/lib/app-meta-server";

import {
  browserStorage,
  readGrowthState,
  writeGrowthFlag,
  type GrowthState,
} from "./growth-storage";

type AppMeta = ServerAppMeta & { feedbackUrl: string | null };

export function useAppMeta() {
  const [meta, setMeta] = useState<AppMeta>({
    version: APP_VERSION,
    latestVersion: null,
    stars: null,
    feedbackUrl: null,
  });
  const [state, setState] = useState<GrowthState>({
    ok: false,
    seenVersion: null,
    starClicked: false,
  });

  useEffect(() => {
    let cancelled = false;
    // To avoid conflicting with server rendering, storage state is applied once, together with the response, after mount.
    fetch("/api/app-meta")
      .then((res) => (res.ok ? (res.json() as Promise<AppMeta>) : null))
      .catch(() => null)
      .then((data) => {
        if (cancelled) return;
        setState(readGrowthState(browserStorage()));
        if (data) setMeta(data);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const hasUpdate =
    state.ok &&
    isNewer(meta.latestVersion, meta.version) &&
    state.seenVersion !== meta.latestVersion;

  const markUpdateSeen = useCallback(() => {
    if (!meta.latestVersion) return;
    writeGrowthFlag(browserStorage(), "seenVersion", meta.latestVersion);
    setState((s) => ({ ...s, seenVersion: meta.latestVersion }));
  }, [meta.latestVersion]);

  const markStarClicked = useCallback(() => {
    writeGrowthFlag(browserStorage(), "starClicked", "1");
    setState((s) => ({ ...s, starClicked: true }));
  }, []);

  return {
    ...meta,
    updateAvailable: isNewer(meta.latestVersion, meta.version),
    hasUpdate,
    starClicked: state.starClicked,
    markUpdateSeen,
    markStarClicked,
  };
}

export type AppMetaView = ReturnType<typeof useAppMeta>;
