export type SeatSide = "top" | "bottom" | "left" | "right";
export type SeatFacing = "front" | "back" | "left" | "right";

export interface MeetingSeatLayout {
  participantId: string;
  side: SeatSide;
  facing: SeatFacing;
  x: number;
  y: number;
}

export interface MeetingTableLayout {
  seats: MeetingSeatLayout[];
  table: {
    minWidth: number;
    width: number;
  };
}

export function getSeatFacing(side: SeatSide): SeatFacing {
  if (side === "top") return "front";
  if (side === "bottom") return "back";
  if (side === "left") return "right";
  return "left";
}

function buildSeatSides(total: number): SeatSide[] {
  if (total <= 0) return [];

  if (total <= 6) {
    return Array.from({ length: total }, (_, index) =>
      index % 2 === 0 ? "top" : "bottom",
    );
  }

  const sides: SeatSide[] = ["top", "bottom", "top", "bottom", "top", "left", "right"];
  const overflowCycle: SeatSide[] = ["bottom", "top"];

  while (sides.length < total) {
    sides.push(overflowCycle[(sides.length - 7) % overflowCycle.length]);
  }

  return sides;
}

function getSeatPosition(side: SeatSide, sideIndex: number, sideCount: number) {
  const progress = sideCount <= 1 ? 0.5 : (sideIndex + 1) / (sideCount + 1);

  if (side === "top") {
    return { x: 50 + (progress - 0.5) * 32, y: 16 };
  }

  if (side === "bottom") {
    return { x: 50 + (progress - 0.5) * 32, y: 84 };
  }

  if (side === "left") {
    return { x: 14, y: 28 + progress * 44 };
  }

  return { x: 86, y: 28 + progress * 44 };
}

export function computeMeetingTableLayout(args: {
  participantIds: string[];
}): MeetingTableLayout {
  const sides = buildSeatSides(args.participantIds.length);
  const sideTotals = sides.reduce<Record<SeatSide, number>>(
    (totals, side) => {
      totals[side] += 1;
      return totals;
    },
    { top: 0, bottom: 0, left: 0, right: 0 },
  );
  const sideIndexes: Record<SeatSide, number> = {
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  };

  const seats = args.participantIds.map((participantId, index) => {
    const side = sides[index] ?? "top";
    const sideIndex = sideIndexes[side];
    sideIndexes[side] += 1;
    const position = getSeatPosition(side, sideIndex, sideTotals[side]);

    return {
      participantId,
      side,
      facing: getSeatFacing(side),
      x: position.x,
      y: position.y,
    };
  });

  const minWidth = 520;
  const width = Math.max(minWidth, minWidth + Math.max(0, args.participantIds.length - 4) * 70);

  return {
    seats,
    table: {
      minWidth,
      width,
    },
  };
}
