type CenteredCameraBoundsInput = {
  viewportWidth: number;
  viewportHeight: number;
  zoom: number;
  mapWidth: number;
  mapHeight: number;
};

type CameraBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function getCenteredCameraBounds({
  viewportWidth,
  viewportHeight,
  zoom,
  mapWidth,
  mapHeight,
}: CenteredCameraBoundsInput): CameraBounds {
  const visibleWidth = viewportWidth / zoom;
  const visibleHeight = viewportHeight / zoom;
  const padX = Math.max(0, (visibleWidth - mapWidth) / 2);
  const padY = Math.max(0, (visibleHeight - mapHeight) / 2);
  const x = padX === 0 ? 0 : -padX;
  const y = padY === 0 ? 0 : -padY;

  return {
    x,
    y,
    width: mapWidth + padX * 2,
    height: mapHeight + padY * 2,
  };
}
