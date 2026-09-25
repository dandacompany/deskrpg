"use client";
import type { ConnectorsApi } from "./connectors-api";

export type ConnectorOAuthStepProps = {
  api: ConnectorsApi;
  server: string;
  onDone(): void;
  onCancel(): void;
};

/** OAuth by pasting the loopback redirect URL. Stub — implemented in plan B Task 4. */
export default function ConnectorOAuthStep(_props: ConnectorOAuthStepProps) {
  return null;
}
