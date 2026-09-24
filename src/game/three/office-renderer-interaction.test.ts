import assert from "node:assert/strict";
import { test } from "node:test";
import * as T from "three";
import { OfficeRenderer } from "./office-renderer";
import { FurnitureHighlight } from "./furniture-highlight";
import { BoardArrival } from "./office-kanban";

type SeatTarget = { owner: T.Object3D; action: { x: number; z: number } };
function fixture() {
  const scene = new T.Scene();
  const furnitureHighlight = new FurnitureHighlight(scene);
  const boardArrival = new BoardArrival();
  const renderer = Object.assign(Object.create(OfficeRenderer.prototype), {
    scene,
    furnitureHighlight,
    boardArrival,
    hoveredSeat: null,
    selectedSeat: null,
    meetingCamera: { active: false },
  }) as {
    hoveredSeat: SeatTarget | null;
    selectedSeat: SeatTarget | null;
    setHoveredSeat(target: SeatTarget | null): void;
    setSelectedSeat(target: SeatTarget | null): void;
    cancelBoardIntent(): void;
    setMeetingEntryState(status: string): void;
    enterMeeting(): boolean;
    point(event: PointerEvent, kind: "down"): void;
    meetingCamera: { active: boolean };
  };
  const seat = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshBasicMaterial());
  const board = new T.Mesh(new T.BoxGeometry(2, 2, 0.1), new T.MeshBasicMaterial());
  scene.add(seat, board);
  return { renderer, scene, seat, board, furnitureHighlight, boardArrival };
}

test("the selected seat stays as a single green overlay even after the hover leaves", () => {
  const { renderer, seat, scene, furnitureHighlight } = fixture();
  const target = { owner: seat, action: { x: 1, z: 1 } };
  renderer.setSelectedSeat(target);
  renderer.setHoveredSeat(target);
  renderer.setHoveredSeat(null);
  assert.equal(furnitureHighlight.group.visible, true);
  assert.equal(furnitureHighlight.group.children.length, 1);
  assert.equal(scene.children.filter((child) => child instanceof T.Group).length, 1);
  renderer.setSelectedSeat(null);
  assert.equal(furnitureHighlight.group.visible, false);
});

test("returning to the same seat after a board hover restores the seat overlay", () => {
  const { renderer, seat, board, furnitureHighlight } = fixture();
  const target = { owner: seat, action: { x: 1, z: 1 } };
  renderer.setSelectedSeat(target);
  furnitureHighlight.highlight(board);
  renderer.setHoveredSeat(target);
  const overlay = furnitureHighlight.group.children[0] as T.Mesh;
  assert.equal(overlay.geometry, seat.geometry);
});

test("starting a meeting move or entering directly cancels the board arrival intent", () => {
  const { renderer, boardArrival } = fixture();
  boardArrival.start(1, 1, 0);
  renderer.cancelBoardIntent();
  assert.equal(boardArrival.update({ x: 1, y: 1, walking: false }, 10), false);
  boardArrival.start(1, 1, 0);
  assert.equal(renderer.enterMeeting(), false);
  assert.equal(boardArrival.update({ x: 1, y: 1, walking: false }, 10), false);
});

test("a board click during a meeting starts neither a ray test nor a move", () => {
  const { renderer, boardArrival } = fixture();
  renderer.meetingCamera.active = true;
  renderer.point({ button: 0 } as PointerEvent, "down");
  assert.equal(boardArrival.update({ x: 1, y: 1, walking: false }, 10), false);
});

test("new board clicks are blocked while moving into a meeting, and released after cancel", () => {
  const { renderer } = fixture();
  renderer.setMeetingEntryState("walking");
  Object.assign(renderer, {
    bridge: {
      editor() {
        throw new Error("board input reached");
      },
    },
  });
  renderer.point({ button: 0 } as PointerEvent, "down");
  renderer.setMeetingEntryState("cancelled");
  assert.throws(() => renderer.point({ button: 0 } as PointerEvent, "down"), /board input reached/);
});
