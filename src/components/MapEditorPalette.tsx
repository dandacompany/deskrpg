"use client";

import { EventBus } from "@/game/EventBus";
import { OBJECT_TYPE_LIST } from "@/lib/object-types";
import { FLOOR_PALETTE, WALL_PALETTE } from "@/lib/map-editor-utils";

type EditorTool = "paint" | "erase" | "fill" | "spawn";
type EditorLayer = "floor" | "walls" | "objects";

interface MapEditorPaletteProps {
  currentLayer: EditorLayer;
  currentTool: EditorTool;
  selectedTileId: number;
  selectedObjectType: string;
  currentDirection: "down" | "left" | "right" | "up";
  onLayerChange: (layer: EditorLayer) => void;
  onToolChange: (tool: EditorTool) => void;
  onTileSelect: (tileId: number) => void;
  onObjectSelect: (objectType: string) => void;
  onDirectionChange: (dir: "down" | "left" | "right" | "up") => void;
}

export default function MapEditorPalette({
  currentLayer, currentTool, selectedTileId, selectedObjectType, currentDirection,
  onLayerChange, onToolChange, onTileSelect, onObjectSelect, onDirectionChange,
}: MapEditorPaletteProps) {
  const handleLayerChange = (layer: EditorLayer) => {
    onLayerChange(layer);
    EventBus.emit("editor:set-layer", { layer });
  };
  const handleToolChange = (tool: EditorTool) => {
    onToolChange(tool);
    EventBus.emit("editor:set-tool", { tool });
  };
  const handleTileSelect = (tileId: number) => {
    onTileSelect(tileId);
    EventBus.emit("editor:set-tile", { tileId });
  };
  const handleObjectSelect = (objectType: string) => {
    onObjectSelect(objectType);
    EventBus.emit("editor:set-tile", { objectType });
  };
  const handleDirectionChange = (dir: "down" | "left" | "right" | "up") => {
    onDirectionChange(dir);
    EventBus.emit("editor:set-direction", { direction: dir });
  };

  const palette = currentLayer === "floor" ? FLOOR_PALETTE : WALL_PALETTE;
  const layers: { id: EditorLayer; label: string }[] = [
    { id: "floor", label: "Floor" }, { id: "walls", label: "Walls" }, { id: "objects", label: "Objects" },
  ];
  const tools: { id: EditorTool; label: string; icon: string }[] = [
    { id: "paint", label: "Paint", icon: "\u270F\uFE0F" }, { id: "erase", label: "Erase", icon: "\uD83E\uDDF9" },
    { id: "fill", label: "Fill", icon: "\u25AA\uFE0F" }, { id: "spawn", label: "Spawn", icon: "\uD83D\uDCCD" },
  ];

  return (
    <div className="w-56 bg-surface border-r border-border flex flex-col p-3 gap-4 overflow-y-auto">
      {/* Layer Tabs */}
      <div>
        <div className="text-xs font-semibold text-text-muted mb-2 uppercase">Layer</div>
        <div className="flex gap-1">
          {layers.map((l) => (
            <button key={l.id} onClick={() => handleLayerChange(l.id)}
              className={`flex-1 px-2 py-1.5 rounded text-xs font-semibold transition ${
                currentLayer === l.id ? "bg-primary text-white" : "bg-surface-raised text-text-muted hover:text-text"
              }`}>{l.label}</button>
          ))}
        </div>
      </div>
      {/* Tile/Object Palette */}
      <div>
        <div className="text-xs font-semibold text-text-muted mb-2 uppercase">
          {currentLayer === "objects" ? "Objects" : "Tiles"}
        </div>
        <div className="grid grid-cols-2 gap-1">
          {currentLayer === "objects"
            ? OBJECT_TYPE_LIST.map((obj) => (
                <button key={obj.id} onClick={() => handleObjectSelect(obj.id)}
                  className={`px-2 py-2 rounded text-xs text-left transition ${
                    selectedObjectType === obj.id
                      ? "bg-primary-muted border border-primary-light text-primary-light"
                      : "bg-surface-raised border border-border text-text-muted hover:text-text"
                  }`}>{obj.name}</button>
              ))
            : palette.map((tile) => (
                <button key={tile.id} onClick={() => handleTileSelect(tile.id)}
                  className={`flex items-center gap-2 px-2 py-2 rounded text-xs transition ${
                    selectedTileId === tile.id
                      ? "bg-primary-muted border border-primary-light text-primary-light"
                      : "bg-surface-raised border border-border text-text-muted hover:text-text"
                  }`}>
                  <span className="w-4 h-4 rounded border border-border inline-block flex-shrink-0" style={{ backgroundColor: tile.color }} />
                  {tile.name}
                </button>
              ))}
        </div>
      </div>
      {/* Direction (Objects mode only) */}
      {currentLayer === "objects" && (
        <div>
          <div className="text-xs font-semibold text-text-muted mb-2 uppercase">Direction</div>
          <div className="flex gap-1">
            {(["down", "right", "up", "left"] as const).map((dir) => {
              const arrows: Record<string, string> = { down: "\u2193", right: "\u2192", up: "\u2191", left: "\u2190" };
              return (
                <button key={dir} onClick={() => handleDirectionChange(dir)}
                  className={`flex-1 px-2 py-1.5 rounded text-xs font-semibold transition ${
                    currentDirection === dir
                      ? "bg-primary text-white"
                      : "bg-surface-raised text-text-muted hover:text-text"
                  }`}>{arrows[dir]}</button>
              );
            })}
          </div>
          <p className="text-[10px] text-text-dim mt-1">R: rotate / Shift+R: reverse</p>
        </div>
      )}
      {/* Tools */}
      <div>
        <div className="text-xs font-semibold text-text-muted mb-2 uppercase">Tools</div>
        <div className="grid grid-cols-2 gap-1">
          {tools.map((t) => (
            <button key={t.id} onClick={() => handleToolChange(t.id)}
              className={`flex items-center gap-1.5 px-2 py-2 rounded text-xs transition ${
                currentTool === t.id
                  ? "bg-primary-muted border border-primary-light text-primary-light"
                  : "bg-surface-raised border border-border text-text-muted hover:text-text"
              }`}>
              <span>{t.icon}</span>{t.label}
            </button>
          ))}
        </div>
      </div>
      {/* Tips */}
      <div className="mt-auto text-[10px] text-text-dim space-y-1">
        <p>LMB: paint / RMB: erase</p>
        <p>MMB drag: pan camera</p>
        <p>Scroll: zoom</p>
      </div>
    </div>
  );
}
