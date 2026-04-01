import { OFFICE_PRESETS } from "./office-presets";
import { getNpcPresetDefaults } from "./npc-agent-defaults";

export interface NpcPreset {
  id: string;
  name: string;
  displayName: string;
  defaultAgentId: string;
  identity: string;
  soul: string;
  appearance: {
    bodyType: string;
    layers: Record<string, { itemKey: string; variant: string }>;
  };
}

/** Convert office presets to NPC appearance presets */
export function getNpcPresets(locale?: string): NpcPreset[] {
  return OFFICE_PRESETS.map((preset) => {
    const defaults = getNpcPresetDefaults({
      presetId: preset.id,
      npcName: preset.nameKo,
      locale,
    });

    return {
      id: preset.id,
      name: preset.nameKo,
      displayName: preset.nameKo,
      defaultAgentId: defaults.defaultAgentId,
      identity: defaults.identity,
      soul: defaults.soul,
      appearance: defaults.appearance,
    };
  });
}

export const NPC_PRESETS: NpcPreset[] = getNpcPresets();
