"use client";

import { AlertCircle, CheckCircle2, PauseCircle } from "lucide-react";
import { Badge, Card } from "@/components/ui";
import { useT } from "@/lib/i18n";

/**
 * The gateway connection status card.
 *
 * Inherited from OpenClawPairingStatusCard, with the `pairing-required` state removed. That
 * state was specific to OpenClaw's device-approval flow (`openclaw devices approve <id>`), and
 * Hermes authenticates with a per-profile API key, so there's no concept of a device to approve.
 *
 * Why the card wasn't deleted outright: the state this card rendered carried not just pairing
 * but also the **connection test's success/failure result**. Deleting just the card would make
 * that information disappear from the screen, leaving the writer side intact while cutting off
 * the reader side.
 */
export type GatewayStatus = "idle" | "connected" | "error";

export interface GatewayStatusCardProps {
  status: GatewayStatus;
  error?: string | null;
  title?: string;
  detail?: string | null;
  className?: string;
}

type StatusPresentation = {
  badgeVariant: "default" | "success" | "danger";
  borderClassName: string;
  icon: typeof PauseCircle;
  statusKey: string;
  descriptionKey: string;
};

const STATUS_PRESENTATION: Record<GatewayStatus, StatusPresentation> = {
  idle: {
    badgeVariant: "default",
    borderClassName: "border-border",
    icon: PauseCircle,
    statusKey: "gateway.statusCard.status.idle",
    descriptionKey: "gateway.statusCard.description.idle",
  },
  connected: {
    badgeVariant: "success",
    borderClassName: "border-success/40",
    icon: CheckCircle2,
    statusKey: "gateway.statusCard.status.connected",
    descriptionKey: "gateway.statusCard.description.connected",
  },
  error: {
    badgeVariant: "danger",
    borderClassName: "border-danger/40",
    icon: AlertCircle,
    statusKey: "gateway.statusCard.status.error",
    descriptionKey: "gateway.statusCard.description.error",
  },
};

export default function GatewayStatusCard({
  status,
  error,
  title,
  detail,
  className = "",
}: GatewayStatusCardProps) {
  const t = useT();
  const presentation = STATUS_PRESENTATION[status] ?? STATUS_PRESENTATION.idle;
  const Icon = presentation.icon;

  return (
    <Card
      className={["p-4", "border", "bg-surface/90", presentation.borderClassName, className].join(
        " ",
      )}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant={presentation.badgeVariant} size="md">
              <Icon className="h-3.5 w-3.5" />
              {t(presentation.statusKey)}
            </Badge>
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-text">
              {title ?? t("gateway.statusCard.title")}
            </h3>
            <p className="text-sm text-text-secondary">
              {detail ?? t(presentation.descriptionKey)}
            </p>
          </div>
        </div>
        {status === "error" && error ? (
          <div className="max-w-xl rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
