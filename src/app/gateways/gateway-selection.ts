export type GatewayReloadOptions = {
  autoSelect?: boolean;
  /** Select this gateway if the reloaded list has it — the one the wizard just created. */
  prefer?: string;
};

/**
 * Decides what to select after reloading the gateway list.
 *
 * An empty selection means "show the connection wizard". Right after the wizard saves an address connection,
 * when only the list is refreshed, call with `autoSelect: false` — otherwise the new gateway gets
 * auto-selected and the wizard, with its plugin install guidance, disappears.
 */
export function nextSelectedGatewayId(
  current: string,
  gateways: ReadonlyArray<{ id: string }>,
  options: GatewayReloadOptions = {},
): string {
  if (options.prefer && gateways.some((gateway) => gateway.id === options.prefer)) {
    return options.prefer;
  }
  if (current && gateways.some((gateway) => gateway.id === current)) return current;
  if (options.autoSelect === false) return "";
  return gateways[0]?.id ?? "";
}

/**
 * How to reload the list after the wizard saved a gateway. A ready gateway is selected at once,
 * so its page (with the next step, registering employees) opens without another click. One whose
 * plugin still needs installing keeps the wizard on screen with that guidance.
 */
export function reloadAfterSave(gatewayId: string, pluginStatus: string): GatewayReloadOptions {
  return pluginStatus === "plugin_ready" ? { prefer: gatewayId } : { autoSelect: false };
}
