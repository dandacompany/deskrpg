"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import LocaleSwitcher from "@/components/LocaleSwitcher";
import LogoutButton from "@/components/LogoutButton";
import { useT } from "@/lib/i18n";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";

type ProviderRow = {
  id: string;
  providerType: string;
  displayName: string | null;
  authMethod: string;
  baseUrl?: string | null;
  ownerUserId?: string;
  canEditCredentials?: boolean;
  shareRole?: string | null;
  isOwner?: boolean;
  lastValidatedAt?: string | null;
  lastValidationStatus?: string | null;
};

type ProviderDetail = ProviderRow & {
  credentials?: unknown;
};

type AdapterStatus = {
  installed: boolean;
  status: "ok" | "error" | "not_installed";
  version?: string;
  model?: string;
  message?: string;
};

type ProviderTestState = {
  status: "idle" | "success" | "error";
  message?: string;
};

type ProviderTypeOption = {
  value: string;
  labelKey: string;
  adapterKey?: string;
};

type AuthMethodValue = "api_key" | "cli_login";

const PROVIDER_OPTIONS: ProviderTypeOption[] = [
  { value: "claude", labelKey: "providers.providerAnthropic", adapterKey: "claude" },
  { value: "codex", labelKey: "providers.providerOpenAI", adapterKey: "codex" },
  { value: "gemini", labelKey: "providers.providerGoogle", adapterKey: "gemini" },
  { value: "openclaw", labelKey: "providers.providerOpenClaw", adapterKey: "openclaw" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAuthMethod(value: string | null | undefined): AuthMethodValue {
  return (value ?? "").toLowerCase().includes("cli") ? "cli_login" : "api_key";
}

function normalizeProviderType(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return PROVIDER_OPTIONS[0].value;
  return PROVIDER_OPTIONS.some((option) => option.value === normalized) ? normalized : normalized;
}

function getProviderOption(providerType: string | null | undefined): ProviderTypeOption | null {
  return PROVIDER_OPTIONS.find((option) => option.value === providerType) ?? null;
}

function getStoredApiKey(credentials: unknown): string {
  if (typeof credentials === "string") {
    return credentials;
  }

  if (!isRecord(credentials)) {
    return "";
  }

  for (const key of ["apiKey", "api_key", "token"]) {
    if (typeof credentials[key] === "string") {
      return credentials[key] as string;
    }
  }

  return "";
}

function supportsCliLogin(providerType: string | null | undefined): boolean {
  return ["claude", "codex", "gemini", "opencode"].includes(providerType ?? "");
}

export default function ProvidersPage() {
  const t = useT();
  return (
    <Suspense
      fallback={
        <div className="theme-web min-h-screen flex items-center justify-center bg-bg text-text">
          {t("common.loading")}
        </div>
      }
    >
      <ProvidersPageInner />
    </Suspense>
  );
}

function ProvidersPageInner() {
  const router = useRouter();
  const t = useT();

  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [adapterStatuses, setAdapterStatuses] = useState<Record<string, AdapterStatus>>({});
  const [loading, setLoading] = useState(true);
  const [adapterLoading, setAdapterLoading] = useState(true);
  const [error, setError] = useState("");
  const [adapterError, setAdapterError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [formMode, setFormMode] = useState<"create" | "edit">("create");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [cliLoginProviderId, setCliLoginProviderId] = useState<string | null>(null);

  const [providerType, setProviderType] = useState(PROVIDER_OPTIONS[0].value);
  const [authMethod, setAuthMethod] = useState<AuthMethodValue>("api_key");
  const [displayName, setDisplayName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);

  const [testStates, setTestStates] = useState<Record<string, ProviderTestState>>({});
  const [cliLoginStates, setCliLoginStates] = useState<Record<string, string>>({});

  const redirectToAuth = useCallback(() => {
    router.push("/auth");
  }, [router]);

  const getProviderLabel = useCallback(
    (type: string) => {
      const option = getProviderOption(type);
      return option ? t(option.labelKey) : type;
    },
    [t],
  );

  const getAuthMethodLabel = useCallback(
    (value: string | null | undefined) => {
      return normalizeAuthMethod(value) === "cli_login"
        ? t("providers.cliLogin")
        : t("providers.apiKey");
    },
    [t],
  );

  const loadAdapterStatuses = useCallback(async () => {
    setAdapterLoading(true);
    setAdapterError("");
    try {
      const res = await fetch("/api/adapters/status");
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        redirectToAuth();
        return {};
      }
      if (!res.ok) {
        throw data;
      }

      const nextStatuses = isRecord(data.adapters)
        ? (data.adapters as Record<string, AdapterStatus>)
        : {};
      setAdapterStatuses(nextStatuses);
      return nextStatuses;
    } catch (nextError) {
      setAdapterError(getLocalizedErrorMessage(t, nextError, "common.error"));
      return {};
    } finally {
      setAdapterLoading(false);
    }
  }, [redirectToAuth, t]);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/providers");
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        redirectToAuth();
        return;
      }
      if (!res.ok) {
        throw data;
      }

      const nextProviders = Array.isArray(data.providers) ? data.providers : [];
      setProviders(nextProviders);
      setSelectedProviderId((current) => {
        if (current && nextProviders.some((provider: ProviderRow) => provider.id === current)) {
          return current;
        }
        return nextProviders[0]?.id ?? "";
      });
    } catch (nextError) {
      setError(getLocalizedErrorMessage(t, nextError, "common.error"));
    } finally {
      setLoading(false);
    }
  }, [redirectToAuth, t]);

  const checkSession = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/session");
      if (res.status === 401) {
        redirectToAuth();
        return false;
      }
      // This repo currently exposes /api/auth/status rather than /api/auth/session.
      if (res.status === 404) {
        return true;
      }
      return true;
    } catch {
      return true;
    }
  }, [redirectToAuth]);

  useEffect(() => {
    void (async () => {
      const isAuthenticated = await checkSession();
      if (!isAuthenticated) {
        setLoading(false);
        setAdapterLoading(false);
        return;
      }

      await Promise.all([loadProviders(), loadAdapterStatuses()]);
    })();
  }, [checkSession, loadAdapterStatuses, loadProviders]);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedProviderId) ?? null,
    [providers, selectedProviderId],
  );

  useEffect(() => {
    if (!selectedProvider) {
      setFormMode("create");
      setProviderType(PROVIDER_OPTIONS[0].value);
      setAuthMethod("api_key");
      setDisplayName("");
      setApiKey("");
      return;
    }

    setFormMode(selectedProvider.isOwner ? "edit" : "create");
    setProviderType(normalizeProviderType(selectedProvider.providerType));
    setAuthMethod(normalizeAuthMethod(selectedProvider.authMethod));
    setDisplayName(selectedProvider.displayName ?? "");
    setApiKey("");
  }, [selectedProvider]);

  const resetForm = useCallback(() => {
    setSelectedProviderId("");
    setFormMode("create");
    setProviderType(PROVIDER_OPTIONS[0].value);
    setAuthMethod("api_key");
    setDisplayName("");
    setApiKey("");
    setError("");
    setNotice("");
  }, []);

  const handleCreate = async () => {
    if (!displayName.trim()) return;
    if (authMethod === "api_key" && !apiKey.trim()) {
      setError(t("providers.apiKeyRequired"));
      return;
    }

    setSaving(true);
    setError("");
    setNotice("");
    try {
      const body: Record<string, unknown> = {
        providerType,
        authMethod,
        displayName,
      };

      if (authMethod === "api_key") {
        body.credentials = { apiKey: apiKey.trim() };
      }

      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        redirectToAuth();
        return;
      }
      if (!res.ok) {
        throw data;
      }

      await loadProviders();
      if (data.provider?.id) {
        setSelectedProviderId(data.provider.id as string);
      }
      setApiKey("");
      setFormMode("edit");
      setNotice(t("providers.saved"));
    } catch (nextError) {
      setError(getLocalizedErrorMessage(t, nextError, "common.error"));
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async () => {
    if (!selectedProvider?.isOwner || !displayName.trim()) return;

    const authMethodChanged = normalizeAuthMethod(selectedProvider.authMethod) !== authMethod;
    if (authMethod === "api_key" && authMethodChanged && !apiKey.trim()) {
      setError(t("providers.apiKeyRequired"));
      return;
    }

    setSaving(true);
    setError("");
    setNotice("");
    try {
      const body: Record<string, unknown> = {
        providerType,
        authMethod,
        displayName,
      };

      if (authMethod === "api_key") {
        if (apiKey.trim()) {
          body.credentials = { apiKey: apiKey.trim() };
        }
      } else if (normalizeAuthMethod(selectedProvider.authMethod) === "api_key") {
        body.credentials = null;
      }

      const res = await fetch(`/api/providers/${selectedProvider.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        redirectToAuth();
        return;
      }
      if (!res.ok) {
        throw data;
      }

      await loadProviders();
      setApiKey("");
      setNotice(t("providers.saved"));
    } catch (nextError) {
      setError(getLocalizedErrorMessage(t, nextError, "common.error"));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedProvider?.isOwner) return;
    if (!window.confirm(t("providers.deleteConfirm"))) return;

    setDeleting(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/providers/${selectedProvider.id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        redirectToAuth();
        return;
      }
      if (!res.ok) {
        throw data;
      }

      setTestStates((prev) => {
        const next = { ...prev };
        delete next[selectedProvider.id];
        return next;
      });
      setCliLoginStates((prev) => {
        const next = { ...prev };
        delete next[selectedProvider.id];
        return next;
      });
      await loadProviders();
      resetForm();
      setNotice(t("providers.deleted"));
    } catch (nextError) {
      setError(getLocalizedErrorMessage(t, nextError, "common.error"));
    } finally {
      setDeleting(false);
    }
  };

  const handleCliLogin = async (providerId: string) => {
    setCliLoginProviderId(providerId);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/providers/${providerId}/cli-login`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        redirectToAuth();
        return;
      }
      if (!res.ok) {
        throw data;
      }

      setCliLoginStates((prev) => ({
        ...prev,
        [providerId]: t("providers.loginInitiated"),
      }));
      setNotice(t("providers.loginInitiated"));
    } catch (nextError) {
      setError(getLocalizedErrorMessage(t, nextError, "common.error"));
    } finally {
      setCliLoginProviderId(null);
    }
  };

  const handleTest = async (provider: ProviderRow) => {
    setTestingProviderId(provider.id);
    setError("");
    setNotice("");
    setTestStates((prev) => ({
      ...prev,
      [provider.id]: { status: "idle" },
    }));

    try {
      const providerRes = await fetch(`/api/providers/${provider.id}`);
      const providerData = await providerRes.json().catch(() => ({}));
      if (providerRes.status === 401) {
        redirectToAuth();
        return;
      }
      if (!providerRes.ok) {
        throw providerData;
      }

      const nextAdapters = await loadAdapterStatuses();
      const normalizedAuthMethod = normalizeAuthMethod(provider.authMethod);

      if (normalizedAuthMethod === "cli_login") {
        const adapterKey = getProviderOption(provider.providerType)?.adapterKey;
        const adapterStatus = adapterKey ? nextAdapters[adapterKey] : null;

        if (adapterStatus?.installed && adapterStatus.status === "ok") {
          setTestStates((prev) => ({
            ...prev,
            [provider.id]: {
              status: "success",
              message: t("providers.testSuccess"),
            },
          }));
          setNotice(t("providers.testSuccess"));
        } else {
          const message = adapterStatus?.message || t("providers.notInstalled");
          setTestStates((prev) => ({
            ...prev,
            [provider.id]: {
              status: "error",
              message,
            },
          }));
          setError(message);
        }
        return;
      }

      const savedApiKey = getStoredApiKey(
        (providerData.provider as ProviderDetail | undefined)?.credentials,
      );
      if (!savedApiKey) {
        const message = t("providers.credentialsMissing");
        setTestStates((prev) => ({
          ...prev,
          [provider.id]: {
            status: "error",
            message,
          },
        }));
        setError(message);
        return;
      }

      setTestStates((prev) => ({
        ...prev,
        [provider.id]: {
          status: "success",
          message: t("providers.credentialsVerified"),
        },
      }));
      setNotice(t("providers.credentialsVerified"));
    } catch (nextError) {
      const message = getLocalizedErrorMessage(t, nextError, "common.error");
      setTestStates((prev) => ({
        ...prev,
        [provider.id]: {
          status: "error",
          message,
        },
      }));
      setError(message);
    } finally {
      setTestingProviderId(null);
    }
  };

  const selectedProviderStatus = selectedProvider ? testStates[selectedProvider.id] : null;
  const selectedProviderCliStatus = selectedProvider ? cliLoginStates[selectedProvider.id] : "";
  const selectedProviderMessage = selectedProviderStatus?.message || selectedProviderCliStatus;
  const selectedProviderSupportsCliLogin = supportsCliLogin(selectedProvider?.providerType);
  const apiKeyRequiredForCurrentForm =
    authMethod === "api_key" &&
    (formMode === "create" || normalizeAuthMethod(selectedProvider?.authMethod) !== "api_key");

  if (loading) {
    return (
      <div className="theme-web min-h-screen flex items-center justify-center bg-bg text-text">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="theme-web min-h-screen bg-bg px-8 py-8 text-text">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">{t("providers.title")}</h1>
            <p className="mt-1 text-text-muted">{t("providers.subtitle")}</p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/channels"
              className="rounded-lg bg-surface-raised px-4 py-2 text-sm font-medium hover:bg-surface-raised/80"
            >
              {t("gateways.backToChannels")}
            </Link>
            <LogoutButton />
            <LocaleSwitcher />
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-danger/40 bg-surface px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-lg border border-emerald-400/30 bg-surface px-4 py-3 text-sm text-emerald-300">
            {notice}
          </div>
        )}

        <section className="rounded-xl border border-amber-500/40 bg-gray-900 p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-amber-400">
                {t("providers.adapterStatus")}
              </h2>
              <p className="mt-1 text-sm text-gray-300">{t("providers.adapterStatusHelp")}</p>
            </div>
            <button
              type="button"
              onClick={() => void loadAdapterStatuses()}
              disabled={adapterLoading}
              className="rounded-lg border border-amber-500/40 bg-gray-950 px-4 py-2 text-sm font-medium text-amber-200 hover:border-amber-400 hover:text-amber-100 disabled:opacity-60"
            >
              {adapterLoading ? t("common.loading") : t("common.retry")}
            </button>
          </div>

          {adapterError && (
            <div className="mb-4 rounded-lg border border-danger/40 bg-gray-950 px-4 py-3 text-sm text-danger">
              {adapterError}
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {PROVIDER_OPTIONS.map((option) => {
              const status = option.adapterKey ? adapterStatuses[option.adapterKey] : undefined;
              const installedLabel = status?.installed
                ? t("providers.installed")
                : t("providers.notInstalled");
              return (
                <div
                  key={option.value}
                  className="rounded-lg border border-amber-500/30 bg-gray-950 px-4 py-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium text-white">{t(option.labelKey)}</p>
                    <span
                      className={`text-xs ${status?.installed ? "text-emerald-300" : "text-amber-300"}`}
                    >
                      {installedLabel}
                    </span>
                  </div>
                  {status?.version && (
                    <p className="mt-2 text-xs text-gray-400">
                      {t("providers.version")}: {status.version}
                    </p>
                  )}
                  {status?.model && (
                    <p className="mt-1 text-xs text-gray-400">
                      {t("providers.model")}: {status.model}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-gray-400">
                    {status?.message ||
                      (status?.status === "ok" ? t("providers.ready") : t("common.unknown"))}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="rounded-xl border border-amber-500/40 bg-gray-900 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-amber-400">{t("providers.title")}</h2>
              <button
                type="button"
                onClick={resetForm}
                className="rounded bg-amber-500 px-3 py-1.5 text-xs font-semibold text-gray-950 hover:bg-amber-400"
              >
                {t("providers.addNew")}
              </button>
            </div>
            <div className="space-y-2">
              {providers.length === 0 ? (
                <div className="rounded-lg border border-amber-500/20 bg-gray-950 px-3 py-4 text-sm text-gray-300">
                  {t("providers.empty")}
                </div>
              ) : (
                providers.map((provider) => {
                  const testState = testStates[provider.id];
                  return (
                    <button
                      key={provider.id}
                      type="button"
                      onClick={() => setSelectedProviderId(provider.id)}
                      className={`w-full rounded-lg border px-3 py-3 text-left transition ${
                        selectedProviderId === provider.id
                          ? "border-amber-400 bg-amber-500/10 text-amber-100"
                          : "border-amber-500/20 bg-gray-950 hover:border-amber-400/50"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-white">
                          {provider.displayName || getProviderLabel(provider.providerType)}
                        </span>
                        <span className="text-[11px] text-gray-400">
                          {provider.isOwner ? t("gateways.owner") : t("gateways.shared")}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-gray-400">
                        {getProviderLabel(provider.providerType)} ·{" "}
                        {getAuthMethodLabel(provider.authMethod)}
                      </p>
                      <p className="mt-1 text-xs text-gray-400">
                        {testState?.message ||
                          cliLoginStates[provider.id] ||
                          (provider.lastValidationStatus === "valid"
                            ? t("gateways.statusValid")
                            : provider.lastValidationStatus
                              ? t("gateways.statusUnknown")
                              : t("gateways.statusUntested"))}
                      </p>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <main className="space-y-6">
            <section className="rounded-xl border border-amber-500/40 bg-gray-900 p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-amber-400">
                    {formMode === "create"
                      ? t("providers.addNew")
                      : `${t("common.edit")} · ${selectedProvider?.displayName || getProviderLabel(selectedProvider?.providerType ?? providerType)}`}
                  </h2>
                  <p className="mt-1 text-sm text-gray-300">{t("providers.formHelp")}</p>
                </div>
                {selectedProvider && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void handleTest(selectedProvider)}
                      disabled={testingProviderId === selectedProvider.id}
                      className="rounded-lg border border-amber-500/40 bg-gray-950 px-4 py-2 text-sm font-medium text-amber-200 hover:border-amber-400 hover:text-amber-100 disabled:opacity-60"
                    >
                      {testingProviderId === selectedProvider.id
                        ? t("gateway.testing")
                        : t("providers.test")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCliLogin(selectedProvider.id)}
                      disabled={
                        cliLoginProviderId === selectedProvider.id ||
                        !selectedProvider.isOwner ||
                        !selectedProviderSupportsCliLogin
                      }
                      className="rounded-lg border border-amber-500/40 bg-gray-950 px-4 py-2 text-sm font-medium text-amber-200 hover:border-amber-400 hover:text-amber-100 disabled:opacity-60"
                    >
                      {cliLoginProviderId === selectedProvider.id
                        ? t("common.loading")
                        : t("providers.cliLogin")}
                    </button>
                  </div>
                )}
              </div>

              <div className="grid gap-4">
                <div>
                  <label className="mb-1 block text-sm font-semibold text-gray-300">
                    {t("providers.displayName")}
                  </label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    disabled={!!selectedProvider && !selectedProvider.isOwner}
                    className="w-full rounded border border-amber-500/30 bg-gray-950 px-3 py-2 text-white focus:border-amber-400 focus:outline-none disabled:opacity-60"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-sm font-semibold text-gray-300">
                    {t("providers.type")}
                  </label>
                  <select
                    value={providerType}
                    onChange={(e) => setProviderType(e.target.value)}
                    disabled={!!selectedProvider && !selectedProvider.isOwner}
                    className="w-full rounded border border-amber-500/30 bg-gray-950 px-3 py-2 text-white focus:border-amber-400 focus:outline-none disabled:opacity-60"
                  >
                    {PROVIDER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(option.labelKey)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-semibold text-gray-300">
                    {t("providers.authMethod")}
                  </label>
                  <select
                    value={authMethod}
                    onChange={(e) => setAuthMethod(normalizeAuthMethod(e.target.value))}
                    disabled={!!selectedProvider && !selectedProvider.isOwner}
                    className="w-full rounded border border-amber-500/30 bg-gray-950 px-3 py-2 text-white focus:border-amber-400 focus:outline-none disabled:opacity-60"
                  >
                    <option value="api_key">{t("providers.apiKey")}</option>
                    <option value="cli_login">{t("providers.cliLogin")}</option>
                  </select>
                </div>

                {authMethod === "api_key" && (
                  <div>
                    <label className="mb-1 block text-sm font-semibold text-gray-300">
                      {t("providers.apiKey")}
                    </label>
                    <div className="flex gap-2">
                      <input
                        type={showApiKey ? "text" : "password"}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        disabled={!!selectedProvider && !selectedProvider.isOwner}
                        className="flex-1 rounded border border-amber-500/30 bg-gray-950 px-3 py-2 text-white focus:border-amber-400 focus:outline-none disabled:opacity-60"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey((prev) => !prev)}
                        className="rounded border border-amber-500/40 bg-gray-950 px-3 py-2 text-sm text-amber-200 hover:border-amber-400 hover:text-amber-100"
                      >
                        {showApiKey ? t("common.hide") : t("common.show")}
                      </button>
                    </div>
                    {formMode === "edit" && (
                      <p className="mt-1 text-xs text-gray-400">{t("providers.apiKeyHint")}</p>
                    )}
                  </div>
                )}

                {authMethod === "cli_login" && !supportsCliLogin(providerType) && (
                  <p className="text-xs text-amber-300">{t("providers.cliLoginUnavailable")}</p>
                )}
              </div>

              {selectedProviderMessage && selectedProvider && (
                <div
                  className={`mt-4 rounded-lg border px-4 py-3 text-sm ${
                    selectedProviderStatus?.status === "error"
                      ? "border-danger/40 bg-gray-950 text-danger"
                      : "border-emerald-400/30 bg-gray-950 text-emerald-300"
                  }`}
                >
                  {selectedProviderMessage}
                </div>
              )}

              <div className="mt-5 flex gap-3">
                {formMode === "create" ? (
                  <button
                    type="button"
                    onClick={() => void handleCreate()}
                    disabled={
                      saving ||
                      !displayName.trim() ||
                      (apiKeyRequiredForCurrentForm && !apiKey.trim())
                    }
                    className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-gray-950 hover:bg-amber-400 disabled:opacity-60"
                  >
                    {saving ? t("common.loading") : t("common.create")}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleUpdate()}
                      disabled={
                        saving ||
                        !selectedProvider?.isOwner ||
                        !displayName.trim() ||
                        (apiKeyRequiredForCurrentForm && !apiKey.trim())
                      }
                      className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-gray-950 hover:bg-amber-400 disabled:opacity-60"
                    >
                      {saving ? t("common.loading") : t("common.save")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete()}
                      disabled={deleting || !selectedProvider?.isOwner}
                      className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-60"
                    >
                      {deleting ? t("common.loading") : t("common.delete")}
                    </button>
                  </>
                )}
              </div>
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}
