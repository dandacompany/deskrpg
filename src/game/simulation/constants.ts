/** The server pixel coordinate system: one tile is 32px. The same value as the renderer's `PIXELS_PER_TILE`. */
export const TILE_SIZE = 32;
export const MAP_COLS = 40;
export const MAP_ROWS = 30;
export const PLAYER_SPEED = 120;
export const MOVE_SEND_INTERVAL = 66;
export const LERP_FACTOR = 0.2;
export const NPC_INTERACT_RADIUS = 64;

/** Old tileset indices whose meaning the simulation still reads. */
export const TILE_EMPTY = 0;
export const TILE_FLOOR = 1;
export const TILE_WALL = 2;
/** Unwalkable wall layer tiles (legacy maps). Object collision is handled by the occupied tile set. */
export const COLLISION_TILES = new Set([TILE_WALL]);
