"use client";

import { useParams } from "next/navigation";

import GatewayShares from "@/components/gateway/GatewayShares";

/** `/gateways/[id]/share` — sharing one gateway. The screen lives in `GatewayShares`. */
export default function GatewaySharePage() {
  const params = useParams<{ id: string }>();
  return <GatewayShares gatewayId={params.id} />;
}
