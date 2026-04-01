"use client";

import type {
  CharacterAppearance,
  LegacyCharacterAppearance,
} from "@/lib/lpc-registry";

import type { MeetingSeatLayout, MeetingTableLayout } from "./layout";
import {
  computeMeetingSceneFrameWidth,
  computeMeetingSceneScale,
} from "./responsive";
import MeetingAvatar from "./MeetingAvatar";
import MeetingSpeechBubble from "./MeetingSpeechBubble";

export interface MeetingSceneSeat extends MeetingSeatLayout {
  name: string;
  appearance: CharacterAppearance | LegacyCharacterAppearance | null;
  isChair: boolean;
  isNpc: boolean;
  isSpeaking: boolean;
  speechPreview: string | null;
  isClickable: boolean;
  onClick?: () => void;
}

export function buildMeetingSceneModel(layout: MeetingTableLayout) {
  return {
    tableWidth: layout.table.width,
    seats: layout.seats,
  };
}

interface MeetingTableSceneProps {
  layout: MeetingTableLayout;
  seats: MeetingSceneSeat[];
  availableWidth: number;
}

function getSeatTranslate(side: MeetingSceneSeat["side"]) {
  if (side === "top") return "translate(-50%, -16%)";
  if (side === "bottom") return "translate(-50%, -84%)";
  if (side === "left") return "translate(-20%, -50%)";
  return "translate(-80%, -50%)";
}

function getNameplateClassName(seat: MeetingSceneSeat) {
  if (seat.isChair) return "bg-primary/15 text-primary-light border-primary/30";
  if (seat.isNpc) return "bg-npc/10 text-npc border-npc/25";
  return "bg-surface-raised/90 text-text-secondary border-border";
}

export default function MeetingTableScene({
  layout,
  seats,
  availableWidth,
}: MeetingTableSceneProps) {
  const scene = buildMeetingSceneModel(layout);
  const sceneFrameWidth = computeMeetingSceneFrameWidth(scene.tableWidth);
  const sceneScale = computeMeetingSceneScale(availableWidth, sceneFrameWidth);

  return (
    <div className="relative w-full h-full min-h-[420px] overflow-hidden rounded-[28px] border border-border/70 bg-[radial-gradient(circle_at_top,#1d2842_0%,#111827_58%,#0b1120_100%)]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(148,163,184,0.12),transparent_65%)]" />

      <div
        className="absolute left-1/2 top-1/2 h-[86%] transition-transform duration-150 ease-out"
        style={{
          width: `${sceneFrameWidth}px`,
          transform: `translate(-50%, -50%) scale(${sceneScale})`,
          transformOrigin: "center center",
        }}
      >
        <div className="absolute inset-x-10 top-1/2 h-[68%] -translate-y-1/2 rounded-[40px] bg-[linear-gradient(180deg,rgba(30,41,59,0.28),rgba(15,23,42,0.58))] blur-2xl" />

        <svg
          viewBox={`0 0 ${scene.tableWidth} 420`}
          className="absolute left-1/2 top-1/2 h-[68%] w-auto max-w-[92%] -translate-x-1/2 -translate-y-1/2 drop-shadow-[0_16px_36px_rgba(15,23,42,0.38)]"
          role="presentation"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="meeting-table-surface" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#566b8f" />
              <stop offset="52%" stopColor="#3f5374" />
              <stop offset="100%" stopColor="#2a3547" />
            </linearGradient>
            <linearGradient id="meeting-table-edge" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#94a3b8" stopOpacity="0.5" />
              <stop offset="100%" stopColor="#cbd5e1" stopOpacity="0.16" />
            </linearGradient>
          </defs>

          <rect
            x="28"
            y="116"
            width={scene.tableWidth - 56}
            height="188"
            rx="52"
            fill="url(#meeting-table-surface)"
            stroke="url(#meeting-table-edge)"
            strokeWidth="5"
          />
          <rect
            x="62"
            y="146"
            width={scene.tableWidth - 124}
            height="128"
            rx="34"
            fill="rgba(148,163,184,0.08)"
            stroke="rgba(226,232,240,0.16)"
            strokeWidth="2"
          />
          <g opacity="0.85">
            <rect x="94" y="184" width={scene.tableWidth - 188} height="6" rx="3" fill="rgba(255,255,255,0.08)" />
            <rect x="94" y="228" width={scene.tableWidth - 188} height="6" rx="3" fill="rgba(15,23,42,0.18)" />
          </g>
        </svg>

        <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/8 bg-white/5 px-4 py-1 text-[10px] font-semibold uppercase tracking-[0.35em] text-slate-300/60">
          Meeting Table
        </div>

        {seats.map((seat) => (
          <div
            key={seat.participantId}
            className="absolute z-20"
            style={{
              left: `${seat.x}%`,
              top: `${seat.y}%`,
              transform: getSeatTranslate(seat.side),
            }}
          >
            <div className="relative flex flex-col items-center gap-2">
              <div
                className={`relative rounded-full p-1.5 transition ${
                  seat.isSpeaking
                    ? "bg-npc/20 shadow-[0_0_0_6px_rgba(52,211,153,0.12)]"
                    : seat.isChair
                      ? "bg-primary/15"
                      : "bg-transparent"
                } ${seat.isClickable ? "cursor-pointer hover:scale-[1.02]" : ""}`}
                onClick={seat.onClick}
              >
                <MeetingAvatar
                  appearance={seat.appearance}
                  facing={seat.facing}
                  size={seat.side === "left" || seat.side === "right" ? 72 : 80}
                  className={seat.isSpeaking ? "ring-2 ring-npc" : seat.isChair ? "ring-2 ring-primary" : ""}
                />
                {seat.isChair && (
                  <div className="absolute -right-1 -top-1 rounded-full border border-primary/40 bg-primary px-1.5 py-0.5 text-[9px] font-black tracking-wide text-white">
                    C
                  </div>
                )}
                <MeetingSpeechBubble
                  preview={seat.speechPreview}
                  visible={seat.isSpeaking}
                />
              </div>

              <div className={`max-w-[124px] rounded-full border px-3 py-1 text-center text-[11px] font-semibold shadow-sm backdrop-blur ${getNameplateClassName(seat)}`}>
                <span className="block truncate">{seat.name}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
