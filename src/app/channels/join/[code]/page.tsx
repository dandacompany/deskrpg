"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { useT } from "@/lib/i18n";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";

export default function JoinChannelPage() {
  const t = useT();
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-bg text-text">
          {t("common.loading")}
        </div>
      }
    >
      <JoinChannelPageInner />
    </Suspense>
  );
}

function JoinChannelPageInner() {
  const router = useRouter();
  const params = useParams();
  const code = params.code as string;
  const t = useT();

  const [error, setError] = useState("");

  useEffect(() => {
    if (!code) return;

    fetch(`/api/channels/join/${code}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setError(getLocalizedErrorMessage(t, data));
          return;
        }

        // No character is picked — the game screen reads my character, and if none exists sends me to create one and come back.
        router.replace(`/game?channelId=${data.channel.id}`);
      })
      .catch(() => {
        setError(t("errors.failedToResolveInviteCode"));
      });
  }, [code, router, t]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg text-text">
        <div className="text-center">
          <div className="text-xl mb-4 text-danger">{error}</div>
          <Link
            href="/channels"
            className="px-4 py-2 bg-primary hover:bg-primary-hover rounded font-semibold text-white"
          >
            {t("channels.backToChannels")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg text-text">
      {t("password.joining")}
    </div>
  );
}
