/** Timestamps for plugin events·artifacts are epoch seconds (sourced from plugin 0.6.0+). The screen converts to ms only here. */
export function epochSecondsToMs(ts: number): number {
  return ts * 1000;
}
