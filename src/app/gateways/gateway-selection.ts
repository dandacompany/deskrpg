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
  options: { autoSelect?: boolean } = {},
): string {
  if (current && gateways.some((gateway) => gateway.id === current)) return current;
  if (options.autoSelect === false) return "";
  return gateways[0]?.id ?? "";
}
