export type AvatarFacing = "front" | "back" | "left" | "right";

export interface AvatarFrameRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

const FRAME_SIZE = 64;

const FACING_ROW: Record<AvatarFacing, number> = {
  back: 0,
  left: 1,
  front: 2,
  right: 3,
};

export function getAvatarFrameRect(facing: AvatarFacing): AvatarFrameRect {
  return {
    sx: 0,
    sy: FACING_ROW[facing] * FRAME_SIZE,
    sw: FRAME_SIZE,
    sh: FRAME_SIZE,
  };
}
