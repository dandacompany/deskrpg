export interface PollRaiseItem {
  name: string;
  reason?: string;
}

export function formatPollRaises(raises: Array<string | PollRaiseItem> | undefined): string[] {
  if (!Array.isArray(raises)) return [];

  return raises
    .map((raise) => {
      if (typeof raise === "string") return raise;
      if (raise && typeof raise.name === "string") return raise.name;
      return null;
    })
    .filter((name): name is string => Boolean(name));
}
