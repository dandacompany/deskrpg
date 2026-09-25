import { resolvePluginStatusFromCache, type PluginStatus } from "@/lib/hermes/plugin-capability";

/** The fields of one `/api/gateways` row the hiring and employee pages read. */
export type GatewayPluginRow = {
  id: string;
  isOwner?: boolean;
  pluginStatus: string | null;
  pluginVersion?: string | null;
  pluginCheckedAt: string | Date | null;
  dashboardUrl?: string | null;
  supportsProfileClone?: boolean;
};

export type GatewayPluginState = { row: GatewayPluginRow | null; pluginStatus: PluginStatus };

async function readRow(
  gatewayId: string,
  fetchImpl: typeof fetch,
  query: string,
): Promise<GatewayPluginRow | null> {
  try {
    const res = await fetchImpl(`/api/gateways${query}`);
    const data = (await res.json().catch(() => ({}))) as { gateways?: unknown };
    const rows = Array.isArray(data.gateways) ? data.gateways : [];
    const found = rows.find(
      (row): row is GatewayPluginRow =>
        !!row && typeof row === "object" && (row as { id?: unknown }).id === gatewayId,
    );
    return found ?? null;
  } catch {
    return null;
  }
}

async function testPlugin(gatewayId: string, fetchImpl: typeof fetch): Promise<PluginStatus> {
  try {
    const res = await fetchImpl(`/api/gateways/${gatewayId}/test`, { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as { plugin?: { status?: unknown } };
    const status = data.plugin?.status;
    return typeof status === "string" ? (status as PluginStatus) : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The gateway row and plugin verdict for the hiring and employee detail pages — one path so the two
 * pages cannot drift again (the detail page used to ignore `needsReprobe`, locking persona and model
 * editing an hour after the last probe).
 *
 * The list is read with `refreshPlugin=1`, so the server re-probes a cache that no longer describes
 * the install. If the verdict still needs a re-check (a shared gateway, a throttled probe) or `force`
 * is set, the plugin test runs and the row is read again — capability fields such as
 * `supportsProfileClone` must come from the same probe as the status.
 */
export async function loadGatewayPluginState(
  gatewayId: string,
  opts: { fetchImpl?: typeof fetch; force?: boolean; now?: Date } = {},
): Promise<GatewayPluginState> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const row = await readRow(gatewayId, fetchImpl, "?refreshPlugin=1");
  if (row && !opts.force) {
    const cached = resolvePluginStatusFromCache({
      pluginStatus: row.pluginStatus,
      pluginCheckedAt: row.pluginCheckedAt,
      pluginVersion: row.pluginVersion ?? null,
      now: opts.now ?? new Date(),
    });
    if (!cached.needsReprobe) return { row, pluginStatus: cached.status };
  }
  const pluginStatus = await testPlugin(gatewayId, fetchImpl);
  const reread = await readRow(gatewayId, fetchImpl, "");
  return { row: reread ?? row, pluginStatus };
}
