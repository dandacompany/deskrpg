"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { useT } from "@/lib/i18n";
import { getLocalizedErrorMessage, withHeaderErrorCode } from "@/lib/i18n/error-codes";
import { planPasswordChange } from "./change-plan";

export default function AccountPasswordPage() {
  // useSearchParams needs a Suspense boundary so static rendering does not break (same approach as admin/groups).
  return (
    <Suspense fallback={null}>
      <AccountPasswordPageInner />
    </Suspense>
  );
}

function AccountPasswordPageInner() {
  const t = useT();
  const router = useRouter();
  const searchParams = useSearchParams();
  // People who came in with a temporary password are sent here by the login screen with ?forced=1.
  const forced = searchParams.get("forced") === "1";

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);

    const plan = planPasswordChange({ current, next, confirm });
    if (!plan.ok) {
      setError(getLocalizedErrorMessage(t, { errorCode: plan.errorCode }));
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/account/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(plan.body),
      });
      if (!response.ok) {
        const payload = withHeaderErrorCode(
          await response.json().catch(() => ({})),
          response.headers,
        );
        setError(getLocalizedErrorMessage(t, payload, "common.unknown"));
        return;
      }
      setSaved(true);
      setCurrent("");
      setNext("");
      setConfirm("");
      if (forced) router.push("/gateways");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="theme-web workspace-page">
      <div className="workspace-page-inner workspace-page-inner--narrow">
        <h1 className="text-3xl font-bold">{t("account.password.title")}</h1>
        <p className="mt-1 text-text-muted">{t("account.password.description")}</p>

        {forced && (
          <p className="mt-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {t("account.password.forced")}
          </p>
        )}

        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            {t("account.password.current")}
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              className="rounded border border-border bg-surface px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("account.password.new")}
            <input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              className="rounded border border-border bg-surface px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("account.password.confirm")}
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              className="rounded border border-border bg-surface px-3 py-2"
            />
          </label>

          {error && <p className="text-sm text-danger">{error}</p>}
          {saved && <p className="text-sm text-green-700">{t("account.password.saved")}</p>}

          <button
            type="submit"
            disabled={saving}
            className="self-start rounded bg-primary px-4 py-2 text-white disabled:opacity-60"
          >
            {t("account.password.submit")}
          </button>
        </form>
      </div>
    </div>
  );
}
