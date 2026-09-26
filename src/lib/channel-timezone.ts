import { getChannelGatewayBinding } from "./gateway-resources";
import { restorePluginInfo } from "./hermes/plugin-cache-update";

/** The Hermes timezone recorded in a gateway's cached `/deskrpg/info` (plugin 0.6.0+), or null. */
export function timeZoneFromPluginInfo(json: string | null | undefined): string | null {
  return restorePluginInfo(json)?.timezone ?? null;
}

/**
 * The timezone of the Hermes behind this channel, from the cache only — no request to the
 * gateway. Null when the channel has no gateway or the plugin never reported one.
 */
export async function getChannelTimeZone(channelId: string): Promise<string | null> {
  const binding = await getChannelGatewayBinding(channelId);
  return timeZoneFromPluginInfo(binding?.resource.pluginInfoJson);
}
