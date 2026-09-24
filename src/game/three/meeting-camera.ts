import * as T from "three";
import type { MeetingSpace } from "../meeting-space";
import type { ActorSnapshot } from "./bridge";
import {
  DEFAULT_MEETING_CAMERA_PREFS,
  type MeetingSpeakerFraming,
} from "../../lib/meeting-camera-prefs";
export type { MeetingSpeakerFraming };
export type MeetingSpeaker = {
  kind: "user" | "npc";
  id: string;
  utteranceId: string;
  phase?: "speaking" | "thinking" | "working";
};
export type MeetingCameraControls = {
  target: T.Vector3;
  enablePan: boolean;
  enableZoom: boolean;
  enableDamping: boolean;
  minDistance: number;
  maxDistance: number;
  mouseButtons: { LEFT?: T.MOUSE | null; MIDDLE?: T.MOUSE | null; RIGHT?: T.MOUSE | null };
  touches: { ONE?: T.TOUCH | null; TWO?: T.TOUCH | null };
};
export type MeetingCameraOptions = {
  reducedMotion?: boolean;
  roomTransitionSeconds?: number;
  speakerTransitionSeconds?: number;
  speakerFraming?: MeetingSpeakerFraming;
  /** Cut straight from one speaker to the next instead of passing through the table view. */
  directHandoff?: boolean;
  /** A speaker shot is held at least this long, even if the speech ends sooner. */
  minSpeakerDwellSeconds?: number;
  /** After speech ends, wait this long for the next speaker before returning to the table. */
  holdAfterSpeechSeconds?: number;
};
/** Viewer preferences come from `meeting-camera-prefs` (the single source); timings are ours. */
export const MEETING_CAMERA_DEFAULTS = {
  roomTransitionSeconds: 1.0,
  speakerTransitionSeconds: 0.9,
  ...DEFAULT_MEETING_CAMERA_PREFS,
};

// Elevation above the horizon. The table view sits beside the table rather than above the room;
// speaker shots are close to eye level so the face, not the top of the head, is what we see.
const TABLE_ELEVATION = T.MathUtils.degToRad(30);
const SPEAKER_ELEVATION = T.MathUtils.degToRad(15);
const TABLE_HEADING = Math.PI / 5;
// World units are tiles. A seated head renders near y=2.0, a standing one near y=2.7.
const SEATED_HEAD = 2.2;
const STANDING_HEAD = 2.9;
const BODY_PAD = 0.8;
const SEAT_SNAP = 0.6;
const FIT_MARGIN = 0.08;
const MIN_SPEAKER_DISTANCE = 2.2;
/** The upper fraction of the body the upper-body framing contains, and the headroom above the head (cells). */
const UPPER_BODY_SHARE = 0.5;
/** Above the chest: from the head down to this fraction of body height. If a neighbor is caught, the upper body pulls in to here too. */
const BUST_SHARE = 0.3;
const HEADROOM = 0.1;
// A speaker shot may stand just past a wall (faded) but not deep in the next room.
const ROOM_REACH = 1.5;

type Shot = { kind: "table" } | { kind: "speaker"; key: string };

/** Whether the speaker was found, and if not, where it broke off. */
export type MeetingSpeakerState = "none" | "not-speaking" | "no-actor" | "outside-room" | "found";

/**
 * The appearance the renderer **actually drew** — the world bounding box and the angle the body faces (rig.rotation.y, 0 means +z).
 *
 * At first the camera guessed these: direction from `ActorSnapshot.direction`, height as a constant. Actually running it locally,
 * it framed a seated speaker from the side, too close, with the body cut off. A seated person faces the seat direction
 * (`seat?.direction ?? actor.direction`), but the snapshot direction is the last direction while walking into the seat,
 * and the seated head was lower than the constant. The renderer knows both exactly.
 */
export type ActorPresentation = { box: T.Box3; yaw: number };
export type ActorPresenter = (actor: ActorSnapshot) => ActorPresentation | null;
type Point = { x: number; z: number };
type Box = { min: T.Vector3; max: T.Vector3 };

