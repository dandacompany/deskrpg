"use client";
import type { ConnectorsApi } from "./connectors-api";

export type ConnectorAddPaneProps = {
  api: ConnectorsApi;
  /** Called with the new server's name once it is saved (the manager then selects it, or opens OAuth). */
  onAdded(name: string): void;
  onCancel(): void;
};

/** Catalog install and custom add. Stub — implemented in plan B Task 4 (keeps the manager compiling meanwhile). */
export default function ConnectorAddPane(_props: ConnectorAddPaneProps) {
  return null;
}
