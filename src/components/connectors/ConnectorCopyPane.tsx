"use client";
import type { ConnectorsApi } from "./connectors-api";

export type ConnectorCopyPaneProps = {
  api: ConnectorsApi;
  server: string;
  /** Other active NPCs of this channel (display names from `hermes_profiles`). */
  targets: { npcId: string; name: string }[];
  onDone(): void;
};

/** Copies a server's settings (never secrets or OAuth) to other NPCs. Stub — implemented in plan B Task 4. */
export default function ConnectorCopyPane(_props: ConnectorCopyPaneProps) {
  return null;
}
