"use client";

import Link from "next/link";

import DiagnosticsPanel from "@/components/gateway/DiagnosticsPanel";
import { useT } from "@/lib/i18n";

/**
 * `/gateways/diagnostics` — the admin report (`deskrpg doctor` on screen), moved off the
 * connection screen. For anyone else the server answers 404 and the panel renders nothing, so
 * the page shows only the way back.
 */
export default function GatewayDiagnosticsPage() {
  const t = useT();
  return (
    <div className="theme-web workspace-page">
      <div className="workspace-page-inner max-w-3xl">
        <Link
          href="/gateways"
          data-back-to-gateways=""
          className="text-sm text-text-muted hover:text-text"
        >
          ← {t("gateways.backToGateways")}
        </Link>
        <div className="mt-4">
          <DiagnosticsPanel expanded />
        </div>
      </div>
    </div>
  );
}
