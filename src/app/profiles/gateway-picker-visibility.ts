/** Do not show a picker with nothing to pick to users with just one gateway (most of them). */
export function showGatewayPicker(gatewayCount: number): boolean {
  return gatewayCount >= 2;
}
