/** The meeting room coordinate contract: bounds and entrance in tiles, participant positions and seat IDs in server pixels. */
export const MEETING_SPACE_VERSION = 1;
export type MeetingBounds = { x: number; y: number; width: number; height: number };
export type MeetingPosition = { x: number; y: number; direction: "up" | "down" | "left" | "right" };
export type MeetingSpace = {
  id: string;
  version: number;
  bounds: MeetingBounds;
  entry: { x: number; y: number };
  seatIds: string[];
  standingPositions: MeetingPosition[];
  wallObjectIds: string[];
  wallTileKeys: string[];
  /** A render-only marker that draws only the outline of the generated extension while keeping collision objects. */
  generatedAnnexWalls?: Array<{
    id: string;
    col: number;
    row: number;
    type: "room_wall_h";
    display: "horizontal" | "vertical" | "corner" | "hidden";
  }>;
};
export function insideMeetingSpace(bounds: MeetingBounds, x: number, y: number) {
  return (
    x >= bounds.x && y >= bounds.y && x < bounds.x + bounds.width && y < bounds.y + bounds.height
  );
}
