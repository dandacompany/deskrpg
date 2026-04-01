"use client";

import { useState, useEffect, useRef, useCallback, startTransition } from "react";
import type { CharacterAppearance } from "@/lib/lpc-registry";
import type { NpcPreset } from "@/lib/npc-presets";
import { PERSONA_PRESETS, applyPresetName } from "@/lib/npc-persona-presets";
import { useLocale, useT } from "@/lib/i18n";
import { Trash2, Maximize2 } from "lucide-react";
import { useCharacterAppearance } from "@/hooks/useCharacterAppearance";
import CharacterPreview from "@/components/CharacterPreview";
import AppearanceEditor from "@/components/AppearanceEditor";
import OpenClawPairingStatusCard, { type OpenClawPairingStatus } from "@/components/openclaw/OpenClawPairingStatusCard";
import { getAgentProgressMeter, type AgentProgressPhase } from "@/lib/npc-agent-progress";
import { getLocalizedErrorMessage } from "@/lib/i18n/error-codes";
import { localizeNpcPromptDocument } from "@/lib/npc-agent-defaults";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREVIEW_SCALE = 3;
const DIRECTION_LABELS: { id: string; label: string }[] = [
  { id: "down", label: "↓" },
  { id: "left", label: "←" },
  { id: "right", label: "→" },
  { id: "up", label: "↑" },
];
const MAX_NPC_COUNT = 10;

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

interface GatewayAgent {
  id: string;
  name: string;
  workspace: string;
  inUse: boolean;
  usedByNpcName: string | null;
}

interface GatewayConnectionState {
  status: OpenClawPairingStatus;
  requestId?: string | null;
  error?: string | null;
}

