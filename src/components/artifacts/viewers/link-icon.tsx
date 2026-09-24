"use client";
import { AtSign, Briefcase, GitBranch, GitMerge, Link2, MonitorPlay, PenTool } from "lucide-react";

import { brandIconFor } from "../artifact-view-model";

/**
 * lucide 1.x dropped brand icons (Github/Youtube/…). Maps `brandIconFor`'s name to the closest
 * generic icon — picked from the hostname alone, with no network call (favicon).
 */
export function LinkIcon({ url, className }: { url: string | null; className?: string }) {
  const props = { className, "aria-hidden": true } as const;
  switch (url ? brandIconFor(url) : null) {
    case "github":
      return <GitBranch {...props} />;
    case "gitlab":
      return <GitMerge {...props} />;
    case "youtube":
      return <MonitorPlay {...props} />;
    case "figma":
      return <PenTool {...props} />;
    case "twitter":
      return <AtSign {...props} />;
    case "linkedin":
      return <Briefcase {...props} />;
    default:
      return <Link2 {...props} />;
  }
}
