"use client";

import { AlertCircle, CheckCircle2, PauseCircle } from "lucide-react";
import { Badge, Card } from "@/components/ui";
import { useT } from "@/lib/i18n";

/**
 * 게이트웨이 연결 상태 카드.
 *
 * OpenClawPairingStatusCard 를 이어받되 `pairing-required` 상태를 걷어낸 것이다. 그 상태는
 * OpenClaw 의 디바이스 승인 절차(`openclaw devices approve <id>`) 전용이었고, Hermes 는
 * 프로필별 API 키로 인증하므로 승인시켜야 할 디바이스라는 개념 자체가 없다.
 *
 * 카드를 통째로 지우지 않은 이유: 이 카드가 그리던 상태에는 페어링뿐 아니라 **연결 테스트
 * 성공/실패 결과**가 함께 실려 있었다. 카드만 지우면 화면에서 그 정보가 사라지고, 그 상태를
 * 쓰는 쪽은 남은 채 읽는 쪽만 끊긴다.
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
      className={["p-4", "border", "bg-surface/90", presentation.borderClassName, className].join(" ")}
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
