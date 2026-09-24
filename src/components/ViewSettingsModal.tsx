"use client";

import { useState } from "react";

import { EventBus } from "@/game/EventBus";
import { useT } from "@/lib/i18n";
import {
  DEFAULT_MEETING_CAMERA_PREFS,
  MEETING_DWELL_RANGE,
  MEETING_SPEAKER_FRAMINGS,
  loadMeetingCameraPrefs,
  saveMeetingCameraPrefs,
  type MeetingCameraPrefs,
} from "@/lib/meeting-camera-prefs";

/**
 * View settings — apply **only to this browser**. Unlike channel settings (owner-only, saved
 * to the DB), anyone can open this and there's no save button: it saves immediately on change
 * and applies to the camera right away. To avoid confusing what "save" means when both kinds
 * live in the same settings menu, this screen has no save button at all.
 */
export default function ViewSettingsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [prefs, setPrefs] = useState<MeetingCameraPrefs>(() => loadMeetingCameraPrefs());

  const change = (patch: Partial<MeetingCameraPrefs>) => {
    const next = saveMeetingCameraPrefs({ ...prefs, ...patch });
    setPrefs(next);
    EventBus.emit("view:meeting-camera-prefs", next);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        role="dialog"
        aria-labelledby="view-settings-title"
        className="bg-surface rounded-xl w-full max-w-md border border-border max-h-[80vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 id="view-settings-title" className="text-lg font-bold text-text">
            {t("viewSettings.title")}
          </h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text text-xl"
            aria-label={t("common.close")}
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <p className="text-caption text-text-muted">{t("viewSettings.localOnly")}</p>

          <section className="space-y-4" aria-labelledby="view-settings-meeting">
            <h3 id="view-settings-meeting" className="text-sm font-semibold text-text">
              {t("viewSettings.meetingCamera")}
            </h3>

            <label className="block">
              <span className="block text-sm text-text-secondary mb-1">
                {t("viewSettings.speakerFraming")}
              </span>
              <select
                data-view-setting="speakerFraming"
                value={prefs.speakerFraming}
                onChange={(e) =>
                  change({ speakerFraming: e.target.value as MeetingCameraPrefs["speakerFraming"] })
                }
                className="w-full px-3 py-2 bg-surface-raised border border-border rounded-md text-text text-sm"
              >
                {MEETING_SPEAKER_FRAMINGS.map((framing) => (
                  <option key={framing} value={framing}>
                    {t(`viewSettings.framing.${framing}`)}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                data-view-setting="directHandoff"
                checked={prefs.directHandoff}
                onChange={(e) => change({ directHandoff: e.target.checked })}
                className="mt-1"
              />
              <span>
                <span className="block text-sm text-text">{t("viewSettings.directHandoff")}</span>
                <span className="block text-caption text-text-muted">
                  {t("viewSettings.directHandoffHint")}
                </span>
              </span>
            </label>

            <SecondsField
              name="minSpeakerDwellSeconds"
              label={t("viewSettings.minDwell")}
              hint={t("viewSettings.minDwellHint")}
              value={prefs.minSpeakerDwellSeconds}
              onChange={(minSpeakerDwellSeconds) => change({ minSpeakerDwellSeconds })}
            />
            <SecondsField
              name="holdAfterSpeechSeconds"
              label={t("viewSettings.holdAfter")}
              hint={t("viewSettings.holdAfterHint")}
              value={prefs.holdAfterSpeechSeconds}
              onChange={(holdAfterSpeechSeconds) => change({ holdAfterSpeechSeconds })}
            />

            <button
              type="button"
              data-view-setting="reset"
              onClick={() => change(DEFAULT_MEETING_CAMERA_PREFS)}
              className="text-sm text-info hover:underline"
            >
              {t("viewSettings.reset")}
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}

function SecondsField({
  name,
  label,
  hint,
  value,
  onChange,
}: {
  name: string;
  label: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const t = useT();
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-sm text-text-secondary mb-1">
        <span>{label}</span>
        <span className="text-text tabular-nums">{t("viewSettings.seconds", { value })}</span>
      </span>
      <input
        type="range"
        data-view-setting={name}
        min={MEETING_DWELL_RANGE.min}
        max={MEETING_DWELL_RANGE.max}
        step={MEETING_DWELL_RANGE.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
      <span className="block text-caption text-text-muted">{hint}</span>
    </label>
  );
}
