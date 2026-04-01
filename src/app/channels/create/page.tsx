"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { NPC_PRESETS } from "@/lib/npc-presets";
import { PERSONA_PRESETS, applyPresetName } from "@/lib/npc-persona-presets";
import { useLocale, useT } from "@/lib/i18n";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";
import { ChevronRight } from "lucide-react";
import MapTemplateGrid from "@/components/map-editor/MapTemplateGrid";
import { getDefaultMeetingProtocol, localizeNpcPromptDocument } from "@/lib/npc-agent-defaults";
import { CHANNEL_PASSWORD_MIN_LENGTH } from "@/lib/security-policy";
import type { GroupMemberRole } from "@/lib/rbac/constants";

interface GroupOption {
  id: string;
  name: string;
  role?: GroupMemberRole;
  canCreateChannel?: boolean;
}

export default function CreateChannelPage() {
  const t = useT();
  return (
    <Suspense
      fallback={
        <div className="theme-web min-h-screen flex items-center justify-center bg-bg text-text">
          {t("common.loading")}
        </div>
      }
    >
      <CreateChannelPageInner />
    </Suspense>
  );
}

function CreateChannelPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const characterId = searchParams.get("characterId");
  const t = useT();
  const { locale } = useLocale();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [mapTemplateId, setMapTemplateId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // --- AI Gateway ---
  const [gatewayOpen, setGatewayOpen] = useState(false);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [gatewayToken, setGatewayToken] = useState("");
  const [showGatewayToken, setShowGatewayToken] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    agents?: { id: string; name: string }[];
    error?: string;
    errorCode?: string;
    messageCode?: string;
  } | null>(null);

  // --- Default NPC ---
  const [npcName, setNpcName] = useState("");
  const [agentAction, setAgentAction] = useState<"select" | "create">("create");
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [newAgentId, setNewAgentId] = useState("");
  const [personaPresetId, setPersonaPresetId] = useState("custom");
  const [npcIdentity, setNpcIdentity] = useState("");
  const [npcSoul, setNpcSoul] = useState("");
  const [npcAdvancedOpen, setNpcAdvancedOpen] = useState(false);
  const [npcAppearancePreset, setNpcAppearancePreset] = useState("receptionist");

  // Auto-select template from URL param
  useEffect(() => {
    const urlTemplateId = searchParams.get("templateId");
    if (urlTemplateId) setMapTemplateId(urlTemplateId);
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/groups")
      .then((res) => (res.ok ? res.json() : { groups: [] }))
      .then((data) => {
        if (cancelled) return;
        const nextGroups = Array.isArray(data.groups) ? data.groups : [];
        setGroups(nextGroups);
        setGroupId((currentGroupId) => {
          const creatableGroups = nextGroups.filter((group: GroupOption) => group.canCreateChannel);
          if (currentGroupId && creatableGroups.some((group: GroupOption) => group.id === currentGroupId)) {
            return currentGroupId;
          }

          const preferredGroup = creatableGroups.find((group: GroupOption) => group.role !== "member")
            ?? creatableGroups[0];
          return preferredGroup?.id ?? "";
        });
        setLoadingGroups(false);
      })
      .catch(() => {
        if (cancelled) return;
        setGroups([]);
        setLoadingGroups(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const hasGatewayUrl = gatewayUrl.trim().length > 0;
  const hasTestAgents = testResult?.ok && testResult.agents && testResult.agents.length > 0;
  const creatableGroups = groups.filter((group) => group.canCreateChannel);
  const hasAvailableGroups = creatableGroups.length > 0;

  const handlePersonaPresetChange = useCallback((presetId: string) => {
    setPersonaPresetId(presetId);
    if (presetId === "custom") return;
    const preset = PERSONA_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const currentName = npcName.trim() || t("npc.namePlaceholder");
    setNpcIdentity(localizeNpcPromptDocument(applyPresetName(preset.identity, currentName), locale, "identity"));
    setNpcSoul(localizeNpcPromptDocument(applyPresetName(preset.soul, currentName), locale, "soul"));
    if (preset.suggestedAppearancePreset) {
      setNpcAppearancePreset(preset.suggestedAppearancePreset);
    }
  }, [locale, npcName, t]);

  const handleNpcNameBlur = () => {
    // Re-apply preset with updated name
    if (personaPresetId !== "custom") {
      const preset = PERSONA_PRESETS.find((p) => p.id === personaPresetId);
      if (preset) {
        const currentName = npcName.trim() || t("npc.namePlaceholder");
        setNpcIdentity(localizeNpcPromptDocument(applyPresetName(preset.identity, currentName), locale, "identity"));
        setNpcSoul(localizeNpcPromptDocument(applyPresetName(preset.soul, currentName), locale, "soul"));
      }
    }
  };

  useEffect(() => {
    if (personaPresetId === "custom") return;
    handlePersonaPresetChange(personaPresetId);
  }, [handlePersonaPresetChange, locale, personaPresetId]);

  const handleTestConnection = async () => {
    setTestingConnection(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/channels/test-gateway", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: gatewayUrl.trim(),
          token: gatewayToken,
        }),
      });
      const data = await res.json();
      setTestResult(data.ok ? data : { ...data, error: getLocalizedErrorMessage(t, data) });
      if (data.ok && data.agents?.length > 0) {
        setAgentAction("select");
        setSelectedAgentId(data.agents[0].id);
      }
    } catch {
      setTestResult({ ok: false, error: t("errors.failedToReachTestEndpoint") });
    } finally {
      setTestingConnection(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(t("channels.create.nameRequired"));
      return;
    }
    if (!isPublic && password.length < CHANNEL_PASSWORD_MIN_LENGTH) {
      setError(t("errors.channelPasswordLengthInvalid"));
      return;
    }
    if (!groupId) {
      setError(t("channels.create.noAvailableGroups"));
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      const selectedAppearance = NPC_PRESETS.find((p) => p.id === npcAppearancePreset)?.appearance;
      const effectiveAgentId = agentAction === "select" ? selectedAgentId : newAgentId;

      const payload: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim() || null,
        groupId,
        isPublic,
        mapTemplateId,
        password: isPublic ? undefined : password,
      };

      if (hasGatewayUrl) {
        payload.gatewayConfig = {
          url: gatewayUrl.trim(),
          token: gatewayToken.trim() || null,
        };
      }

      if (hasGatewayUrl && npcName.trim()) {
        payload.defaultNpc = {
          name: npcName.trim(),
          agentId: effectiveAgentId,
          agentAction: agentAction === "select" ? "select" : (newAgentId ? "create" : undefined),
          presetId: personaPresetId !== "custom" ? personaPresetId : undefined,
          identity: npcIdentity,
          soul: npcSoul,
          meetingProtocol: getDefaultMeetingProtocol(locale),
          locale,
          appearance: selectedAppearance,
        };
      }

      const res = await fetch("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(getLocalizedErrorMessage(t, data, "channels.create.failed"));
        setSubmitting(false);
        return;
      }

      router.push(
        `/game?channelId=${data.channel.id}&characterId=${characterId}`,
      );
    } catch {
      setError(t("channels.create.failed"));
      setSubmitting(false);
    }
  };

  return (
    <div className="theme-web min-h-screen bg-bg text-text p-8">
      <div className="max-w-lg mx-auto">
        <h1 className="text-3xl font-bold mb-6">{t("channels.create.title")}</h1>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Name */}
          <div>
            <label className="block text-sm font-semibold mb-1">
              {t("channels.create.name")} *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              className="w-full px-3 py-2 bg-surface border border-border rounded text-text placeholder-text-dim focus:outline-none focus:ring-2 focus:ring-primary-light focus:border-transparent"
              placeholder={t("channels.create.namePlaceholder")}
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-semibold mb-1">
              {t("channels.create.description")}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={3}
              className="w-full px-3 py-2 bg-surface border border-border rounded text-text placeholder-text-dim focus:outline-none focus:ring-2 focus:ring-primary-light focus:border-transparent resize-none"
              placeholder={t("channels.create.descriptionPlaceholder")}
            />
          </div>

          {/* Group */}
          <div>
            <label className="block text-sm font-semibold mb-1">
              {t("channels.create.group")} *
            </label>
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              disabled={loadingGroups || !hasAvailableGroups}
              className="w-full px-3 py-2 bg-surface border border-border rounded text-text focus:outline-none focus:ring-2 focus:ring-primary-light focus:border-transparent disabled:opacity-60"
            >
              {hasAvailableGroups
                ? creatableGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))
                : (
                  <option value="">
                    {loadingGroups ? t("common.loading") : t("channels.create.noAvailableGroups")}
                  </option>
                )}
            </select>
            {!loadingGroups && !hasAvailableGroups && (
              <p className="mt-2 text-sm text-text-muted">
                {t("channels.create.noAvailableGroups")}
              </p>
            )}
          </div>

          {/* Public/Private */}
          <div className="flex items-center gap-3">
            <label className="text-sm font-semibold">{t("channels.create.visibility")}</label>
            <button
              type="button"
              onClick={() => setIsPublic(true)}
              className={`px-3 py-1 rounded text-sm ${
                isPublic
                  ? "bg-primary text-white"
                  : "bg-surface-raised text-text-muted"
              }`}
            >
              {t("channels.public")}
            </button>
            <button
              type="button"
              onClick={() => setIsPublic(false)}
              className={`px-3 py-1 rounded text-sm ${
                !isPublic
                  ? "bg-primary text-white"
                  : "bg-surface-raised text-text-muted"
              }`}
            >
              {t("channels.private")}
            </button>
          </div>

          {/* Password (private only) */}
          {!isPublic && (
            <div>
              <label className="block text-sm font-semibold mb-1">
                {t("channels.create.password")} *
              </label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  maxLength={100}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-text placeholder-text-dim focus:outline-none focus:ring-2 focus:ring-primary-light focus:border-transparent pr-16"
                  placeholder={t("channels.create.passwordPlaceholder")}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text text-xs px-2 py-1"
                >
                  {showPassword ? t("common.hide") : t("common.show")}
                </button>
              </div>
              {password.length > 0 && password.length < CHANNEL_PASSWORD_MIN_LENGTH && (
                <p className="text-danger text-xs mt-1">{t("channels.create.passwordMinError")}</p>
              )}
            </div>
          )}

          {/* Map Template */}
          <div>
            <label className="block text-sm font-semibold mb-2">
              {t("channels.create.mapTemplate")} *
            </label>
            <MapTemplateGrid
              selectedId={mapTemplateId}
              onSelect={setMapTemplateId}
              showActions
              mapEditorQuery={`?from=create&characterId=${characterId}`}
            />
          </div>

          {/* ============================================================= */}
          {/* AI Gateway (Optional) */}
          {/* ============================================================= */}
          <div className="border border-border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setGatewayOpen(!gatewayOpen)}
              className="w-full flex items-center justify-between px-4 py-3 bg-surface hover:bg-surface-raised text-sm font-semibold"
            >
              <span>{t("gateway.title")}</span>
              <ChevronRight className={`w-4 h-4 text-text-muted transition-transform duration-200 ${gatewayOpen ? "rotate-90" : ""}`} />
            </button>

            {gatewayOpen && (
              <div className="p-4 space-y-4 bg-surface/50">
                {/* Gateway URL */}
                <div>
                  <label className="block text-xs font-semibold mb-1 text-text-secondary">{t("gateway.url")}</label>
                  <input
                    type="text"
                    value={gatewayUrl}
                    onChange={(e) => setGatewayUrl(e.target.value)}
                    className="w-full px-3 py-2 bg-surface border border-border rounded text-text placeholder-text-dim focus:outline-none focus:ring-2 focus:ring-primary-light focus:border-transparent text-sm"
                    placeholder={t("gateway.urlPlaceholder")}
                  />
                </div>

                {/* Gateway Token */}
                <div>
                  <label className="block text-xs font-semibold mb-1 text-text-secondary">{t("gateway.token")}</label>
                  <div className="relative">
                    <input
                      type={showGatewayToken ? "text" : "password"}
                      value={gatewayToken}
                      onChange={(e) => setGatewayToken(e.target.value)}
                      className="w-full px-3 py-2 bg-surface border border-border rounded text-text placeholder-text-dim focus:outline-none focus:ring-2 focus:ring-primary-light focus:border-transparent text-sm pr-16"
                      placeholder={t("gateway.tokenPlaceholder")}
                    />
                    <button
                      type="button"
                      onClick={() => setShowGatewayToken(!showGatewayToken)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text text-xs px-2 py-1"
                    >
                      {showGatewayToken ? t("common.hide") : t("common.show")}
                    </button>
                  </div>
                </div>

                {/* Test Connection */}
                <div>
                  <button
                    type="button"
                    onClick={handleTestConnection}
                    disabled={testingConnection || !gatewayUrl.trim()}
                    className="px-4 py-2 bg-primary hover:bg-primary-hover rounded text-sm font-semibold disabled:opacity-50"
                  >
                    {testingConnection ? t("gateway.testing") : t("gateway.testConnection")}
                  </button>
                  {testResult && (
                    <div className={`mt-2 text-xs ${testResult.ok ? "text-green-400" : "text-danger"}`}>
                      {testResult.ok
                        ? t("gateway.connected", { count: testResult.agents?.length ?? 0 })
                        : t("gateway.failed", { error: testResult.error ?? "" })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ============================================================= */}
          {/* Default NPC (visible only when gateway URL is filled) */}
          {/* ============================================================= */}
          {hasGatewayUrl && (
            <div className="border border-border rounded-lg p-4 space-y-4 bg-surface/50">
              <h3 className="text-sm font-semibold text-text-secondary">{t("npc.default")}</h3>

              {/* NPC Name */}
              <div>
                <label className="block text-xs font-semibold mb-1 text-text-secondary">{t("npc.name")}</label>
                <input
                  type="text"
                  value={npcName}
                  onChange={(e) => setNpcName(e.target.value)}
                  onBlur={handleNpcNameBlur}
                  maxLength={100}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-text placeholder-text-dim focus:outline-none focus:ring-2 focus:ring-primary-light focus:border-transparent text-sm"
                  placeholder={t("npc.namePlaceholder")}
                />
              </div>

              {/* Agent Selection */}
              <div>
                <label className="block text-xs font-semibold mb-1 text-text-secondary">{t("npc.agent")}</label>
                {hasTestAgents ? (
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setAgentAction("select")}
                        className={`px-3 py-1 rounded text-xs ${
                          agentAction === "select"
                            ? "bg-primary text-white"
                            : "bg-surface-raised text-text-muted"
                        }`}
                      >
                        {t("npc.selectExisting")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setAgentAction("create")}
                        className={`px-3 py-1 rounded text-xs ${
                          agentAction === "create"
                            ? "bg-primary text-white"
                            : "bg-surface-raised text-text-muted"
                        }`}
                      >
                        {t("npc.newAgent")}
                      </button>
                    </div>
                    {agentAction === "select" ? (
                      <select
                        value={selectedAgentId}
                        onChange={(e) => setSelectedAgentId(e.target.value)}
                        className="w-full px-3 py-2 bg-surface border border-border rounded text-text text-sm focus:outline-none focus:ring-2 focus:ring-primary-light focus:border-transparent"
                      >
                        {testResult!.agents!.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name || a.id}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={newAgentId}
                        onChange={(e) => setNewAgentId(e.target.value)}
                        className="w-full px-3 py-2 bg-surface border border-border rounded text-text placeholder-text-dim focus:outline-none focus:ring-2 focus:ring-primary-light focus:border-transparent text-sm"
                        placeholder={t("npc.agentIdPlaceholder")}
                      />
                    )}
                  </div>
                ) : (
                  <input
                    type="text"
                    value={newAgentId}
                    onChange={(e) => setNewAgentId(e.target.value)}
                    className="w-full px-3 py-2 bg-surface border border-border rounded text-text placeholder-text-dim focus:outline-none focus:ring-2 focus:ring-primary-light focus:border-transparent text-sm"
                    placeholder={t("npc.agentIdPlaceholder")}
                  />
                )}
              </div>

              {/* Persona Preset */}
              <div>
                <label className="block text-xs font-semibold mb-1 text-text-secondary">{t("npc.personaPreset")}</label>
                <select
                  value={personaPresetId}
                  onChange={(e) => handlePersonaPresetChange(e.target.value)}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-text text-sm focus:outline-none focus:ring-2 focus:ring-primary-light focus:border-transparent"
                >
                  <option value="custom">{t("npc.personaCustom")}</option>
                  {PERSONA_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} - {p.nameKo}
                    </option>
                  ))}
                </select>
              </div>

              {/* Identity */}
              <div>
                <label className="block text-xs font-semibold mb-1 text-text-secondary">{t("npc.identity")}</label>
                <textarea
                  value={npcIdentity}
                  onChange={(e) => setNpcIdentity(e.target.value)}
                  rows={4}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-text placeholder-text-dim focus:outline-none focus:ring-2 focus:ring-primary-light focus:border-transparent resize-none text-sm"
                  placeholder={t("npc.identityPlaceholder")}
                />
              </div>

              {/* Advanced: Soul */}
              <div>
                <button
                  type="button"
                  onClick={() => setNpcAdvancedOpen(!npcAdvancedOpen)}
                  className="text-xs text-text-muted hover:text-text flex items-center gap-1"
                >
                  <ChevronRight className={`w-3.5 h-3.5 transition-transform duration-200 ${npcAdvancedOpen ? "rotate-90" : ""}`} />
                  <span>{t("npc.advanced")}</span>
                </button>
                {npcAdvancedOpen && (
                  <div className="mt-2">
                    <label className="block text-xs font-semibold mb-1 text-text-secondary">{t("npc.soul")}</label>
                    <textarea
                      value={npcSoul}
                      onChange={(e) => setNpcSoul(e.target.value)}
                      rows={6}
                      className="w-full px-3 py-2 bg-surface border border-border rounded text-text placeholder-text-dim focus:outline-none focus:ring-2 focus:ring-primary-light focus:border-transparent resize-none text-sm"
                      placeholder={t("npc.soulPlaceholder")}
                    />
                  </div>
                )}
              </div>

              {/* Appearance Preset */}
              <div>
                <label className="block text-xs font-semibold mb-2 text-text-secondary">{t("npc.appearance")}</label>
                <div className="grid grid-cols-5 gap-2">
                  {NPC_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setNpcAppearancePreset(p.id)}
                      className={`p-2 rounded-lg border text-center transition text-xs ${
                        npcAppearancePreset === p.id
                          ? "border-primary-light bg-primary-muted"
                          : "border-border bg-surface hover:border-border"
                      }`}
                    >
                      <div className="font-semibold">{p.name}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {error && <p className="text-danger text-sm">{error}</p>}

          {/* Submit */}
          <div className="flex items-center gap-4 pt-2">
            <button
              type="submit"
              disabled={submitting || loadingGroups || !hasAvailableGroups}
              className="px-6 py-2 bg-primary hover:bg-primary-hover rounded font-semibold disabled:opacity-50"
            >
              {submitting ? t("channels.create.creating") : t("common.create")}
            </button>
            <Link
              href={`/channels?characterId=${characterId}`}
              className="text-text-muted hover:text-text text-sm"
            >
              {t("common.cancel")}
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
