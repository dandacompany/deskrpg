export const MEETING_SIDEBAR_MIN_WIDTH = 320;
export const MEETING_SIDEBAR_MAX_WIDTH = 560;
export const MEETING_SCENE_MIN_WIDTH = 660;
export const MEETING_SCENE_MIN_SCALE = 0.58;

export function clampMeetingSidebarWidth(requestedWidth: number, viewportWidth: number): number {
  const boundedViewport = Math.max(viewportWidth, MEETING_SIDEBAR_MIN_WIDTH + MEETING_SCENE_MIN_WIDTH);
  const dynamicMaxWidth = Math.max(
    MEETING_SIDEBAR_MIN_WIDTH,
    boundedViewport - MEETING_SCENE_MIN_WIDTH,
  );
  const maxWidth = Math.min(MEETING_SIDEBAR_MAX_WIDTH, dynamicMaxWidth);

  return Math.min(Math.max(requestedWidth, MEETING_SIDEBAR_MIN_WIDTH), maxWidth);
}

export function computeMeetingSceneFrameWidth(tableWidth: number): number {
  return Math.max(980, tableWidth + 260);
}

export function computeMeetingSceneScale(availableWidth: number, frameWidth: number): number {
  if (availableWidth <= 0 || frameWidth <= 0) return 1;
  if (availableWidth >= frameWidth) return 1;

  const scale = availableWidth / frameWidth;
  return Math.max(MEETING_SCENE_MIN_SCALE, Math.round(scale * 100) / 100);
}