function isGatewayPairingRequired(payload: unknown): payload is {
  errorCode?: string;
  requestId?: string;
  error?: string;
} {
  if (!payload || typeof payload !== "object") return false;
  const errorCode = (payload as { errorCode?: unknown }).errorCode;
  return errorCode === "gateway_pairing_required" || errorCode === "PAIRING_REQUIRED";
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface NpcHireModalProps {
  channelId: string;
  isOpen: boolean;
  onClose: () => void;
  onPlaceOnMap: (npcData: {
    presetId?: string;
    name: string;
    persona: string;
    appearance: unknown;
    direction: string;
    agentId?: string;
    agentAction?: "select" | "create";
    identity?: string;
    soul?: string;
    locale?: string;
  }) => void;
  onSaveEdit?: (
    npcId: string,
    updates: { presetId?: string; name?: string; persona?: string; appearance?: unknown; direction?: string; identity?: string; soul?: string; agentId?: string; agentAction?: "select" | "create"; locale?: string },
  ) => void;
  editingNpc?: {
    id: string;
    name: string;
    persona: string;
    appearance: unknown;
    direction?: string;
    agentId?: string | null;
  } | null;
  currentNpcCount: number;
  hasGateway: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function NpcHireModal({
  channelId,
  isOpen,
  onClose,
  onPlaceOnMap,
  onSaveEdit,
  editingNpc,
  currentNpcCount,
  hasGateway,
}: NpcHireModalProps) {
  const t = useT();
  const { locale } = useLocale();

  // --- Appearance (shared hook) ---
  const {
    bodyType, setBodyType, layers, setLayers,
    activeCategory, setActiveCategory,
    handleBodyTypeChange, selectItem, clearCategory, setVariant, setSkin,
    isItemCompatible, getItemBodyTypes, compatibleCount,
    randomize, buildAppearance: buildAppearanceFromHook,
  } = useCharacterAppearance();

  // --- NPC-specific state ---
  const [name, setName] = useState("");
  const [identity, setIdentity] = useState("");
  const [soul, setSoul] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [appearanceMode, setAppearanceMode] = useState<"presets" | "custom">("presets");

  // Step flow state
  const [step, setStep] = useState<"configure" | "creating-agent" | "place">("configure");
  const [agentProgress, setAgentProgress] = useState<{
    phase: AgentProgressPhase;
    status: string;
    error?: string;
  }>({ phase: "idle", status: "" });

  // Agent selection state
  const [gatewayAgents, setGatewayAgents] = useState<GatewayAgent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [gatewayConnectionState, setGatewayConnectionState] = useState<GatewayConnectionState>({ status: "idle" });
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [createNewAgent, setCreateNewAgent] = useState(false);
  const [newAgentId, setNewAgentId] = useState("");
  const [newAgentIdError, setNewAgentIdError] = useState<string | null>(null);

  // Persona preset state
  const [personaPresetId, setPersonaPresetId] = useState<string>("custom");

  // Direction
  const [direction, setDirection] = useState("down");

  // Presets
  const [presets, setPresets] = useState<NpcPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [identityCustomized, setIdentityCustomized] = useState(false);
  const [soulCustomized, setSoulCustomized] = useState(false);

  // --- Derived ---
  const isEdit = !!editingNpc;
  const atLimit = currentNpcCount >= MAX_NPC_COUNT;
  const isExistingAgentSelected = hasGateway && selectedAgentId && !createNewAgent;
  const personaCompat = identity.trim();
  const canSubmit =
    hasGateway &&
    name.trim().length > 0 &&
    (personaCompat.length > 0 || isExistingAgentSelected);

  // --- Build appearance (with preset support) ---
  const buildAppearance = useCallback((): CharacterAppearance => {
    if (appearanceMode === "presets" && selectedPresetId) {
      const preset = presets.find((p) => p.id === selectedPresetId);
      if (preset) return preset.appearance as CharacterAppearance;
    }
    return buildAppearanceFromHook();
  }, [appearanceMode, selectedPresetId, presets, buildAppearanceFromHook]);

  // --- Validate new agent ID ---
  const validateNewAgentId = useCallback((value: string) => {
    if (!value) { setNewAgentIdError(null); return; }
    if (!/^[a-zA-Z0-9-]+$/.test(value)) setNewAgentIdError(t("npc.agentIdValidationChars"));
    else if (value.length < 3) setNewAgentIdError(t("npc.agentIdValidationMin"));
    else if (value.length > 30) setNewAgentIdError(t("npc.agentIdValidationMax"));
    else if (gatewayAgents.some((a) => a.id === value)) setNewAgentIdError(t("npc.agentIdExists"));
    else setNewAgentIdError(null);
  }, [gatewayAgents, t]);

  const findPreset = useCallback((presetId: string | null) => {
    if (!presetId) return null;
    return presets.find((preset) => preset.id === presetId) || null;
  }, [presets]);

  const applyPresetSelection = useCallback((presetId: string) => {
    const preset = findPreset(presetId);
    if (!preset) return;

    const resolvedName = name.trim() || preset.displayName || preset.name || t("npc.defaultName");

    setSelectedPresetId(preset.id);
    setAppearanceMode("presets");
    setPersonaPresetId(preset.id);

    if (!name.trim()) {
      setName(preset.displayName || preset.name);
    }

    setIdentity(localizeNpcPromptDocument(applyPresetName(preset.identity, resolvedName), locale, "identity"));
    setSoul(localizeNpcPromptDocument(applyPresetName(preset.soul, resolvedName), locale, "soul"));
    setIdentityCustomized(false);
    setSoulCustomized(false);

    if (hasGateway && (!isEdit || createNewAgent || !selectedAgentId)) {
      if (!isEdit) {
        setCreateNewAgent(true);
        setSelectedAgentId(null);
      }
      setNewAgentId(preset.defaultAgentId);
      validateNewAgentId(preset.defaultAgentId);
    }
  }, [createNewAgent, findPreset, hasGateway, isEdit, locale, name, selectedAgentId, t, validateNewAgentId]);

  // --- Initialise / reset on open or editingNpc change ---
  useEffect(() => {
    if (!isOpen) return;
    startTransition(() => {
      setStep("configure");
      setAgentProgress({ phase: "idle", status: "" });
      if (editingNpc) {
        setName(editingNpc.name);
        setIdentity(editingNpc.persona || "");
        setSoul("");
        setShowAdvanced(false);
        setDirection(editingNpc.direction || "down");
        const app = editingNpc.appearance as CharacterAppearance | null;
        if (app && app.bodyType && app.layers) {
          setBodyType(app.bodyType);
          setLayers(app.layers);
          setAppearanceMode("custom");
          setSelectedPresetId(null);
        }
        setPersonaPresetId("custom");
        setIdentityCustomized(true);
        setSoulCustomized(true);
        if (editingNpc.agentId) {
          setSelectedAgentId(editingNpc.agentId);
          setCreateNewAgent(false);
        } else {
          setSelectedAgentId(null);
          setCreateNewAgent(hasGateway);
        }
      } else {
        setName("");
        setIdentity("");
        setSoul("");
        setShowAdvanced(false);
        setBodyType("male");
        setLayers({ body: { itemKey: "body", variant: "light" }, eye_color: { itemKey: "eye_color", variant: "brown" } });
        setActiveCategory("body");
        setDirection("down");
        setAppearanceMode("presets");
        setSelectedPresetId(null);
        setPersonaPresetId("custom");
        setIdentityCustomized(false);
        setSoulCustomized(false);
        setSelectedAgentId(null);
        setCreateNewAgent(hasGateway);
        setNewAgentId("");
        setNewAgentIdError(null);
      }
      setGatewayConnectionState({ status: "idle" });
      setGatewayAgents([]);
    });
  }, [isOpen, editingNpc, hasGateway, setBodyType, setLayers, setActiveCategory]);

  const loadGatewayAgents = useCallback(async () => {
    if (!hasGateway) return;
    setAgentsLoading(true);
    setGatewayConnectionState({ status: "idle" });
    try {
      const res = await fetch(`/api/channels/${channelId}/gateway/agents`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setGatewayAgents(Array.isArray(data.agents) ? data.agents : []);
        setGatewayConnectionState({ status: "connected" });
        return;
      }

      setGatewayAgents([]);
      if (isGatewayPairingRequired(data)) {
        setGatewayConnectionState({
          status: "pairing_required",
          requestId: typeof data.requestId === "string" ? data.requestId : null,
        });
      } else {
        setGatewayConnectionState({
          status: "error",
          error: getLocalizedErrorMessage(t, data, "errors.failedToListAgents"),
        });
      }
    } catch {
      setGatewayAgents([]);
      setGatewayConnectionState({
        status: "error",
        error: t("errors.failedToListAgents"),
      });
    } finally {
      setAgentsLoading(false);
    }
  }, [channelId, hasGateway, t]);

  // --- Fetch gateway agents ---
  useEffect(() => {
    if (!isOpen || !hasGateway) return;
    void loadGatewayAgents();
  }, [isOpen, hasGateway, loadGatewayAgents]);

  // --- Fetch presets ---
  useEffect(() => {
    if (!isOpen) return;
    startTransition(() => {
      setPresetsLoading(true);
    });
    fetch(`/api/npcs/presets?locale=${locale}`)
      .then((r) => r.json())
      .then((data) => {
        const nextPresets = data.presets ?? [];
        setPresets(nextPresets);

        if (personaPresetId === "custom" || identityCustomized || soulCustomized) {
          return;
        }

        const nextPreset = nextPresets.find((preset: NpcPreset) => preset.id === personaPresetId);
        if (!nextPreset) return;

        const resolvedName = name.trim() || nextPreset.displayName || nextPreset.name || t("npc.defaultName");
        setIdentity(localizeNpcPromptDocument(applyPresetName(nextPreset.identity, resolvedName), locale, "identity"));
        setSoul(localizeNpcPromptDocument(applyPresetName(nextPreset.soul, resolvedName), locale, "soul"));
      })
      .catch(() => {})
      .finally(() => setPresetsLoading(false));
  }, [identityCustomized, isOpen, locale, name, personaPresetId, soulCustomized, t]);

  // --- Apply persona preset ---
  const handlePersonaPresetChange = useCallback((presetId: string) => {
    setPersonaPresetId(presetId);
    if (presetId === "custom") {
      setIdentity("");
      setSoul("");
      setIdentityCustomized(false);
      setSoulCustomized(false);
      return;
    }
    if (findPreset(presetId)) {
      applyPresetSelection(presetId);
      return;
    }
    const preset = PERSONA_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const currentName = name.trim() || t("npc.defaultName");
    setIdentity(localizeNpcPromptDocument(applyPresetName(preset.identity, currentName), locale, "identity"));
    setSoul(localizeNpcPromptDocument(applyPresetName(preset.soul, currentName), locale, "soul"));
    setIdentityCustomized(false);
    setSoulCustomized(false);
  }, [applyPresetSelection, findPreset, locale, name, t]);

  const handleNameChange = (newName: string) => {
    setName(newName);
    if (personaPresetId !== "custom") {
      const preset = PERSONA_PRESETS.find((p) => p.id === personaPresetId);
      if (preset) {
        const n = newName.trim() || t("npc.defaultName");
        if (!identityCustomized) {
          setIdentity(localizeNpcPromptDocument(applyPresetName(preset.identity, n), locale, "identity"));
        }
        if (!soulCustomized) {
          setSoul(localizeNpcPromptDocument(applyPresetName(preset.soul, n), locale, "soul"));
        }
      }
    }
  };

  // --- Create agent on gateway ---
  const handleCreateAgent = async () => {
    if (!hasGateway || !createNewAgent || !newAgentId.trim()) {
      handleSubmit();
      return;
    }
    setStep("creating-agent");
    setAgentProgress({ phase: "connecting", status: t("npc.agentCreateConnecting") });
    try {
      const res = await fetch("/api/npcs/create-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId,
          agentId: newAgentId.trim(),
          presetId: selectedPresetId,
          npcName: name.trim(),
          identity: identity.trim(),
          soul: soul.trim(),
          locale,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        if (isGatewayPairingRequired(data)) {
          setGatewayConnectionState({
            status: "pairing_required",
            requestId: typeof data.requestId === "string" ? data.requestId : null,
          });
          setStep("configure");
          setAgentProgress({ phase: "idle", status: "" });
          return;
        }
        setAgentProgress({
          phase: "failed",
          status: t("npc.agentCreateFailed"),
          error: getLocalizedErrorMessage(t, data, "npc.agentCreateFailed"),
        });
        return;
      }
      setAgentProgress({ phase: "done", status: t("npc.agentCreateDone") });
      setTimeout(() => setStep("place"), 500);
    } catch {
      setAgentProgress({
        phase: "failed",
        status: t("npc.agentCreateFailed"),
        error: t("npc.agentCreateNetworkError"),
      });
    }
  };

  // --- Submit ---
  const handleSubmit = () => {
    if (!canSubmit) return;
      const appearance = buildAppearance();
      const activePresetId = appearanceMode === "presets" ? selectedPresetId ?? undefined : undefined;

    if (isEdit && onSaveEdit) {
      let agentId: string | undefined;
      let agentAction: "select" | "create" | undefined;
      if (hasGateway) {
        if (createNewAgent && newAgentId.trim()) { agentId = newAgentId.trim(); agentAction = "create"; }
        else if (selectedAgentId) { agentId = selectedAgentId; agentAction = selectedAgentId !== editingNpc!.agentId ? "select" : undefined; }
      }
      onSaveEdit(editingNpc!.id, { presetId: activePresetId, name: name.trim(), persona: personaCompat, appearance, direction, identity: identity.trim(), soul: soul.trim(), agentId, agentAction, locale });
    } else {
      let agentId: string | undefined;
      let agentAction: "select" | "create" | undefined;
      if (hasGateway) {
        if (createNewAgent && newAgentId.trim()) { agentId = newAgentId.trim(); agentAction = "create"; }
        else if (selectedAgentId) { agentId = selectedAgentId; agentAction = "select"; }
      }
      onPlaceOnMap({ presetId: activePresetId, name: name.trim(), persona: personaCompat, appearance, direction, agentId, agentAction, identity: identity.trim(), soul: soul.trim(), locale });
    }
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  if (!isOpen) return null;

  const agentProgressMeter = getAgentProgressMeter(agentProgress.phase);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={handleBackdropClick}>
      <div className="relative max-w-4xl w-full mx-4 max-h-[90vh] bg-gray-900 rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold text-white">
            {isEdit ? t("npc.edit") : t("npc.hire")}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none" aria-label={t("common.close")}>&times;</button>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left section — inputs + appearance selector */}
          <div className="flex-1 p-6 overflow-y-auto flex flex-col gap-5">
            {/* Name */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">{t("npc.name")}</label>
              <input
                type="text" maxLength={50} value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder={t("npc.namePlaceholder")}
                className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            {/* AI Agent Section */}
            <AgentSection
              hasGateway={hasGateway}
              isEdit={isEdit}
              gatewayAgents={gatewayAgents} setGatewayAgents={setGatewayAgents}
              agentsLoading={agentsLoading}
              gatewayConnectionState={gatewayConnectionState}
              onRetryConnection={loadGatewayAgents}
              selectedAgentId={selectedAgentId} setSelectedAgentId={setSelectedAgentId}
              createNewAgent={createNewAgent} setCreateNewAgent={setCreateNewAgent}
              newAgentId={newAgentId} setNewAgentId={setNewAgentId}
              newAgentIdError={newAgentIdError}
              validateNewAgentId={validateNewAgentId}
              channelId={channelId}
              t={t}
            />

            {/* Persona Section */}
            <PersonaSection
              isExistingAgentSelected={!!isExistingAgentSelected}
              personaPresetId={personaPresetId}
              onPersonaPresetChange={handlePersonaPresetChange}
              identity={identity} setIdentity={setIdentity}
              soul={soul} setSoul={setSoul}
              setIdentityCustomized={setIdentityCustomized}
              setSoulCustomized={setSoulCustomized}
              showAdvanced={showAdvanced} setShowAdvanced={setShowAdvanced}
              t={t}
            />

            {/* Appearance */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">{t("npc.appearance")}</label>
              <div className="flex gap-1 mb-3">
                <button
                  onClick={() => setAppearanceMode("presets")}
                  className={`px-4 py-1.5 rounded text-sm font-medium ${
                    appearanceMode === "presets" ? "bg-indigo-600 text-white" : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                  }`}
                >{t("npc.presets")}</button>
                <button
                  onClick={() => setAppearanceMode("custom")}
                  className={`px-4 py-1.5 rounded text-sm font-medium ${
                    appearanceMode === "custom" ? "bg-indigo-600 text-white" : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                  }`}
                >{t("npc.personaCustom")}</button>
              </div>

              {appearanceMode === "presets" && (
                <div>
                  {presetsLoading ? (
                    <p className="text-sm text-gray-500">{t("npc.loadingPresets")}</p>
                  ) : presets.length === 0 ? (
                    <p className="text-sm text-gray-500">{t("npc.noPresets")}</p>
                  ) : (
                    <div className="grid grid-cols-3 gap-2">
                      {presets.map((preset) => (
                        <PresetCard
                          key={preset.id}
                          preset={preset}
                          isSelected={selectedPresetId === preset.id}
                          onSelect={() => applyPresetSelection(preset.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {appearanceMode === "custom" && (
                <AppearanceEditor
                  bodyType={bodyType}
                  layers={layers}
                  activeCategory={activeCategory}
                  onBodyTypeChange={(bt) => handleBodyTypeChange(bt)}
                  onSkinChange={setSkin}
                  onSelectItem={selectItem}
                  onClearCategory={clearCategory}
                  onSetVariant={setVariant}
                  onSetActiveCategory={setActiveCategory}
                  isItemCompatible={isItemCompatible}
                  getItemBodyTypes={getItemBodyTypes}
                  compatibleCount={compatibleCount}
                  variant="compact"
                  presetsSlot={
                    <button
                      onClick={randomize}
                      className="w-full px-2 py-1 bg-indigo-900/60 hover:bg-indigo-800 rounded text-xs text-indigo-300 text-center font-semibold mb-1"
                    >{t("characters.random")}</button>
                  }
                />
              )}
            </div>
          </div>

          {/* Right section — preview canvas */}
          <div className="w-56 flex flex-col items-center justify-center gap-4 p-6 border-l border-gray-700">
            <CharacterPreview
              appearance={buildAppearance()}
              scale={PREVIEW_SCALE}
              direction={direction}
              active={isOpen}
            />
            <p className="text-xs text-gray-500 mb-2">{t("common.preview")}</p>
            <div className="flex gap-1">
              {DIRECTION_LABELS.map((d) => (
                <button
                  key={d.id} type="button"
                  onClick={() => setDirection(d.id)}
                  className={`w-8 h-8 rounded text-sm font-bold ${
                    direction === d.id ? "bg-indigo-600 text-white" : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                  }`}
                >{d.label}</button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-700 flex items-center justify-between">
          <div>
            {!isEdit && atLimit && (
              <p className="text-xs text-amber-400">
                {t("npc.limitReached", { count: MAX_NPC_COUNT, max: MAX_NPC_COUNT })}
              </p>
            )}
          </div>
          <div className="flex gap-3 items-center">
            <button onClick={onClose} className="px-4 py-2 rounded text-sm bg-gray-700 text-gray-300 hover:bg-gray-600">
              {t("common.cancel")}
            </button>

            {step === "configure" && (
              <button
                onClick={() => {
                  if (isEdit) handleSubmit();
                  else if (hasGateway && createNewAgent && newAgentId.trim()) handleCreateAgent();
                  else handleSubmit();
                }}
                disabled={!canSubmit || (!isEdit && atLimit)}
                className="px-5 py-2 rounded text-sm font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isEdit ? t("common.save") : (hasGateway && createNewAgent && newAgentId.trim()) ? t("common.next") : t("npc.placeOnMap")}
              </button>
            )}

            {step === "creating-agent" && (
              <div className="flex-1 flex flex-col gap-2 min-w-[200px]">
                <div className="w-full bg-gray-700 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full transition-all duration-500 ${agentProgressMeter.className}`}
                    style={{ width: agentProgressMeter.width }}
                  />
                </div>
                <p className={`text-xs ${agentProgress.error ? "text-red-400" : "text-gray-400"}`}>
                  {agentProgress.error || agentProgress.status}
                </p>
                {agentProgress.error && (
                  <button
                    onClick={() => { setStep("configure"); setAgentProgress({ phase: "idle", status: "" }); }}
                    className="px-3 py-1 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 self-start"
                  >{t("common.back")}</button>
                )}
              </div>
            )}

            {step === "place" && (
              <button
                onClick={handleSubmit}
                disabled={!canSubmit || (!isEdit && atLimit)}
                className="px-5 py-2 rounded text-sm font-semibold bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >{t("npc.placeOnMap")}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent Section sub-component
// ---------------------------------------------------------------------------

function AgentSection({
  hasGateway,
  isEdit,
  gatewayAgents, setGatewayAgents,
  agentsLoading,
  gatewayConnectionState,
  onRetryConnection,
  selectedAgentId, setSelectedAgentId,
  createNewAgent, setCreateNewAgent,
  newAgentId, setNewAgentId,
  newAgentIdError,
  validateNewAgentId,
  channelId,
  t,
}: {
  hasGateway: boolean;
  isEdit: boolean;
  gatewayAgents: GatewayAgent[];
  setGatewayAgents: React.Dispatch<React.SetStateAction<GatewayAgent[]>>;
  agentsLoading: boolean;
  gatewayConnectionState: GatewayConnectionState;
  onRetryConnection: () => void | Promise<void>;
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;
  createNewAgent: boolean;
  setCreateNewAgent: (v: boolean) => void;
  newAgentId: string;
  setNewAgentId: (v: string) => void;
  newAgentIdError: string | null;
  validateNewAgentId: (v: string) => void;
  channelId: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-300 mb-2">{t("npc.aiAgent")}</label>
      {!hasGateway ? (
        <div className="rounded border border-dashed border-gray-700 bg-gray-800/60 px-3 py-3 text-sm text-gray-400">
          {t("npc.gatewaySetupHint")}
        </div>
      ) : (
        <div className="space-y-3">
          {gatewayConnectionState.status !== "idle" && (
            <OpenClawPairingStatusCard
              status={gatewayConnectionState.status}
              requestId={gatewayConnectionState.requestId}
              error={gatewayConnectionState.error}
              detail={gatewayConnectionState.status === "connected" ? t("settings.connected") : undefined}
            />
          )}
          {(gatewayConnectionState.status === "pairing_required" || gatewayConnectionState.status === "error") && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void onRetryConnection()}
                className="px-3 py-1.5 rounded bg-gray-700 text-white text-xs font-semibold hover:bg-gray-600"
              >
                {t("gateway.testConnection")}
              </button>
            </div>
          )}
          {agentsLoading ? (
            <p className="text-sm text-gray-500">{t("npc.loadingAgents")}</p>
          ) : gatewayConnectionState.status === "pairing_required" || gatewayConnectionState.status === "error" ? null : (
            <>
              <div className="flex gap-2">
                <select
                  value={createNewAgent ? "__create__" : (selectedAgentId || "")}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "__create__") { setCreateNewAgent(true); setSelectedAgentId(null); }
                    else { setCreateNewAgent(false); setSelectedAgentId(val || null); setNewAgentId(""); }
                  }}
                  className="flex-1 px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="__create__">{t("npc.createNewAgent")}</option>
                  <option value="">{t("npc.selectAgent")}</option>
                  {gatewayAgents.map((agent) => (
                    <option key={agent.id} value={agent.id} disabled={agent.inUse}>
                      {agent.inUse
                        ? t("npc.agentInUse", { name: agent.name || agent.id, npcName: agent.usedByNpcName || agent.id })
                        : t("npc.agentAvailable", { name: agent.name || agent.id })}
                    </option>
                  ))}
                </select>
                {isEdit && selectedAgentId && !createNewAgent && (() => {
                  const agent = gatewayAgents.find(a => a.id === selectedAgentId);
                  return agent && agent.id !== "main" && !agent.inUse ? (
                    <button
                      type="button"
                      onClick={async () => {
                        if (agent.id === "main") return;
                        if (!confirm(`${t("npc.deleteAgent")}: ${agent.name || agent.id}?`)) return;
                        try {
                          const res = await fetch(`/api/channels/${channelId}/gateway/agents?agentId=${agent.id}`, { method: "DELETE" });
                          if (res.ok) { setGatewayAgents(prev => prev.filter(a => a.id !== agent.id)); setSelectedAgentId(null); }
                          else {
                            const data = await res.json().catch(() => ({}));
                            alert(getLocalizedErrorMessage(t, data, "npc.deleteFailed"));
                          }
                        } catch { alert(t("npc.deleteFailed")); }
                      }}
                      className="px-2 py-2 rounded bg-red-800 hover:bg-red-700 text-white text-sm shrink-0"
                      title={t("npc.deleteAgent")}
                    ><Trash2 className="w-4 h-4" /></button>
                  ) : null;
                })()}
              </div>

              {createNewAgent && (
                <div>
                  <input
                    type="text" maxLength={30} value={newAgentId}
                    onChange={(e) => { setNewAgentId(e.target.value); validateNewAgentId(e.target.value); }}
                    placeholder={t("npc.agentIdPlaceholder")}
                    className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  {newAgentIdError && <p className="text-xs text-red-400 mt-1">{newAgentIdError}</p>}
                  <p className="text-xs text-gray-500 mt-1">{t("npc.agentIdHint")}</p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Persona Section sub-component
// ---------------------------------------------------------------------------

function PersonaSection({
  isExistingAgentSelected,
  personaPresetId, onPersonaPresetChange,
  identity, setIdentity,
  soul, setSoul,
  setIdentityCustomized,
  setSoulCustomized,
  showAdvanced, setShowAdvanced,
  t,
}: {
  isExistingAgentSelected: boolean;
  personaPresetId: string;
  onPersonaPresetChange: (id: string) => void;
  identity: string;
  setIdentity: (v: string) => void;
  soul: string;
  setSoul: (v: string) => void;
  setIdentityCustomized: (v: boolean) => void;
  setSoulCustomized: (v: boolean) => void;
  showAdvanced: boolean;
  setShowAdvanced: (v: boolean) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const [identityHeight, setIdentityHeight] = useState(128);
  const [showFullEditor, setShowFullEditor] = useState(false);
  const dragStartY = useRef<number>(0);
  const dragStartHeight = useRef<number>(0);

  const handleDragMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragStartY.current = e.clientY;
    dragStartHeight.current = identityHeight;
    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientY - dragStartY.current;
      setIdentityHeight(Math.max(80, dragStartHeight.current + delta));
    };
    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-300 mb-1">{t("npc.persona")}</label>

      {!isExistingAgentSelected && (
        <div className="mb-2">
          <select
            value={personaPresetId}
            onChange={(e) => onPersonaPresetChange(e.target.value)}
            className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="custom">{t("npc.personaCustom")}</option>
            {PERSONA_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.name} — {p.role}</option>
            ))}
          </select>
        </div>
      )}

      {isExistingAgentSelected ? (
        <div className="bg-gray-800 border border-gray-700 rounded p-3">
          <p className="text-xs text-gray-400 italic mb-1">{t("npc.personaManagedOnGateway")}</p>
          <p className="text-sm text-gray-500">{t("npc.personaManagedHint")}</p>
        </div>
      ) : (
        <>
          <div className="relative">
            <textarea
              maxLength={2000} value={identity}
              onChange={(e) => { setIdentity(e.target.value); setIdentityCustomized(true); }}
              placeholder={t("npc.identityPlaceholder")}
              style={{ height: identityHeight }}
              className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button
              type="button"
              onClick={() => setShowFullEditor(true)}
              title={t("npc.edit")}
              className="absolute top-1.5 right-1.5 p-1 rounded bg-gray-700/80 hover:bg-gray-600 text-gray-400 hover:text-white transition-colors"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
            <div
              onMouseDown={handleDragMouseDown}
              className="absolute bottom-0 right-0 w-5 h-5 cursor-s-resize flex items-end justify-end pr-0.5 pb-0.5"
              title={t("mapEditor.pixel.resize")}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" className="text-gray-500">
                <line x1="2" y1="9" x2="9" y2="2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="5" y1="9" x2="9" y2="5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-1 text-right">{identity.length}/2000</p>

          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-xs text-indigo-400 hover:text-indigo-300 mt-1 flex items-center gap-1"
          >
            <span className={`transition-transform ${showAdvanced ? "rotate-90" : ""}`}>&#9654;</span>
            {t("npc.advanced")}
          </button>

          {showAdvanced && (
            <div className="mt-2">
              <label className="block text-xs font-medium text-gray-400 mb-1">
                {t("npc.soul")} {t("npc.advancedHint")}
              </label>
              <textarea
                maxLength={3000} rows={6} value={soul}
                onChange={(e) => { setSoul(e.target.value); setSoulCustomized(true); }}
                placeholder={t("npc.soulPlaceholder")}
                className="w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <p className="text-xs text-gray-500 mt-1 text-right">{soul.length}/3000</p>
            </div>
          )}

          {showFullEditor && (
            <div
              className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70"
              onClick={(e) => { if (e.target === e.currentTarget) setShowFullEditor(false); }}
            >
              <div className="bg-gray-900 rounded-xl shadow-2xl w-full max-w-2xl mx-4 flex flex-col" style={{ maxHeight: "80vh" }}>
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
                  <h3 className="text-sm font-semibold text-white">{t("npc.persona")}</h3>
                  <button onClick={() => setShowFullEditor(false)} className="text-gray-400 hover:text-white text-xl leading-none" aria-label={t("common.close")}>&times;</button>
                </div>
                <div className="flex-1 p-4 flex flex-col overflow-hidden min-h-0">
                  <textarea
                    maxLength={2000} value={identity}
                    onChange={(e) => { setIdentity(e.target.value); setIdentityCustomized(true); }}
                    placeholder={t("npc.identityPlaceholder")}
                    className="flex-1 w-full px-3 py-2 rounded bg-gray-800 border border-gray-700 text-white text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    style={{ minHeight: "300px" }}
                    autoFocus
                  />
                  <p className="text-xs text-gray-500 mt-1 text-right">{identity.length}/2000</p>
                </div>
                <div className="px-4 py-3 border-t border-gray-700 flex justify-end">
                  <button
                    onClick={() => setShowFullEditor(false)}
                    className="px-4 py-2 rounded text-sm font-semibold bg-indigo-600 text-white hover:bg-indigo-700"
                  >{t("common.done")}</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preset Card sub-component
// ---------------------------------------------------------------------------

function PresetCard({
  preset, isSelected, onSelect,
}: {
  preset: NpcPreset;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`flex flex-col items-center gap-1 p-2 rounded border-2 transition-colors ${
        isSelected ? "border-indigo-500 bg-gray-800" : "border-transparent bg-gray-800 hover:border-gray-600"
      }`}
    >
      <CharacterPreview
        appearance={preset.appearance as CharacterAppearance}
        scale={2}
        fps={6}
      />
      <span className="text-xs text-gray-300">{preset.name}</span>
    </button>
  );
}