export class MeetingCamera {
  automatic = true;
  private space: MeetingSpace | null = null;
  private speaker: MeetingSpeaker | null = null;
  private seats: Point[] = [];
  private presenter: ActorPresenter | null = null;
  private error: string | null = null;
  private errorReported = false;
  private speakerState: MeetingSpeakerState = "none";
  private shotNow: Shot | null = null;
  /** Shot to take once the table view has settled (non-direct handoff). */
  private queued: string | null = null;
  private clock = 0;
  private shotSince = 0;
  private speechEndedAt: number | null = null;
  private width = 1;
  private height = 1;
  private right = 0;
  private elapsed = 0;
  private duration = 0;
  private fromTarget = new T.Vector3();
  private fromOrbit = new T.Spherical();
  private toTarget = new T.Vector3();
  private toOrbit = new T.Spherical();
  private dirty = false;
  private scratch = new T.PerspectiveCamera();
  private saved: {
    position: T.Vector3;
    target: T.Vector3;
    far: number;
    enablePan: boolean;
    enableZoom: boolean;
    enableDamping: boolean;
    minDistance: number;
    maxDistance: number;
    mouseButtons: MeetingCameraControls["mouseButtons"];
    touches: MeetingCameraControls["touches"];
  } | null = null;
  constructor(
    private camera: T.PerspectiveCamera,
    private controls: MeetingCameraControls,
    private options: MeetingCameraOptions = {},
  ) {}
  get active() {
    return this.space !== null;
  }
  /** What the automatic camera is framing: `table` or `speaker:<kind>:<id>`. */
  /**
   * Diagnostics readable from the screen. On staging a speaker close-up never appeared while locally it appeared every time,
   * and the cause could not be isolated from code — so the next run can tell where it broke off just by looking at the DOM.
   */
  get diagnostics(): { shot: string; speaker: MeetingSpeakerState; error: string | null } {
    return { shot: this.shot, speaker: this.speakerState, error: this.error };
  }
  get shot(): string {
    if (!this.shotNow) return "none";
    return this.shotNow.kind === "table" ? "table" : `speaker:${this.shotNow.key}`;
  }
  configure(options: MeetingCameraOptions) {
    this.options = { ...this.options, ...options };
    this.dirty = true;
  }
  private opt<K extends keyof typeof MEETING_CAMERA_DEFAULTS>(key: K) {
    return (this.options[key] ??
      MEETING_CAMERA_DEFAULTS[key]) as (typeof MEETING_CAMERA_DEFAULTS)[K];
  }
  /** Report the appearance the renderer actually drew. Without it (tests etc.) guess from the snapshot. */
  setPresenter(presenter: ActorPresenter | null) {
    this.presenter = presenter;
    this.dirty = true;
  }
  /** Seat positions inside the meeting room, in tiles. They define "the whole table". */
  setSeats(seats: Point[]) {
    this.seats = seats.map((s) => ({ x: s.x, z: s.z }));
    this.dirty = true;
  }
  setViewport(width: number, height: number, right = 0) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.right = Math.max(0, Math.min(this.width - 1, right));
    if (!this.active) return;
    this.projection();
    // Projection changes immediately on resize; re-fit now instead of waiting for a frame so the
    // table never spends a frame cut off by the meeting panel.
    this.dirty = true;
    this.snapToCurrent();
  }
  private projection() {
    // Render the full canvas, with its optical center inside the unobscured left viewport.
    this.camera.setViewOffset(this.width - this.right, this.height, 0, 0, this.width, this.height);
    this.camera.updateProjectionMatrix();
  }
  enter(space: MeetingSpace) {
    if (this.space?.id === space.id && this.space.version === space.version) return;
    this.exit();
    const c = this.controls;
    this.saved = {
      position: this.camera.position.clone(),
      target: c.target.clone(),
      far: this.camera.far,
      enablePan: c.enablePan,
      enableZoom: c.enableZoom,
      enableDamping: c.enableDamping,
      minDistance: c.minDistance,
      maxDistance: c.maxDistance,
      mouseButtons: { ...c.mouseButtons },
      touches: { ...c.touches },
    };
    this.space = space;
    this.automatic = true;
    c.enablePan = false;
    c.enableZoom = false;
    c.enableDamping = false;
    c.minDistance = 0.1;
    c.maxDistance = Infinity;
    c.mouseButtons = { LEFT: T.MOUSE.ROTATE, MIDDLE: T.MOUSE.ROTATE, RIGHT: T.MOUSE.ROTATE };
    c.touches = { ONE: T.TOUCH.ROTATE, TWO: T.TOUCH.DOLLY_ROTATE };
    this.shotNow = null;
    this.queued = null;
    this.speechEndedAt = null;
    this.dirty = true;
    this.projection();
  }
  exit() {
    if (this.saved) {
      const { position, target, far, ...controls } = this.saved;
      Object.assign(this.controls, controls);
      this.controls.target.copy(target);
      this.camera.position.copy(position);
      this.camera.far = far;
      this.camera.clearViewOffset();
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(target);
    }
    this.saved = null;
    this.space = null;
    this.speaker = null;
    this.shotNow = null;
    this.queued = null;
    this.speechEndedAt = null;
    this.automatic = true;
  }
  dispose() {
    this.exit();
  }
  setSpeaker(speaker: MeetingSpeaker | null) {
    this.speaker = speaker;
  }
  manualRotate() {
    if (this.active) this.automatic = false;
  }
  resumeAuto() {
    if (this.active) {
      this.automatic = true;
      this.dirty = true;
    }
  }

  private lastActors: ActorSnapshot[] = [];

  update(delta: number, actors: ActorSnapshot[]) {
    if (!this.space) return;
    this.lastActors = actors;
    const step = Math.max(0, delta);
    this.clock += step;
    if (!this.automatic) {
      if (this.dirty) this.keepTableInManualView();
      return;
    }
    const wanted = this.speakingActor(actors);
    const next = this.decide(wanted);
    // A settings change or "resume auto" re-frames the same shot, smoothly.
    if (next) this.begin(next);
    else if (this.dirty) this.begin(this.shotNow ?? { kind: "table" });
    this.elapsed += step;
    this.apply();
  }

  /**
   * Which shot to move to now, or `null` to stay. Entering a speaker shot is never delayed — the
   * camera answers the moment output starts (the rule `speaker-tracker` enforces). Only leaving is
   * cushioned, by the minimum dwell and the post-speech hold, so fast exchanges do not whip the
   * camera back and forth.
   */
  private decide(wanted: { key: string } | null): Shot | null {
    const current = this.shotNow;
    if (!current) return wanted ? { kind: "speaker", key: wanted.key } : { kind: "table" };

    if (current.kind === "table") {
      if (this.queued && this.settled()) {
        const key = this.queued;
        this.queued = null;
        if (wanted?.key === key) return { kind: "speaker", key };
      }
      if (wanted && !this.queued) return { kind: "speaker", key: wanted.key };
      return null;
    }

    // current is a speaker shot
    if (wanted?.key === current.key) {
      this.speechEndedAt = null;
      return null;
    }
    if (this.speechEndedAt === null) this.speechEndedAt = this.clock;
    if (this.clock - this.shotSince < this.opt("minSpeakerDwellSeconds")) return null;
    if (wanted) {
      if (this.opt("directHandoff")) return { kind: "speaker", key: wanted.key };
      this.queued = wanted.key;
      return { kind: "table" };
    }
    if (this.clock - this.speechEndedAt < this.opt("holdAfterSpeechSeconds")) return null;
    return { kind: "table" };
  }

  private settled() {
    return this.duration === 0 || this.elapsed >= this.duration;
  }

  private speakingActor(actors: ActorSnapshot[]): { key: string; actor: ActorSnapshot } | null {
    const s = this.speaker;
    if (!s) return this.found("none");
    if (s.phase && s.phase !== "speaking") return this.found("not-speaking");
    const b = this.space!.bounds;
    const actor = actors.find((a) =>
      s.kind === "npc" ? a.kind === "npc" && a.id === s.id : a.kind !== "npc" && a.userId === s.id,
    );
    if (!actor) return this.found("no-actor");
    const x = actor.x / 32;
    const z = actor.y / 32;
    if (x < b.x || x > b.x + b.width || z < b.y || z > b.y + b.height)
      return this.found("outside-room");
    this.speakerState = "found";
    return { key: `${s.kind}:${s.id}`, actor };
  }

  private found(state: MeetingSpeakerState): null {
    this.speakerState = state;
    return null;
  }

  private actorForKey(key: string): ActorSnapshot | undefined {
    const [kind, ...rest] = key.split(":");
    const id = rest.join(":");
    return this.lastActors.find((a) =>
      kind === "npc" ? a.kind === "npc" && a.id === id : a.kind !== "npc" && a.userId === id,
    );
  }

  /** Start a transition to `shot` (or re-frame it, when it is already the current shot). */
  private begin(shot: Shot) {
    // Compute the framing **first**. It used to change the shot name first and then compute, so when the computation threw the shot
    // was "speaker" while the screen stayed on the table, and from the next frame on it was the same shot so it never retried.
    let framed: { target: T.Vector3; orbit: T.Spherical };
    try {
      framed = this.compose(shot);
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      if (!this.errorReported) {
        this.errorReported = true;
        console.error("[meeting-camera] framing failed", error);
      }
      this.dirty = false;
      return;
    }
    const first = this.shotNow === null;
    if (first || shotLabel(shot) !== this.shot) {
      this.shotNow = shot;
      this.shotSince = this.clock;
      if (shot.kind === "table") this.speechEndedAt = null;
    }
    const { target, orbit } = framed;
    this.dirty = false;
    this.fromTarget.copy(this.controls.target);
    this.fromOrbit.setFromVector3(this.camera.position.clone().sub(this.controls.target));
    this.toTarget.copy(target);
    this.toOrbit.copy(orbit);
    // Shortest way round, so a turn never spins through the long side.
    this.toOrbit.theta =
      this.fromOrbit.theta +
      Math.atan2(
        Math.sin(orbit.theta - this.fromOrbit.theta),
        Math.cos(orbit.theta - this.fromOrbit.theta),
      );
    this.elapsed = 0;
    this.duration = first
      ? this.opt("roomTransitionSeconds")
      : this.opt("speakerTransitionSeconds");
    this.camera.far = Math.max(250, orbit.radius * 4);
    this.camera.updateProjectionMatrix();
  }

  /** Apply the current transition frame. */
  private apply() {
    const t =
      this.options.reducedMotion || this.duration === 0
        ? 1
        : Math.min(1, this.elapsed / this.duration);
    // Cubic ease-in-out: gentler start and landing than smoothstep.
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    this.controls.target.lerpVectors(this.fromTarget, this.toTarget, ease);
    const orbit = new T.Spherical(
      T.MathUtils.lerp(this.fromOrbit.radius, this.toOrbit.radius, ease),
      T.MathUtils.lerp(this.fromOrbit.phi, this.toOrbit.phi, ease),
      T.MathUtils.lerp(this.fromOrbit.theta, this.toOrbit.theta, ease),
    );
    this.camera.position.copy(this.controls.target).add(new T.Vector3().setFromSpherical(orbit));
    this.camera.lookAt(this.controls.target);
  }

  /** Re-fit the current shot immediately (no transition). */
  private snapToCurrent() {
    if (!this.automatic) {
      this.keepTableInManualView();
      return;
    }
    const shot = this.shotNow ?? { kind: "table" };
    const { target, orbit } = this.compose(shot);
    this.controls.target.copy(target);
    this.camera.position.copy(target).add(new T.Vector3().setFromSpherical(orbit));
    this.camera.far = Math.max(250, orbit.radius * 4);
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(target);
    this.fromTarget.copy(target);
    this.toTarget.copy(target);
    this.fromOrbit.copy(orbit);
    this.toOrbit.copy(orbit);
    this.duration = 0;
    this.dirty = false;
  }

  /** Manual orbit keeps the user's angle, but never lets a resize cut the table off. */
  private keepTableInManualView() {
    const orbit = new T.Spherical().setFromVector3(
      this.camera.position.clone().sub(this.controls.target),
    );
    const box = this.tableBox();
    orbit.radius = Math.max(orbit.radius, this.fitRadius(box, this.controls.target, orbit));
    this.camera.position.copy(this.controls.target).add(new T.Vector3().setFromSpherical(orbit));
    this.camera.lookAt(this.controls.target);
    this.dirty = false;
  }

  private compose(shot: Shot): { target: T.Vector3; orbit: T.Spherical } {
    const table = this.tableBox();
    const tableCenter = table.min.clone().add(table.max).multiplyScalar(0.5);
    const actor = shot.kind === "speaker" ? this.actorForKey(shot.key) : undefined;
    if (shot.kind === "table" || !actor) return this.tableShot(table, tableCenter);

    const shown = this.presenter?.(actor) ?? null;
    const seat = shown ? undefined : this.seatOf(actor);
    // Stand where the speaker is looking: the camera sits on their facing side, so we see the face.
    // The renderer knows which way the body actually turned (a seated body faces its seat).
    const heading = shown
      ? shown.yaw
      : (() => {
          const facing = facingOf(actor.direction);
          return Math.atan2(facing.x, facing.z);
        })();
    const framing = this.opt("speakerFraming");

    if (framing === "table") {
      // Keep the whole table, but look at it from the speaker's facing side.
      const orbit = new T.Spherical(1, Math.PI / 2 - TABLE_ELEVATION, heading);
      return this.centeredFit(table, tableCenter, orbit);
    }

    const body: Box = shown
      ? { min: shown.box.min.clone(), max: shown.box.max.clone() }
      : (() => {
          const x = seat?.x ?? actor.x / 32;
          const z = seat?.z ?? actor.y / 32;
          const head = seat ? SEATED_HEAD : STANDING_HEAD;
          return {
            min: new T.Vector3(x - 0.6, 0, z - 0.6),
            max: new T.Vector3(x + 0.6, head, z + 0.6),
          };
        })();
    const angle = new T.Spherical(1, Math.PI / 2 - SPEAKER_ELEVATION, heading);
    if (framing === "face") return this.speakerFit(body, BUST_SHARE, angle);
    if (framing === "fullBody") return this.speakerFit(body, 1, angle);
    // Upper body. When seats are adjacent the neighbor comes in at the side of the 16:9 screen and it becomes a two-shot (staging measurement).
    // Only then pull in to above the chest to keep the speaker as the subject. With the side empty, keep the upper body.
    const upper = this.speakerFit(body, UPPER_BODY_SHARE, angle);
    return this.neighborInFrame(actor, upper) ? this.speakerFit(body, BUST_SHARE, angle) : upper;
  }

  /** Center and contain the top `share` of the body box (including headroom). */
  private speakerFit(body: Box, share: number, angle: T.Spherical) {
    const height = body.max.y - body.min.y;
    const bottom = body.max.y - height * share;
    const cx = (body.min.x + body.max.x) / 2;
    const cz = (body.min.z + body.max.z) / 2;
    const half = Math.max(0.35, (body.max.x - body.min.x) / 2, (body.max.z - body.min.z) / 2);
    const box: Box = {
      min: new T.Vector3(cx - half, bottom, cz - half),
      max: new T.Vector3(cx + half, body.max.y + HEADROOM, cz + half),
    };
    // Centre the speaker. An earlier version leaned the aim toward the table for an
    // over-the-shoulder feel; on the real map that pushed the speaker off the edge of the frame.
    const framed = this.centeredFit(box, box.min.clone().add(box.max).multiplyScalar(0.5), angle);
    framed.orbit.radius = Math.max(MIN_SPEAKER_DISTANCE, framed.orbit.radius);
    this.keepNearRoom(box, framed.target, framed.orbit);
    return framed;
  }

  /** Whether the head of a participant other than the speaker falls within this framing's screen (in front of the camera). */
  private neighborInFrame(
    speaker: ActorSnapshot,
    framed: { target: T.Vector3; orbit: T.Spherical },
  ) {
    const cam = this.placeScratch(framed.target, framed.orbit);
    const usable = (this.width - this.right) / this.width;
    const forward = cam.getWorldDirection(new T.Vector3());
    for (const other of this.lastActors) {
      if (other === speaker || !this.inRoom(other)) continue;
      const head = this.headOf(other);
      if (head.clone().sub(cam.position).dot(forward) <= 0) continue;
      const p = head.project(cam);
      const x = (p.x + 1) / 2 / usable;
      const y = (1 - p.y) / 2;
      if (x > 0 && x < 1 && y > 0 && y < 1) return true;
    }
    return false;
  }

  private headOf(actor: ActorSnapshot): T.Vector3 {
    const shown = this.presenter?.(actor) ?? null;
    if (shown) {
      const b = shown.box;
      return new T.Vector3((b.min.x + b.max.x) / 2, b.max.y - 0.15, (b.min.z + b.max.z) / 2);
    }
    const seat = this.seatOf(actor);
    return new T.Vector3(
      seat?.x ?? actor.x / 32,
      (seat ? SEATED_HEAD : STANDING_HEAD) - 0.15,
      seat?.z ?? actor.y / 32,
    );
  }

  private inRoom(actor: ActorSnapshot) {
    const b = this.space?.bounds;
    if (!b) return false;
    const x = actor.x / 32;
    const z = actor.y / 32;
    return x >= b.x && x <= b.x + b.width && z >= b.y && z <= b.y + b.height;
  }

  /**
   * The table view. A fixed heading looked at people along the line they sat in, so they overlapped
   * and filled a third of the width (measured). Try headings across the front half of the room and
   * keep the one that frames the table tightest — that is the angle where the table spreads out
   * across the screen. Ties go to the old default so a symmetric room keeps its familiar angle.
   */
  private tableShot(table: Box, center: T.Vector3) {
    let best: { target: T.Vector3; orbit: T.Spherical } | null = null;
    for (let step = -6; step <= 6; step++) {
      const heading = TABLE_HEADING + step * T.MathUtils.degToRad(15);
      const framed = this.centeredFit(
        table,
        center,
        new T.Spherical(1, Math.PI / 2 - TABLE_ELEVATION, heading),
      );
      if (!best || framed.orbit.radius < best.orbit.radius - 1e-3) best = framed;
    }
    return best!;
  }

  /**
   * Fit `box` at the given angle with its projection centred in the usable viewport. Seen at an
   * angle, a box's picture is lopsided around its centre point, so aiming at the centre wastes the
   * frame on one side. Nudge the aim toward the picture's centre and re-fit, a few times.
   */
  private centeredFit(box: Box, start: T.Vector3, angle: T.Spherical) {
    const target = start.clone();
    const orbit = angle.clone();
    const cam = this.scratch;
    const halfV = Math.tan(T.MathUtils.degToRad(this.camera.fov / 2));
    const aspect = (this.width - this.right) / this.height;
    for (let i = 0; i < 4; i++) {
      orbit.radius = this.fitRadius(box, target, orbit);
      const rect = this.projectedRect(box, target, orbit);
      const right = new T.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const up = new T.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      const dx = ((rect.minX + rect.maxX) / 2 - 0.5) * 2 * orbit.radius * halfV * aspect;
      const dy = -((rect.minY + rect.maxY) / 2 - 0.5) * 2 * orbit.radius * halfV;
      if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) break;
      target.addScaledVector(right, dx).addScaledVector(up, dy);
    }
    orbit.radius = this.fitRadius(box, target, orbit);
    return { target, orbit };
  }

  /** Box picture in usable-viewport units (0..1 across the unobscured area, 0..1 top to bottom). */
  private projectedRect(box: Box, target: T.Vector3, orbit: T.Spherical) {
    const cam = this.placeScratch(target, orbit);
    const usable = (this.width - this.right) / this.width;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const corner of boxCorners(box)) {
      const p = corner.project(cam);
      const x = (p.x + 1) / 2 / usable;
      const y = (1 - p.y) / 2;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return { minX, maxX, minY, maxY };
  }

  private placeScratch(target: T.Vector3, orbit: T.Spherical) {
    const cam = this.scratch;
    cam.copy(this.camera);
    cam.setViewOffset(this.width - this.right, this.height, 0, 0, this.width, this.height);
    cam.updateProjectionMatrix();
    cam.position.copy(target).add(new T.Vector3().setFromSpherical(orbit));
    cam.lookAt(target);
    cam.updateMatrixWorld(true);
    return cam;
  }

  /**
   * Keep a speaker shot near the room without ever cropping the speaker.
   *
   * The first version pulled the camera in until it was inside the walls, and that cut the
   * speaker's head off (a test caught it). Walls between the camera and the people are already
   * faded by `MeetingWallOcclusion`, so standing just outside a wall costs nothing; what we must
   * not do is wander deep into the next room, where nothing is faded. So: raise the camera until it
   * sits within a wall's reach of the room, re-fitting at every angle so the frame stays whole.
   */
  private keepNearRoom(box: Box, target: T.Vector3, orbit: T.Spherical) {
    const b = this.space!.bounds;
    const near = (o: T.Spherical) => {
      const p = target.clone().add(new T.Vector3().setFromSpherical(o));
      return (
        p.x >= b.x - ROOM_REACH &&
        p.x <= b.x + b.width + ROOM_REACH &&
        p.z >= b.y - ROOM_REACH &&
        p.z <= b.y + b.height + ROOM_REACH
      );
    };
    if (near(orbit)) return;
    const start = orbit.phi;
    for (let phi = start; phi >= T.MathUtils.degToRad(20); phi -= T.MathUtils.degToRad(3)) {
      const trial = new T.Spherical(1, phi, orbit.theta);
      trial.radius = Math.max(MIN_SPEAKER_DISTANCE, this.fitRadius(box, target, trial));
      if (near(trial)) {
        orbit.phi = trial.phi;
        orbit.radius = trial.radius;
        return;
      }
    }
  }

  private seatOf(actor: ActorSnapshot): Point | undefined {
    const x = actor.x / 32;
    const z = actor.y / 32;
    let best: Point | undefined;
    let bestDistance = SEAT_SNAP;
    for (const seat of this.seats) {
      const d = Math.hypot(seat.x - x, seat.z - z);
      if (d <= bestDistance) {
        best = seat;
        bestDistance = d;
      }
    }
    return best;
  }

  /**
   * "The whole table": the seats, plus anyone standing in the room. With neither, the room.
   * Framing people instead of the room rectangle is the point — empty floor and shelves were most
   * of the picture before.
   */
  private tableBox(): Box {
    const b = this.space!.bounds;
    const points: Point[] = [...this.seats];
    let top = SEATED_HEAD;
    for (const actor of this.lastActors) {
      const x = actor.x / 32;
      const z = actor.y / 32;
      if (x < b.x || x > b.x + b.width || z < b.y || z > b.y + b.height) continue;
      // With the actual appearance, use its bounds — a seated person is contained at the seat, a standing person at their height.
      const shown = this.presenter?.(actor);
      if (shown) {
        points.push({ x: shown.box.min.x + BODY_PAD, z: shown.box.min.z + BODY_PAD });
        points.push({ x: shown.box.max.x - BODY_PAD, z: shown.box.max.z - BODY_PAD });
        top = Math.max(top, shown.box.max.y);
      } else points.push({ x, z });
    }
    if (points.length === 0) {
      return {
        min: new T.Vector3(b.x, 0, b.y),
        max: new T.Vector3(b.x + b.width, SEATED_HEAD, b.y + b.height),
      };
    }
    const min = new T.Vector3(Infinity, 0, Infinity);
    const max = new T.Vector3(-Infinity, top, -Infinity);
    for (const p of points) {
      min.x = Math.min(min.x, p.x - BODY_PAD);
      min.z = Math.min(min.z, p.z - BODY_PAD);
      max.x = Math.max(max.x, p.x + BODY_PAD);
      max.z = Math.max(max.z, p.z + BODY_PAD);
    }
    return { min, max };
  }

  /**
   * Smallest distance at which every corner of `box` lands inside the usable viewport (the canvas
   * minus the meeting panel) with a margin. Unlike a bounding sphere this knows the viewing angle,
   * so it frames as tight as that angle allows.
   */
  private fitRadius(box: Box, target: T.Vector3, orbit: T.Spherical): number {
    const corners = boxCorners(box);
    const usable = (this.width - this.right) / this.width;
    const fits = (radius: number) => {
      const cam = this.placeScratch(target, new T.Spherical(radius, orbit.phi, orbit.theta));
      for (const corner of corners) {
        const inView = corner.clone().applyMatrix4(cam.matrixWorldInverse);
        if (inView.z > -cam.near) return false;
        const p = corner.clone().project(cam);
        const px = (p.x + 1) / 2;
        if (px < FIT_MARGIN * usable || px > usable * (1 - FIT_MARGIN)) return false;
        if (Math.abs(p.y) > 1 - 2 * FIT_MARGIN) return false;
      }
      return true;
    };
    let lo = 0.5;
    let hi = 400;
    if (!fits(hi)) return hi;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  }
}

function boxCorners(box: Box): T.Vector3[] {
  const corners: T.Vector3[] = [];
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) corners.push(new T.Vector3(x, y, z));
  return corners;
}

function shotLabel(shot: Shot) {
  return shot.kind === "table" ? "table" : `speaker:${shot.key}`;
}

/** Screen `down` is +z in the world, `right` is +x. */
function facingOf(direction: string): Point {
  switch (direction) {
    case "up":
      return { x: 0, z: -1 };
    case "left":
      return { x: -1, z: 0 };
    case "right":
      return { x: 1, z: 0 };
    default:
      return { x: 0, z: 1 };
  }
}
