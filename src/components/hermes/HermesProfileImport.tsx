"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { employeeDetailHref } from "@/app/profiles/hire-navigation";
import { useT } from "@/lib/i18n";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";

type Importable = { name: string; description: string };

/**
 * Profiles that already live in this gateway's Hermes but are not employees yet — made on the
 * host with `hermes profile create`, or before DeskRPG connected. One click issues the profile a
 * key (the plugin, owner key), stores it, and clocks the employee in. A profile that already has a
 * key is only re-keyed after the owner confirms, because that cuts off whatever used the old key.
 * Rendered for the gateway owner only.
 */
export default function HermesProfileImport({
  gatewayId,
  onImported,
}: {
  gatewayId: string;
  onImported: () => void;
}) {
  const t = useT();
  const [rows, setRows] = useState<Importable[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [needsRotate, setNeedsRotate] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/gateways/${gatewayId}/plugin/profiles/importable`);
      const data = await res.json().catch(() => ({}));
      setRows(!data.errorCode && Array.isArray(data.profiles) ? data.profiles : []);
    } catch {
      setRows([]);
    }
  }, [gatewayId]);

  useEffect(() => {
    void load();
  }, [load]);

  const importProfile = async (name: string, rotate: boolean) => {
    setBusy(name);
    setError("");
    setDone(null);
    try {
      const res = await fetch(
        `/api/gateways/${gatewayId}/plugin/profiles/${encodeURIComponent(name)}/import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rotate ? { rotate: true } : {}),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (data.errorCode || !res.ok) {
        setNeedsRotate(data.errorCode === "key_exists" ? name : null);
        setError(getLocalizedErrorMessage(t, data, "common.error"));
        return;
      }
      setNeedsRotate(null);
      setDone(name);
      setRows((prev) => prev.filter((row) => row.name !== name));
      onImported();
    } catch (err) {
      setError(getLocalizedErrorMessage(t, err, "errors.connectionFailed"));
    } finally {
      setBusy(null);
    }
  };

  if (rows.length === 0 && !done && !error) return null;

  return (
    <div className="space-y-2 border-t border-border pt-4">
      <h3 className="text-sm font-semibold">{t("gateway.profile.import.title")}</h3>
      <p className="text-xs text-text-muted">{t("gateway.profile.import.hint")}</p>
      {rows.map((row) => (
        <div
          key={row.name}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{row.name}</p>
            {row.description && (
              <p className="truncate text-xs text-text-muted">{row.description}</p>
            )}
          </div>
          {needsRotate === row.name ? (
            <button
              type="button"
              data-import-rotate={row.name}
              disabled={busy !== null}
              onClick={() => void importProfile(row.name, true)}
              className="rounded-lg border border-danger/50 px-3 py-1.5 text-xs font-semibold text-danger hover:bg-danger-bg disabled:opacity-50"
            >
              {t("gateway.profile.import.rotate")}
            </button>
          ) : (
            <button
              type="button"
              data-import-profile={row.name}
              disabled={busy !== null}
              onClick={() => void importProfile(row.name, false)}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
            >
              {busy === row.name
                ? t("gateway.profile.import.importing")
                : t("gateway.profile.import.button")}
            </button>
          )}
        </div>
      ))}
      {error && <p className="text-xs text-danger">{error}</p>}
      {done && (
        <p className="text-xs text-success" role="status">
          {t("gateway.profile.import.done", { name: done })}{" "}
          <Link href={employeeDetailHref(gatewayId, done)} className="underline">
            {t("gateway.profile.import.setup")}
          </Link>
        </p>
      )}
    </div>
  );
}
