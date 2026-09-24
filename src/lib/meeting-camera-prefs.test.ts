import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MEETING_CAMERA_PREFS,
  MEETING_CAMERA_PREFS_KEY,
  loadMeetingCameraPrefs,
  normalizeMeetingCameraPrefs,
  saveMeetingCameraPrefs,
} from "./meeting-camera-prefs";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

test("the default is exactly Dante's decision — upper body, direct handoff, 2.0s dwell, 1.5s hold", () => {
  assert.deepEqual(DEFAULT_MEETING_CAMERA_PREFS, {
    speakerFraming: "upperBody",
    directHandoff: true,
    minSpeakerDwellSeconds: 2,
    holdAfterSpeechSeconds: 1.5,
  });
});

test("doesn't trust a stored value — only the invalid fields fall back to defaults, the rest survives", () => {
  const prefs = normalizeMeetingCameraPrefs({
    speakerFraming: "portrait",
    directHandoff: "yes",
    minSpeakerDwellSeconds: 99,
    holdAfterSpeechSeconds: 0.73,
  });
  assert.equal(prefs.speakerFraming, "upperBody");
  assert.equal(prefs.directHandoff, true);
  assert.equal(prefs.minSpeakerDwellSeconds, 5, "범위 위로 넘치면 잘라 낸다");
  assert.equal(prefs.holdAfterSpeechSeconds, 0.7, "0.1초 단위로 맞춘다");
  assert.deepEqual(normalizeMeetingCameraPrefs("garbage"), DEFAULT_MEETING_CAMERA_PREFS);
  assert.deepEqual(normalizeMeetingCameraPrefs(null), DEFAULT_MEETING_CAMERA_PREFS);
});

test("adding a '얼굴 가까이' (close-up) step still reads a value saved by an older version as-is", () => {
  const stored = {
    speakerFraming: "fullBody",
    directHandoff: false,
    minSpeakerDwellSeconds: 2,
    holdAfterSpeechSeconds: 1,
  };
  const store = memory({ [MEETING_CAMERA_PREFS_KEY]: JSON.stringify(stored) });
  assert.deepEqual(loadMeetingCameraPrefs(store), stored);
  assert.equal(normalizeMeetingCameraPrefs({ speakerFraming: "face" }).speakerFraming, "face");
});

test("reading it back after saving gives the same value", () => {
  const store = memory();
  saveMeetingCameraPrefs({ ...DEFAULT_MEETING_CAMERA_PREFS, speakerFraming: "table" }, store);
  assert.equal(loadMeetingCameraPrefs(store).speakerFraming, "table");
});

test("falls back to defaults without throwing even on broken JSON or a blocked store", () => {
  assert.deepEqual(
    loadMeetingCameraPrefs(memory({ [MEETING_CAMERA_PREFS_KEY]: "{not json" })),
    DEFAULT_MEETING_CAMERA_PREFS,
  );
  const blocked = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  assert.deepEqual(loadMeetingCameraPrefs(blocked), DEFAULT_MEETING_CAMERA_PREFS);
  assert.doesNotThrow(() => saveMeetingCameraPrefs(DEFAULT_MEETING_CAMERA_PREFS, blocked));
  assert.deepEqual(loadMeetingCameraPrefs(null), DEFAULT_MEETING_CAMERA_PREFS);
});
