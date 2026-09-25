import type { RoomState } from "./room-state";

/** A chat room fills the conversation pane — a 1:1 dialog, when open, is shown instead. */
export function isRoomViewActive(input: { dialogOpen: boolean; view: RoomState["view"] }): boolean {
  return !input.dialogOpen && input.view === "room";
}

/**
 * Whether an employee arriving beside the viewer should open their 1:1 dialog.
 *
 * - Map chat walkers answer in map chat, so the dialog would cover that answer.
 * - While a room is on screen, an arrival (a room @mention, a report) must not take the pane
 *   away from it — the navigator already shows the employee waiting beside the viewer, and a
 *   waiting report opens once the viewer leaves the room.
 * - An employee the viewer explicitly called over came to talk, so that dialog still opens.
 */
export function autoOpenDialogOnArrival(input: {
  hasName: boolean;
  fromMapChat: boolean;
  calledToTalk: boolean;
  roomViewActive: boolean;
}): boolean {
  if (!input.hasName || input.fromMapChat) return false;
  return input.calledToTalk || !input.roomViewActive;
}
