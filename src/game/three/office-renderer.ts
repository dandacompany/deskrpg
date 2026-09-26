import { FurnitureHighlight } from "./furniture-highlight";
import { buildOfficeBoard, boardApproach, BoardArrival } from "./office-kanban";
import { isPublishingMap, addPublishingArchitecture } from "./publishing-scene";
import { renderPublishingObject } from "./publishing-assets";
import { isTradingMap, addTradingArchitecture, joinedPartitionSpan } from "./trading-scene";
import { renderTradingObject } from "./trading-assets";
import { attachSceneAsset as attachCatalogAsset, type SceneAssetId } from "./scene-asset-catalog";
import { studioLabelOccluded, captureStudioReflection } from "./studio-visibility";
import { addTechStartupSurfaces, isTechStartupMap, techPartitionSpan } from "./tech-startup-scene";
import { renderTechStartupObject } from "./tech-startup-assets";
import { finalizeStudioScene, renderCreativeStudioObject } from "./creative-studio-renderer";
import { addCreativeStudioScene } from "./creative-studio-renderer";
import { isCreativeStudioMap, creativeStudioOverview } from "./creative-studio-architecture";
import { furnitureOffset } from "./executive-lounge-layout";
import { MeetingCamera, type MeetingSpeaker, type MeetingCameraOptions } from "./meeting-camera";
import { MeetingWallOcclusion } from "./meeting-wall-occlusion";
import type { MeetingSpace } from "../meeting-space";
import { attachFurnitureAsset, attachSceneAsset } from "./furniture-asset";
import { disposeTree } from "./dispose-tree";
export { disposeTree } from "./dispose-tree";
import { addExecutiveArchitecture } from "./executive-architecture";
import { adaptRenderScale } from "./render-scale";
import { layoutActorLabels, bubbleWidthFor, type ActorLabelAnchor } from "./label-layout";
import {
  FrameBenchmark,
  sceneTransferBytes,
  type BenchmarkReport,
  type FrameMetrics,
} from "./frame-benchmark";
import { showPerformanceHud } from "./performance-hud";
import { turnToward } from "../navigation";
import { addOfficePerimeter } from "./office-perimeter";
import { buildRoomFurniture } from "./room-furniture";
import { addRoomPartition, addRoomTJunction, addOfficeRoomSurfaces } from "./room-architecture";
import { batchStaticFurniture, batchCoplanarGlass } from "./static-batching";
import { officeFinish } from "./office-finishes";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { officeLighting, shadowExtent, applyOfficeShadowFilter } from "./office-lighting";
import { detailSurfaces, surfaceTexture } from "./surface-detail";
import { resolveSeat, seatAt, sofaSeats, furnitureSeats, type Seat } from "./seating";
import { createGaitTracker } from "./gait";
import { PointerGesture } from "./pointer-gesture";
import { buildBoundsTrees } from "./raycast-acceleration";
import { pickFurnitureSeat } from "./seat-picking";
import {
  resolveSeatAction,
  seatReservationId,
  seatSelectionHighlighted,
  type SeatAction,
} from "./seat-action";
import { resolveOfficeLook } from "./office-looks";
import { isOfficeEnvironmentId } from "./office-environment-theme";
import * as T from "three";
import { addOfficeDetails } from "./office-details";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createActor, round, sphere, cylinder } from "./characters";
import {
  actorIndicator,
  actorPosePhase,
  actorStateUnknown,
  actorPresentationPhase,
  speechActorId,
  pixelToWorld,
  overviewDistance,
  worldToPixel,
  type ActorSnapshot,
  type OfficeBridge,
  type MapSnapshot,
  indicatorCountLabel,
} from "./bridge";
import { getObjectDimensions, TILE_ID_TO_OBJECT, type MapObject } from "../../lib/object-types";
import { normalizeLocale } from "../../lib/i18n/server";

/** The renderer draws a few strings outside React; they follow the page's `<html lang>`. */
const RENDERER_TEXT = {
  speechRail: {
    ko: "현재 화면의 대화",
    en: "Conversations in view",
    ja: "表示中の会話",
    zh: "当前画面中的对话",
  },
  kanbanBoard: {
    ko: "Kanban · 클릭하여 이동",
    en: "Kanban · click to walk over",
    ja: "Kanban · クリックして移動",
    zh: "Kanban · 点击前往",
  },
} as const;

function rendererText(key: keyof typeof RENDERER_TEXT, lang: string): string {
  return RENDERER_TEXT[key][normalizeLocale(lang)];
}

/** Glyphs next to name tags — three conversation responses + working (R27). `actorIndicator` decides priority. */
const INDICATOR_GLYPH: Record<NonNullable<ReturnType<typeof actorIndicator>> | "none", string> = {
  unknown: "❔",
  awaiting_approval: "✋",
  stopped_after_failures: "⚠️",
  response_failed: "❗",
  queued: "⏳",
  thinking: "💭",
  streaming: "💬",
  working: "🛠️",
  none: "",
};

const palettes = {
  office: { floor: "#e3d0aa", wall: "#dae2d2", wood: "#b48a60", outside: "#e9eee2" },
  hanok: { floor: "#ddc6a2", wall: "#eee5cc", wood: "#765644", outside: "#e2e9da" },
  cafe: { floor: "#cbb49b", wall: "#dcc4ae", wood: "#895c43", outside: "#f1e5d8" },
};
export type OfficeTheme = keyof typeof palettes;
const environmentPalettes = {
  trading: { floor: "#e3d0aa", wall: "#dae2d2", wood: "#b48a60", outside: "#e9eee2" },
  agency: { floor: "#ecd2c1", wall: "#e5b5a3", wood: "#b77962", outside: "#f3e7df" },
  tech: { floor: "#d5e0db", wall: "#b1cbc6", wood: "#719389", outside: "#e5efed" },
  executive: { floor: "#d9cbb5", wall: "#62422d", wood: "#65584b", outside: "#f1eadf" },
  publishing: { floor: "#ecdfbf", wall: "#dfd0ab", wood: "#a17b4f", outside: "#f2ecda" },
};

type RenderedActor = {
  previous?: { x: number; z: number; time: number; direction: string };
  yaw?: number;
  /** Decide running from the visible movement speed — observed speed rather than move kind, so it is the same on every screen. */
  gait?: ReturnType<typeof createGaitTracker>;
  model: ReturnType<typeof createActor>;
  label: HTMLButtonElement;
  name: HTMLSpanElement;
  bubble: HTMLSpanElement;
  labelMeasure?: {
    name: string;
    text: string;
    width: number;
    nameWidth: number;
    bubbleHeight: number;
  };
  lookId?: string;
  labelOcclusion?: { time: number; hidden: boolean };
};

type SeatVisualTarget = {
  action: SeatAction;
  owner: T.Object3D;
};

/** Three.js presentation consumes the existing gameplay state; it never emits socket payloads. */
export class OfficeRenderer {
  private speechRail = document.createElement("div");
  private renderer: T.WebGLRenderer;
  private environmentTarget: T.WebGLRenderTarget;
  private scene = new T.Scene();
  private sun = new T.DirectionalLight();
  private fill = new T.DirectionalLight();
  private sky = new T.HemisphereLight();
  private seats: Seat[] = [];
  private seatBadges = new Map<number, HTMLDivElement>();
  private camera = new T.PerspectiveCamera(38, 1, 0.1, 250);
  private controls: OrbitControls;
  private meetingCamera: MeetingCamera;
  private meetingWalls = new MeetingWallOcclusion();
  private meetingWallObjects: T.Object3D[] = [];
  private meetingSpace: MeetingSpace | null = null;
  private meetingPreviousFollow = false;
  private meetingPreviousOverview: { cols: number; rows: number } | null = null;
  private meetingRightInset = 0;
  private meetingPointer: { x: number; y: number } | null = null;
  /** Instance-local UI notification; no socket or React dependency. */
  onMeetingCameraChange?: (state: { active: boolean; automatic: boolean }) => void;
  private world = new T.Group();
  private actors = new Map<string, RenderedActor>();
  private ray = new T.Raycaster();
  private ground = new T.Plane(new T.Vector3(0, 1, 0), 0);
  private cursor: T.Mesh;
  private resize: ResizeObserver;
  private frame = 0;
  private statsLabel: HTMLOutputElement | null = null;
  private sampleStart = 0;
  private sampleFrames = 0;
  private slowSamples = 0;
  private priorFrame = 0;
  private sampleIntervals: number[] = [];
  private disposed = false;
  private theme: OfficeTheme = "office";
  private following = true;
  private overviewDimensions: { cols: number; rows: number } | null = null;
  private lastMap = "";
  private lastMapStructure = "";
  private mapTimer = 0;
  private bridge: OfficeBridge | null = null;
  private gesture = new PointerGesture();
  public onKanbanOpen: () => void = () => {};
  private board: T.Group | null = null;
  private boardArrival = new BoardArrival();
  private meetingEntryWalking = false;
  private furnitureHighlight = new FurnitureHighlight();
  private cancelBoardKey = (e: KeyboardEvent) => {
    if (
      ["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "escape"].includes(
        e.key.toLowerCase(),
      )
    )
      this.boardArrival.cancel();
  };
  private hoveredActorId: string | undefined;
  /**
   * Hover picking happens only once per frame, and only while not grabbing the camera.
   *
   * `point()` raycasts the whole world triangle by triangle to find seats
   * (`pickFurnitureSeat(this.ray, this.world.children)`). Running it on every `pointermove`
   * runs it dozens of times per second on the same thread as the render loop while dragging the camera — measured (1680×1000,
   * M2 Max) about 59% of CPU in that span was three's raycasting, and frame p95 jumped from
   * 9.9ms → 66.6ms. Collect only the last coordinates and process once in tick.
   */
  private pendingMove: PointerEvent | null = null;
  private cameraInteracting = false;
  private selectedActorId: string | undefined;
  private hoveredSeat: SeatVisualTarget | null = null;
  private selectedSeat: SeatVisualTarget | null = null;
  private lastActors: ActorSnapshot[] = [];
  private speech = new Map<string, number>();
  private benchmark: {
    capture: FrameBenchmark;
    complete: (report: BenchmarkReport) => void;
  } | null = null;

  constructor(
    private host: HTMLDivElement,
    private labels: HTMLDivElement,
  ) {
    this.renderer = new T.WebGLRenderer({ antialias: true, alpha: false });
    // Shader error checking calls `getShaderParameter`/`getProgramInfoLog` right after linking, stalling the main thread until
    // the driver finishes compiling. In the long frames of entering a map these calls rise to the top
    // (measured). During development shader errors must be visible, so it is turned off only in production.
    this.renderer.debug.checkShaderErrors = process.env.NODE_ENV !== "production";
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    const room = new RoomEnvironment();
    const pmrem = new T.PMREMGenerator(this.renderer);
    this.environmentTarget = pmrem.fromScene(room, 0.04);
    this.scene.environment = this.environmentTarget.texture;
    this.scene.environmentIntensity = 0.28;
    room.dispose();
    pmrem.dispose();
    this.renderer.setClearColor(palettes.office.outside);
    this.renderer.domElement.setAttribute("aria-label", "DeskRPG 3D");
    if (showPerformanceHud(process.env.NODE_ENV, process.env.NEXT_PUBLIC_README_CAPTURE)) {
      this.statsLabel = document.createElement("output");
      this.statsLabel.setAttribute("aria-label", "3D performance");
      this.statsLabel.style.cssText =
        "position:absolute;left:12px;bottom:12px;pointer-events:none;font:11px monospace;color:#344b3c;background:#faf8efde;padding:4px 7px;z-index:5";
      this.statsLabel.textContent = "Measuring 3D frames…";
      this.host.append(this.statsLabel);
    }
    this.host.append(this.renderer.domElement);
    this.speechRail.className = "office-speech-rail";
    this.speechRail.hidden = true;
    this.speechRail.setAttribute("role", "region");
    this.speechRail.setAttribute(
      "aria-label",
      rendererText("speechRail", document.documentElement.lang),
    );
    this.speechRail.tabIndex = 0;
    this.labels.append(this.speechRail);
    this.scene.add(this.world, this.sky, this.sun, this.sun.target, this.fill, this.fill.target);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.normalBias = 0.018;
    this.sun.shadow.bias = -0.00015;
    this.sun.shadow.camera.near = 0.5;
    this.sun.shadow.camera.far = 120;
    this.camera.position.set(22, 22, 28);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(15, 0, 12);
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = false;
    this.controls.touches = { ONE: T.TOUCH.PAN, TWO: T.TOUCH.DOLLY_ROTATE };
    this.controls.minDistance = 8;
    this.controls.maxDistance = 85;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minPolarAngle = 0.15;
    // A short left click walks; dragging pans without issuing a movement command.
    this.controls.mouseButtons = { LEFT: T.MOUSE.PAN, MIDDLE: T.MOUSE.PAN, RIGHT: T.MOUSE.ROTATE };
    this.controls.addEventListener("start", this.stopFollowing);
    this.controls.addEventListener("start", this.cameraInteractionStart);
    this.controls.addEventListener("end", this.cameraInteractionEnd);
    this.meetingCamera = new MeetingCamera(this.camera, this.controls, {
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    });
    this.cursor = new T.Mesh(
      new T.PlaneGeometry(0.96, 0.96),
      new T.MeshBasicMaterial({
        color: "#578467",
        transparent: true,
        opacity: 0.45,
        side: T.DoubleSide,
        depthWrite: false,
      }),
    );
    this.cursor.rotation.x = -Math.PI / 2;
    this.cursor.position.y = 0.06;
    this.cursor.visible = false;
    this.scene.add(this.cursor);
    this.renderer.domElement.addEventListener("pointerdown", this.pointerDown);
    // Finish before OrbitControls releases capture and emits lostpointercapture.
    this.renderer.domElement.addEventListener("pointerup", this.pointerUp, true);
    this.renderer.domElement.addEventListener("pointermove", this.pointerMove);
    this.renderer.domElement.addEventListener("pointercancel", this.pointerCancel);
    this.renderer.domElement.addEventListener("lostpointercapture", this.pointerCancel);
    this.renderer.domElement.addEventListener("pointerleave", this.pointerLeave);
    this.renderer.domElement.addEventListener("contextmenu", this.contextMenu);
    this.resize = new ResizeObserver(() => {
      const { width, height } = this.host.getBoundingClientRect();
      if (!width || !height) return;
      this.renderer.setSize(width, height);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.meetingCamera.setViewport(width, height, this.meetingRightInset);
      if (this.overviewDimensions)
        this.overview(this.overviewDimensions.cols, this.overviewDimensions.rows);
    });
    this.resize.observe(host);
    document.addEventListener("visibilitychange", this.benchmarkVisibility);
    document.addEventListener("keydown", this.cancelBoardKey);
    this.scene.add(this.furnitureHighlight.group);
    this.tick(0);
  }
  attach(bridge: OfficeBridge) {
    this.exitMeeting();
    this.bridge?.setPresentation(false);
    this.bridge = bridge;
    bridge.setPresentation(true);
    this.lastMap = "";
    this.mapTimer = 0;
  }
  /** Diagnostics are public instance APIs, without a global browser hook. */
  readMetrics(): FrameMetrics {
    const statuses = [...this.actors.values()].map(
      (actor) => actor.model.root.userData.assetStatus,
    );
    const assetUrls = new Set<string>();
    this.world.traverse((object) => {
      if (object.userData.sceneAssetUrl) assetUrls.add(object.userData.sceneAssetUrl);
      for (const url of object.userData.sceneAssetUrls ?? []) assetUrls.add(url);
      if (object.userData.assetStatus) statuses.push(object.userData.assetStatus);
    });
    return {
      loadedSceneBytes: sceneTransferBytes(
        performance.getEntriesByType("resource") as PerformanceResourceTiming[],
        [...assetUrls],
      ),
      sceneAssets: assetUrls.size,
      failedAssets: statuses.filter((status) => status === "failed").length,
      pixelRatio: this.renderer.getPixelRatio(),
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      assetsReady:
        !!this.bridge &&
        this.lastMap === this.bridge.mapKey() &&
        this.actors.size === this.lastActors.length &&
        statuses.every((status) => status === "ready" || status === undefined),
      actorCount: this.actors.size,
      viewport: { width: this.host.clientWidth, height: this.host.clientHeight },
      devicePixelRatio: window.devicePixelRatio,
      mapKey: this.lastMap,
    };
  }
  /** Read-only pointer evidence for browser QA; no renderer internals are exposed globally. */
  readPointerIndicator() {
    return {
      visible: this.cursor.visible,
      x: this.cursor.position.x,
      z: this.cursor.position.z,
      cursor: this.renderer.domElement.style.cursor,
    };
  }
  startBenchmark(complete: (report: BenchmarkReport) => void) {
    if (this.benchmark) throw new Error("A benchmark is already running");
    if (document.hidden || !this.readMetrics().assetsReady)
      throw new Error("Keep the ready renderer visible before measuring");
    this.benchmark = { capture: new FrameBenchmark(() => performance.now()), complete };
  }
  cancelBenchmark(reason = "Benchmark cancelled") {
    const active = this.benchmark;
    if (!active) return;
    this.benchmark = null;
    active.complete(active.capture.invalidate(reason));
  }
  private benchmarkVisibility = () => {
    if (document.hidden) this.cancelBenchmark("Document became hidden");
  };
  showRoom(x: number, z: number, distance = 15) {
    if (this.meetingCamera.active) return;
    this.following = false;
    this.overviewDimensions = null;
    this.controls.target.set(x, 0, z);
    this.camera.position
      .copy(this.controls.target)
      .add(new T.Vector3(0.45, 0.9, 1).normalize().multiplyScalar(distance));
    this.controls.update();
  }
  setTheme(theme: OfficeTheme) {
    this.theme = theme;
    this.lastMap = "";
    this.mapTimer = 0;
  }
  focus() {
    if (this.meetingCamera.active) return;
    this.following = true;
    this.overviewDimensions = null;
  }
  overview(cols: number, rows: number) {
    if (this.meetingCamera.active) return;
    this.following = false;
    const studio =
      this.bridge &&
      (isCreativeStudioMap(this.bridge.map()) ||
        isTechStartupMap(this.bridge.map()) ||
        isTradingMap(this.bridge.map()) ||
        isPublishingMap(this.bridge.map()));
    this.controls.target.set(cols / 2, studio ? 1.2 : 0, rows / 2);
    this.overviewDimensions = { cols, rows };
    const aspect = this.host.clientWidth / Math.max(1, this.host.clientHeight);
    const preset = studio ? creativeStudioOverview(cols, rows, aspect) : null;
    const distance = preset?.distance ?? overviewDistance(cols, rows, aspect);
    this.controls.maxDistance = Math.max(85, distance * 2);
    this.camera.far = Math.max(250, distance * 4);
    this.camera.updateProjectionMatrix();
    if (preset) {
      this.controls.target.copy(preset.target);
      this.camera.position.copy(preset.position);
    } else
      this.camera.position
        .copy(this.controls.target)
        .add(new T.Vector3(0.45, 0.9, 1).normalize().multiplyScalar(distance));
  }
  showOverview() {
    if (this.bridge) {
      const map = this.bridge.map();
      this.overview(map.cols, map.rows);
    }
  }
  setCameraAngle(top: boolean) {
    this.pauseMeetingAuto();
    this.stopFollowing();
    const offset = this.camera.position.clone().sub(this.controls.target);
    const spherical = new T.Spherical().setFromVector3(offset);
    spherical.phi = top ? 0.15 : Math.PI / 3.5;
    this.camera.position
      .copy(this.controls.target)
      .add(new T.Vector3().setFromSpherical(spherical));
    this.controls.update();
  }
  rotateCamera(direction: number) {
    this.pauseMeetingAuto();
    this.stopFollowing();
    const offset = this.camera.position.clone().sub(this.controls.target);
    offset.applyAxisAngle(new T.Vector3(0, 1, 0), (direction * Math.PI) / 4);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
  }
  zoom(factor: number) {
    if (this.meetingCamera.active) return;
    this.stopFollowing();
    this.camera.position
      .sub(this.controls.target)
      .multiplyScalar(factor)
      .clampLength(8, this.controls.maxDistance)
      .add(this.controls.target);
  }
  talk(id: string) {
    this.speech.set(speechActorId(this.lastActors, id), performance.now() + 4000);
  }
  /** Uses the same map, renderer and actual actor snapshots as normal office mode. */
  enterMeeting(space = this.bridge?.map().meetingSpace): boolean {
    this.cancelBoardIntent();
    if (!space) return false;
    if (this.bridge && this.lastMap !== this.bridge.mapKey()) {
      this.buildMap(this.bridge.map());
      this.lastMap = this.bridge.mapKey();
    }
    if (this.meetingCamera.active && this.meetingSpace?.id === space.id) return true;
    if (this.meetingCamera.active) this.exitMeeting();
    this.meetingPreviousFollow = this.following;
    this.meetingPreviousOverview = this.overviewDimensions;
    this.following = false;
    this.overviewDimensions = null;
    this.meetingSpace = space;
    this.meetingCamera.setViewport(
      this.host.clientWidth,
      this.host.clientHeight,
      this.meetingRightInset,
    );
    this.meetingCamera.enter(space);
    // Hand over what was actually drawn so the camera does not guess people's position, direction and size. The ring (floor marker) is
    // wider than the body and blurs the framing, so only the rig is measured. precise reflects the skinned pose (seated).
    this.meetingCamera.setPresenter((actor) => {
      const rendered = this.actors.get(actor.id);
      if (!rendered) return null;
      const box = new T.Box3().setFromObject(rendered.model.rig, true);
      return box.isEmpty() ? null : { box, yaw: rendered.model.rig.rotation.y };
    });
    // "The whole table" is the seats in the room — the camera frames them, not the room's floor.
    const b = space.bounds;
    this.meetingCamera.setSeats(
      this.seats.filter(
        (seat) =>
          seat.x >= b.x && seat.x <= b.x + b.width && seat.z >= b.y && seat.z <= b.y + b.height,
      ),
    );
    this.meetingWalls.enter(this.meetingWallObjects);
    this.host.dataset.meeting = "true";
    this.cursor.visible = false;
    this.setHoveredSeat(null);
    this.onMeetingCameraChange?.(this.meetingCameraState());
    return true;
  }
  /** Leave in the DOM what the meeting camera is shooting now — diagnostics readable with developer tools in deployed builds. */
  private publishMeetingDiagnostics() {
    const { shot, speaker, error } = this.meetingCamera.diagnostics;
    const data = this.host.dataset;
    if (data.meetingShot !== shot) data.meetingShot = shot;
    if (data.meetingSpeaker !== speaker) data.meetingSpeaker = speaker;
    if (error === null) delete data.meetingCameraError;
    else if (data.meetingCameraError !== error) data.meetingCameraError = error;
  }

  exitMeeting() {
    const active = this.meetingCamera.active;
    this.meetingWalls.dispose();
    this.meetingCamera.exit();
    this.meetingSpace = null;
    this.meetingPointer = null;
    delete this.host.dataset.meeting;
    delete this.host.dataset.meetingShot;
    delete this.host.dataset.meetingSpeaker;
    delete this.host.dataset.meetingCameraError;
    if (active) {
      this.following = this.meetingPreviousFollow;
      this.overviewDimensions = this.meetingPreviousOverview;
    }
    this.onMeetingCameraChange?.(this.meetingCameraState());
  }
  /** The caller supplies actual speech, using one stable utterance ID per turn. */
  setMeetingSpeaker(speaker: MeetingSpeaker | null) {
    this.meetingCamera.setSpeaker(speaker);
  }
  configureMeetingCamera(options: MeetingCameraOptions) {
    this.meetingCamera.configure(options);
  }
  resumeMeetingAuto() {
    this.meetingCamera.resumeAuto();
    this.onMeetingCameraChange?.(this.meetingCameraState());
  }
  meetingCameraState() {
    return { active: this.meetingCamera.active, automatic: this.meetingCamera.automatic };
  }
  /** Inset only for a panel overlaying this canvas; use zero if layout already excludes it. */
  setMeetingViewport(rightInsetPx: number) {
    this.meetingRightInset = rightInsetPx;
    this.meetingCamera.setViewport(this.host.clientWidth, this.host.clientHeight, rightInsetPx);
  }
  private pauseMeetingAuto() {
    if (!this.meetingCamera.active || !this.meetingCamera.automatic) return;
    this.meetingCamera.manualRotate();
    this.onMeetingCameraChange?.(this.meetingCameraState());
  }
  private stopFollowing = () => {
    this.following = false;
    this.overviewDimensions = null;
    this.setHoveredSeat(null);
  };
  private setHoveredSeat(target: SeatVisualTarget | null) {
    this.hoveredSeat = target;
    this.refreshSeatHighlight();
  }
  private setSelectedSeat(target: SeatVisualTarget | null) {
    this.selectedSeat = target;
    this.refreshSeatHighlight();
  }
  private refreshSeatHighlight() {
    const target = this.hoveredSeat ?? this.selectedSeat;
    this.furnitureHighlight.highlight(target?.owner ?? null);
  }
  cancelBoardIntent() {
    this.boardArrival.cancel();
    this.refreshSeatHighlight();
  }
  setMeetingEntryState(status: string) {
    this.meetingEntryWalking = status === "walking";
    if (this.meetingEntryWalking) this.cancelBoardIntent();
  }
  private meetingOcclusionTargets() {
    if (!this.meetingSpace) return [];
    const b = this.meetingSpace.bounds;
    return this.lastActors
      .filter(
        (a) =>
          a.x / 32 >= b.x &&
          a.x / 32 <= b.x + b.width &&
          a.y / 32 >= b.y &&
          a.y / 32 <= b.y + b.height,
      )
      .map((a) => {
        const p = pixelToWorld(a.x, a.y);
        const seat = seatAt(this.seats, p.x, p.z, a.walking);
        return new T.Vector3(seat?.x ?? p.x, (seat?.elevation ?? 0) + 1.2, seat?.z ?? p.z);
      });
  }
  private seatAvailable(action: Pick<SeatAction, "x" | "z">) {
    if (!this.bridge) return false;
    if (this.bridge.seatAvailable) return this.bridge.seatAvailable(action.x, action.z);
    return (
      this.bridge.walkable(Math.floor(action.x), Math.floor(action.z)) &&
      !this.lastActors.some(
        (actor) => Math.hypot(actor.x / 32 - action.x, actor.y / 32 - action.z) < 0.45,
      )
    );
  }
  private contextMenu = (event: Event) => event.preventDefault();
  private pointerDown = (e: PointerEvent) => {
    if (this.meetingCamera.active) this.meetingPointer = { x: e.clientX, y: e.clientY };
    this.gesture.start(e);
    if (e.isPrimary && (e.button === 0 || e.button === 2))
      this.renderer.domElement.setPointerCapture(e.pointerId);
  };
  private pointerUp = (e: PointerEvent) => {
    if (this.gesture.finish(e)) this.point(e, "down");
    if (this.renderer.domElement.hasPointerCapture(e.pointerId))
      this.renderer.domElement.releasePointerCapture(e.pointerId);
  };
  private pointerCancel = () => {
    this.pendingMove = null;
    this.gesture.cancel();
  };
  /** Pause hover checks while grabbing the camera — the target under the cursor changes every frame, so it is meaningless. */
  private cameraInteractionStart = () => {
    this.cameraInteracting = true;
    this.pendingMove = null;
    this.hoveredActorId = undefined;
    this.setHoveredSeat(null);
    this.renderer.domElement.style.cursor = "default";
  };
  private cameraInteractionEnd = () => {
    this.cameraInteracting = false;
  };
  private pointerLeave = () => {
    this.furnitureHighlight.clear();
    this.hoveredActorId = undefined;
    this.cursor.visible = false;
    this.renderer.domElement.style.cursor = "default";
    this.setHoveredSeat(null);
  };
  private pointerMove = (e: PointerEvent) => {
    // The gesture (click or drag) must be checked per event to be accurate, and it is cheap.
    this.gesture.move(e);
    if (this.cameraInteracting) return;
    this.pendingMove = e;
  };
  private point(e: PointerEvent, kind: "move" | "down") {
    if (this.meetingEntryWalking) return;
    if (this.meetingCamera.active) {
      // OrbitControls owns meeting input; clicks never walk or edit the actual map.
      if (kind === "move" && e.buttons) {
        if (
          this.meetingPointer &&
          (e.clientX !== this.meetingPointer.x || e.clientY !== this.meetingPointer.y)
        )
          this.pauseMeetingAuto();
        this.meetingPointer = { x: e.clientX, y: e.clientY };
      } else this.meetingPointer = null;
      return;
    }
    if (!this.bridge) return;
    const editor = this.bridge.editor();
    let hoverOwner: T.Object3D | null = null;
    this.renderer.domElement.title = "";
    if (kind === "down") this.boardArrival.cancel();
    const rect = this.host.getBoundingClientRect();
    this.ray.setFromCamera(
      new T.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        (-(e.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      this.camera,
    );
    if (this.board && !editor.placement && !editor.spawn) {
      const boardHit = this.ray.intersectObject(this.board, true)[0];
      const blocker = this.ray.intersectObjects(this.world.children, true).find((h) => {
        if (!(h.object instanceof T.Mesh)) return false;
        for (let o: T.Object3D | null = h.object; o; o = o.parent) if (!o.visible) return false;
        const materials = Array.isArray(h.object.material)
          ? h.object.material
          : [h.object.material];
        return materials.some((m) => m.visible && !m.transparent);
      });
      if (boardHit && (!blocker || boardHit.distance <= blocker.distance + 0.04)) {
        this.setHoveredSeat(null);
        this.hoveredActorId = undefined;
        if (kind === "down") {
          this.setSelectedSeat(null);
          this.selectedActorId = undefined;
        }
        this.furnitureHighlight.highlight(this.board);
        this.renderer.domElement.title = rendererText("kanbanBoard", document.documentElement.lang);
        this.renderer.domElement.style.cursor = "pointer";
        this.cursor.visible = false;
        if (kind === "down" && e.button === 0) {
          const player = this.lastActors.find((a) => a.kind === "player");
          const goal =
            player &&
            boardApproach(this.bridge.map(), { x: player.x / 32, y: player.y / 32 }, (x, y) =>
              this.bridge!.walkable(x, y),
            );
          if (goal) {
            const x = (goal.x + 0.5) * 32,
              y = (goal.y + 0.5) * 32;
            this.bridge.pointer("down", x, y, 0, e.clientX, e.clientY, "kanban-target");
            this.boardArrival.start(x / 32, y / 32, performance.now());
            this.focus();
          }
        }
        return;
      }
    }
    const hit = this.ray.intersectObjects(
      [...this.actors.values()].map((a) => a.model.root),
      true,
    )[0];
    let actorId: string | undefined;
    let target = this.ray.ray.intersectPlane(this.ground, new T.Vector3());
    if (hit && !this.bridge.editor().placement) {
      let root: T.Object3D | null = hit.object;
      while (root && !root.userData.actorId) root = root.parent;
      const actor = this.lastActors.find((a) => a.id === root?.userData.actorId);
      if (actor && actor.kind !== "player") {
        actorId = actor.id;
        if (kind === "down") {
          const p = pixelToWorld(actor.x, actor.y);
          target = new T.Vector3(p.x, 0, p.z);
        }
      }
    }
    if (
      !actorId &&
      (kind === "move" || (kind === "down" && e.button === 0)) &&
      !editor.placement &&
      !editor.spawn
    ) {
      const picked = pickFurnitureSeat(this.ray, this.world.children);
      const furnitureHit = picked?.hit;
      const furniture = picked?.owner;
      hoverOwner = furniture ?? null;
      if (furniture?.userData.seat || furniture?.userData.seats) {
        const candidates: Seat[] = furniture.userData.seats ?? [furniture.userData.seat];
        const point = furnitureHit!.point;
        const action = resolveSeatAction(candidates, point, (seat) => {
          const x = seat.anchorX ?? seat.x,
            z = seat.anchorZ ?? seat.z;
          return this.seatAvailable({ x, z });
        });
        if (!action) {
          this.setHoveredSeat(null);
          this.renderer.domElement.style.cursor = "default";
          return;
        }
        target = new T.Vector3(action.x, 0, action.z);
        actorId = "seat-target"; // Avoid legacy nearby-NPC selection when clicking an adjacent cushion.
        const seatTarget = { action, owner: furniture };
        if (kind === "move") this.setHoveredSeat(seatTarget);
        if (kind === "down") {
          this.setSelectedSeat(seatTarget);
          if (e.pointerType !== "mouse") this.setHoveredSeat(null);
        }
      }
    }
    if (kind === "move" && actorId !== "seat-target") this.setHoveredSeat(null);
    if (kind === "down" && actorId !== "seat-target") this.setSelectedSeat(null);
    this.furnitureHighlight.highlight(
      this.hoveredSeat?.owner ?? this.selectedSeat?.owner ?? hoverOwner,
    );
    this.hoveredActorId = actorId;
    if (kind === "down") this.selectedActorId = actorId;
    this.renderer.domElement.style.cursor = actorId ? "pointer" : "default";
    if (!target) return;
    const col = Math.floor(target.x),
      row = Math.floor(target.z);
    this.cursor.position.set(col + 0.5, 0.06, row + 0.5);
    this.cursor.visible = editor.placement || editor.spawn;
    (this.cursor.material as T.MeshBasicMaterial).color.set(
      this.bridge.walkable(col, row) ? "#578467" : "#bd6756",
    );
    const pixel = worldToPixel(target.x, target.z);
    if (process.env.NODE_ENV === "development" && kind === "down") {
      // Read-only evidence of the actual raycast target for multi-client seat checks.
      this.renderer.domElement.dataset.pointerTarget = JSON.stringify({
        at: Date.now(),
        x: target.x,
        z: target.z,
        actorId: actorId ?? null,
        button: e.button,
        walkable: this.bridge.walkable(col, row),
      });
    }
    this.bridge.pointer(kind, pixel.x, pixel.y, e.button, e.clientX, e.clientY, actorId);
    if (kind === "down" && e.button === 0) this.focus();
  }
  /** Capture the current composed scene only after real assets are ready. */
  captureFrame(): string {
    if (!this.readMetrics().assetsReady) throw new Error("Scene assets are not ready");
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL("image/webp", 0.9);
  }
  private buildMap(map: MapSnapshot) {
    // Fingerprint only the map structure separately to decide whether to keep the meeting camera.
    const structure = JSON.stringify([
      map.cols,
      map.rows,
      map.floor,
      map.walls,
      map.blocked,
      map.objects,
      map.tiled,
      map.environment,
      map.environmentVersion,
      map.meetingSpace,
    ]);
    const keepMeeting = this.meetingCamera.active && structure === this.lastMapStructure;
    if (keepMeeting) this.meetingWalls.dispose();
    else this.exitMeeting();
    this.lastMapStructure = structure;
    this.meetingWallObjects = [];
    const registerMeetingWalls = (walls: T.Object3D[]) => {
      for (const wall of walls) wall.userData.meetingWall = true;
      this.meetingWallObjects.push(...walls);
    };
    this.setHoveredSeat(null);
    this.setSelectedSeat(null);
    this.furnitureHighlight.clear();
    this.boardArrival.cancel();
    if (this.board) {
      this.board.removeFromParent();
      disposeTree(this.board);
    }
    this.board = buildOfficeBoard(map);
    if (this.board) this.scene.add(this.board);
    disposeTree(this.world);
    const studio = isCreativeStudioMap(map);
    const tech = isTechStartupMap(map);
    const trading = isTradingMap(map);
    const publishing = isPublishingMap(map);
    const p = publishing
      ? { floor: "#d1b487", wall: "#e9e1cf", wood: "#b09369", outside: "#f4f0e6" }
      : trading
        ? { floor: "#c4bfb3", wall: "#e7e1d4", wood: "#c3aa82", outside: "#f2efe4" }
        : tech
          ? { floor: "#c6c8c7", wall: "#edf0ed", wood: "#c4ac89", outside: "#edf0e6" }
          : studio
            ? { floor: "#dfcdb0", wall: "#e5dfd2", wood: "#c9ae86", outside: "#f4f0e7" }
            : isOfficeEnvironmentId(map.environment)
              ? environmentPalettes[map.environment]
              : palettes[this.theme];
    const lighting = officeLighting(
      isOfficeEnvironmentId(map.environment) ? map.environment : undefined,
      studio ? 3 : undefined,
    );
    this.sun.color.set(lighting.sun);
    this.sun.intensity = lighting.sunIntensity;
    applyOfficeShadowFilter(this.scene, this.renderer.shadowMap, lighting.shadowMapType);
    this.sun.shadow.radius = lighting.shadowRadius;
    this.sky.color.set(lighting.sky);
    this.sky.groundColor.set("#8a8577");
    this.sky.intensity = lighting.hemisphereIntensity;
    this.fill.color.set("#deebff");
    this.fill.intensity = lighting.fillIntensity;
    this.renderer.toneMappingExposure = lighting.exposure;
    const cx = map.cols / 2,
      cz = map.rows / 2;
    // Daylight comes from the glazed rear of the miniature, not its camera side.
    this.sun.position.set(cx - 12, 26, cz - 18);
    this.sun.target.position.set(cx, 0, cz);
    this.fill.position.set(cx + 15, 14, cz + 12);
    this.fill.target.position.set(cx, 0, cz);
    const extent = shadowExtent(map.cols, map.rows);
    Object.assign(this.sun.shadow.camera, {
      left: -extent,
      right: extent,
      top: extent,
      bottom: -extent,
    });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.renderer.setClearColor(p.outside);
    const floorGrain =
      isOfficeEnvironmentId(map.environment) && !tech && !trading ? surfaceTexture("wood") : null;
    if (floorGrain) floorGrain.repeat.set(map.cols / 3, map.rows / 2);
    if (!trading) {
      round(
        this.world,
        map.cols + 0.3,
        0.3,
        map.rows + 0.3,
        p.wood,
        map.cols / 2,
        -0.2,
        map.rows / 2,
      );
      const floor = new T.Mesh(
        new T.PlaneGeometry(map.cols, map.rows),
        new T.MeshStandardMaterial({
          color: p.floor,
          roughness: 0.85,
          bumpMap: floorGrain,
          bumpScale: 0.018,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(map.cols / 2, -0.04, map.rows / 2);
      floor.receiveShadow = true;
      this.world.add(floor);
    }
    // Maps that are not environment presets are drawn from geometry alone (floor, walls, objects) without artwork.
    if (!isOfficeEnvironmentId(map.environment)) {
      const tiles = new T.InstancedMesh(
        new T.BoxGeometry(0.98, 0.015, 0.98),
        new T.MeshStandardMaterial({ roughness: 0.9 }),
        map.cols * map.rows,
      );
      const matrix = new T.Matrix4();
      let i = 0;
      for (let row = 0; row < map.rows; row++)
        for (let col = 0; col < map.cols; col++) {
          matrix.makeTranslation(col + 0.5, -0.01, row + 0.5);
          tiles.setMatrixAt(i, matrix);
          tiles.setColorAt(
            i++,
            new T.Color(
              map.floor[row]?.[col] === 0
                ? "#c0b5a1"
                : map.floor[row]?.[col] === 12
                  ? "#8caa8b"
                  : (row + col) % 2
                    ? p.floor
                    : "#e8d9bb",
            ),
          );
        }
      tiles.receiveShadow = true;
      this.world.add(tiles);
    }
    if (
      isOfficeEnvironmentId(map.environment) &&
      map.environment !== "executive" &&
      !studio &&
      !tech &&
      !trading
    ) {
      const finish = officeFinish(map.environment);
      const floorMap = surfaceTexture(finish.floor, "color");
      const floorBump = surfaceTexture(finish.floor);
      floorMap.repeat.set(1, 1);
      floorBump.repeat.set(1, 1);
      const floorPieces: { x: number; z: number; w: number; d: number; shade: number }[] = [];
      const depth = finish.floor === "fabric" ? 1 : 0.5;
      const length = finish.floor === "fabric" ? 1 : 2.4;
      for (let z = 0; z < map.rows; z += depth) {
        const offset = finish.floor === "fabric" ? 0 : (Math.round(z / depth) % 3) * 0.8;
        for (let x = -offset; x < map.cols; x += length) {
          const start = Math.max(0, x),
            end = Math.min(map.cols, x + length);
          if (end <= start) continue;
          const hash = Math.abs(Math.sin((x + 11) * 127.1 + (z + 7) * 311.7));
          floorPieces.push({
            x: (start + end) / 2,
            z: z + depth / 2,
            w: end - start - 0.008,
            d: depth - 0.008,
            shade: 0.94 + hash * 0.06,
          });
        }
      }
      const flooring = new T.InstancedMesh(
        new T.PlaneGeometry(1, 1),
        new T.MeshStandardMaterial({
          color: p.floor,
          map: floorMap,
          bumpMap: floorBump,
          bumpScale: 0.008,
          roughness: 0.9,
        }),
        floorPieces.length,
      );
      const floorTransform = new T.Object3D();
      floorPieces.forEach((piece, i) => {
        floorTransform.position.set(piece.x, 0.001, piece.z);
        floorTransform.rotation.set(-Math.PI / 2, 0, 0);
        floorTransform.scale.set(piece.w, piece.d, 1);
        floorTransform.updateMatrix();
        flooring.setMatrixAt(i, floorTransform.matrix);
        flooring.setColorAt(i, new T.Color().setScalar(piece.shade));
      });
      flooring.receiveShadow = true;
      this.world.add(flooring);
      // One draw call for staggered plank joints; no additional collision surfaces.
      const joints: number[] = [];
      const line = (x: number, z: number, x2: number, z2: number) =>
        joints.push(x, 0.003, z, x2, 0.003, z2);
      for (let z = 0.5; finish.floor === "wood" && z < map.rows; z += 0.5) {
        line(0, z, map.cols, z);
        for (let x = (Math.round(z * 2) % 3) * 0.8 + 0.4; x < map.cols; x += 2.4)
          line(x, z - 0.5, x, z);
      }
      const geometry = new T.BufferGeometry();
      geometry.setAttribute("position", new T.Float32BufferAttribute(joints, 3));
      this.world.add(
        new T.LineSegments(
          geometry,
          new T.LineBasicMaterial({
            color: p.wood,
            transparent: true,
            opacity: 0.17,
            depthWrite: false,
          }),
        ),
      );
    }
    // Known legacy walls become cutaway architectural walls. Custom collision stays semantic,
    // never guessed to be a wall.
    if (!map.tiled) {
      const architecture = map.floor.map((row, y) =>
        row.map((tile, x) =>
          [2, 7].includes(map.walls[y]?.[x])
            ? map.walls[y][x]
            : [2, 7].includes(tile)
              ? tile
              : map.walls[y]?.[x] || 0,
        ),
      );
      const cells = architecture.flatMap((row, y) =>
        row.flatMap((tile, x) => (tile === 2 ? [{ x, y }] : [])),
      );
      const ordinaryCells = map.meetingSpace ? [] : cells;
      const walls = new T.InstancedMesh(
        new T.BoxGeometry(1, 1.5, 1),
        new T.MeshStandardMaterial({ color: p.wall, roughness: 0.9 }),
        ordinaryCells.length,
      );
      const matrix = new T.Matrix4();
      ordinaryCells.forEach((c, i) => {
        matrix.makeTranslation(c.x + 0.5, 0.75, c.y + 0.5);
        walls.setMatrixAt(i, matrix);
      });
      walls.castShadow = true;
      walls.receiveShadow = true;
      this.world.add(walls);
      for (const c of map.meetingSpace ? cells : []) {
        const wall = new T.Mesh(walls.geometry, walls.material);
        wall.position.set(c.x + 0.5, 0.75, c.y + 0.5);
        wall.castShadow = true;
        wall.receiveShadow = true;
        wall.userData.meetingWall = true;
        this.world.add(wall);
        this.meetingWallObjects.push(wall);
      }
      architecture.forEach((row, y) =>
        row.forEach((tile, x) => {
          if (tile === 7) {
            const window = new T.Group();
            this.world.add(window);
            registerMeetingWalls([window]);
            round(window, 0.08, 1.45, 0.15, p.wood, x + 0.08, 0.725, y + 0.5);
            round(window, 0.08, 1.45, 0.15, p.wood, x + 0.92, 0.725, y + 0.5);
            round(window, 0.92, 0.1, 0.15, p.wood, x + 0.5, 1.4, y + 0.5);
          } else if (tile === 12)
            round(this.world, 0.98, 0.015, 0.98, "#8caa8b", x + 0.5, 0.01, y + 0.5);
        }),
      );
    }
    const tileObjects: MapObject[] = map.tiled
      ? []
      : [map.floor, map.walls].flatMap((layer, layerIndex) =>
          layer.flatMap((row, y) =>
            row.flatMap((value, x) =>
              TILE_ID_TO_OBJECT[value]
                ? [
                    {
                      id: `tile-${layerIndex}-${x}-${y}`,
                      type: TILE_ID_TO_OBJECT[value],
                      col: x,
                      row: y,
                    },
                  ]
                : [],
            ),
          ),
        );
    const furniture = [...tileObjects, ...map.objects];
    const finishedPerimeter =
      tech ||
      trading ||
      publishing ||
      (!!map.environment && furniture.some((object) => object.type === "room_wall_h"));
    const executive = map.environment === "executive";
    let remainingFurniture = furniture;
    if (studio) {
      const composition = addCreativeStudioScene(this.world, map)!;
      registerMeetingWalls(composition.userData.meetingWalls);
      void composition.userData.assetReady.then(() => {
        if (!this.disposed && composition.parent === this.world) {
          if (this.meetingCamera.active) this.meetingWalls.enter(this.meetingWallObjects);
          captureStudioReflection(this.renderer, this.scene, composition);
        }
      });
      remainingFurniture = composition.userData.unhandledObjects;
    }
    if (publishing)
      registerMeetingWalls(addPublishingArchitecture(this.world, map).userData.meetingWalls);
    if (trading)
      registerMeetingWalls(addTradingArchitecture(this.world, map).userData.meetingWalls);
    if (tech) addTechStartupSurfaces(this.world, map);
    if (executive) registerMeetingWalls(addExecutiveArchitecture(this.world, map.cols, map.rows));
    if (finishedPerimeter && !executive && !studio && !trading && !publishing)
      registerMeetingWalls(addOfficePerimeter(this.world, map.cols, map.rows, p.wall, p.wood));
    if (
      finishedPerimeter &&
      map.environment &&
      !executive &&
      !studio &&
      !tech &&
      !trading &&
      !publishing
    )
      addOfficeRoomSurfaces(this.world, map.environment, {
        environmentVersion: map.environmentVersion,
        hasLegacyPartitions: finishedPerimeter,
      });
    this.seats = furnitureSeats(furniture);
    const annexWalls = new Map(
      map.meetingSpace?.generatedAnnexWalls?.map((wall) => [wall.id, wall]) ?? [],
    );
    for (const object of remainingFurniture) {
      const marker = annexWalls.get(object.id);
      const annexDisplay =
        marker?.type === "room_wall_h" &&
        object.type === marker.type &&
        marker.col === object.col &&
        marker.row === object.row
          ? marker.display
          : undefined;
      if (annexDisplay === "hidden") continue;
      if (
        trading &&
        (object.variant === "trading-perimeter" || object.variant === "trading-world-map")
      )
        continue;
      if (studio && object.type === "glass_partition") continue;
      if (
        (finishedPerimeter || executive || studio) &&
        object.type === "cubicle_wall" &&
        (object.col === 0 ||
          object.col === map.cols - 1 ||
          object.row === 0 ||
          object.row === map.rows - 1)
      )
        continue;
      const group = new T.Group(),
        size = getObjectDimensions(object.type, object.direction);
      const furniturePlacement = furnitureOffset(object);
      group.position.set(
        object.col + size.width / 2 + furniturePlacement.x,
        0,
        object.row + size.height / 2 + furniturePlacement.z,
      );
      group.rotation.y = { up: Math.PI, down: 0, left: -Math.PI / 2, right: Math.PI / 2 }[
        object.type === "chair"
          ? resolveSeat(object, furniture).direction
          : object.direction || "down"
      ];
      group.name = `generic-object:${object.id}`;
      group.userData.mapObjectId = object.id;
      this.world.add(group);
      if (["room_wall_h", "room_wall_v", "cubicle_wall", "glass_partition"].includes(object.type))
        registerMeetingWalls([group]);
      const type = annexDisplay === "vertical" ? "room_wall_v" : object.type;
      if ((trading || publishing) && type === "glass_partition") {
        const span = joinedPartitionSpan(object, furniture);
        group.position.set(span.x, 0, span.z);
        group.rotation.y = 0;
        addRoomPartition(group, span.vertical, span.length);
        continue;
      }
      if (tech && type === "glass_partition") {
        const span = techPartitionSpan(object);
        group.position.set(span.x, 0, span.z);
        group.rotation.y = 0;
        addRoomPartition(group, span.vertical, span.length);
        continue;
      }
      if (type === "room_wall_h" || type === "room_wall_v") {
        if (annexDisplay === "corner") {
          addRoomPartition(group, false);
          addRoomPartition(group, true);
          continue;
        }
        const junction =
          annexDisplay !== "vertical" &&
          type === "room_wall_v" &&
          furniture.some(
            (other) =>
              other.type === "room_wall_h" &&
              other.row === object.row &&
              other.col === object.col - 1,
          ) &&
          furniture.some(
            (other) =>
              other.type === "room_wall_h" &&
              other.row === object.row &&
              other.col === object.col + 1,
          );
        if (junction) addRoomTJunction(group);
        else addRoomPartition(group, type === "room_wall_v");
        continue;
      }
      if (type === "chair") {
        const seat = resolveSeat(object, furniture);
        group.userData.seat = seat;
        group.position.set(seat.x, 0, seat.z);
      }
      if (publishing && renderPublishingObject(group, object)) {
        void attachCatalogAsset(group, object.variant as SceneAssetId);
        continue;
      }
      if ((trading || publishing) && renderTradingObject(group, object)) {
        void attachCatalogAsset(group, object.variant as SceneAssetId);
        continue;
      }
      if ((tech || trading || publishing) && renderTechStartupObject(group, object, furniture)) {
        void attachCatalogAsset(group, object.variant as SceneAssetId);
        continue;
      }
      if ((tech || trading || publishing) && renderCreativeStudioObject(group, object, furniture))
        continue;
      const roomFurniture = buildRoomFurniture(type, executive);
      if (roomFurniture) {
        const seats = sofaSeats(object);
        if (seats.length) group.userData.seats = seats;
        group.add(roomFurniture);
        if (executive) {
          const managerSeat =
            type === "chair" &&
            furniture.some(
              (desk) =>
                desk.type === "executive_desk" &&
                object.col >= desk.col &&
                object.col < desk.col + 4 &&
                object.row === desk.row - 1,
            );
          const asset =
            type === "executive_desk"
              ? "executive-desk"
              : type === "reception_desk"
                ? "desk"
                : type === "bookshelf"
                  ? "bookcase"
                  : managerSeat
                    ? "chair"
                    : type === "chair"
                      ? "guest-chair"
                      : type === "office_sofa"
                        ? "sofa"
                        : type === "office_armchair"
                          ? "armchair"
                          : type === "conference_table"
                            ? "conference"
                            : type === "meeting_table"
                              ? "coffee"
                              : undefined;
          if (asset) void attachFurnitureAsset(roomFurniture, asset);
        }
        continue;
      }
      if (
        type === "cubicle_wall" &&
        !object.direction &&
        object.row > 0 &&
        object.row < map.rows - 1 &&
        (object.col === 0 || object.col === map.cols - 1)
      )
        group.rotation.y = Math.PI / 2;
      if (type === "computer") {
        const executiveDesk =
          executive &&
          furniture.find(
            (desk) =>
              ["reception_desk", "executive_desk"].includes(desk.type) &&
              desk.col === object.col &&
              desk.row === object.row,
          );
        if (executiveDesk) {
          group.position.x = executiveDesk.col + getObjectDimensions(executiveDesk.type).width / 2;
          group.position.y = 0.06;
          group.rotation.y = Math.PI;
        }
      }
      if (
        addOfficeDetails(
          group,
          type,
          p.wood,
          p.wall,
          object.row === 0,
          isOfficeEnvironmentId(map.environment) ? map.environment : undefined,
        )
      ) {
        if (executive && type === "plant")
          void attachSceneAsset(group, (object.col + object.row) % 2 ? "olive" : "ficus");
        continue;
      }
      if (type.includes("desk") || type === "meeting_table") {
        const wide = type === "meeting_table" || type === "reception_desk" ? 1.8 : 0.9,
          deep = type === "meeting_table" ? 1.8 : 0.8;
        round(group, wide, 0.14, deep, p.wood, 0, 0.76, 0);
        for (const x of [-1, 1])
          for (const z of [-1, 1])
            round(group, 0.09, 0.7, 0.09, "#4e6657", x * wide * 0.38, 0.35, z * deep * 0.36);
      } else if (type === "chair") {
        round(group, 0.65, 0.15, 0.65, "#7c9c80", 0, 0.42, 0);
        round(group, 0.65, 0.65, 0.12, "#7c9c80", 0, 0.7, -0.28);
        cylinder(group, 0.07, 0.1, 0.4, "#4e6657", 0, 0.2, 0);
      } else if (type === "plant") {
        cylinder(group, 0.3, 0.22, 0.45, "#d4ae85", 0, 0.23, 0);
        cylinder(group, 0.035, 0.04, 0.7, p.wood, 0, 0.7, 0);
        for (const x of [-0.18, 0.18]) sphere(group, 0.35, "#668863", x, 1.0 + x, 0, 0.8, 1.2, 0.8);
        if (executive)
          void attachSceneAsset(group, (object.col + object.row) % 2 ? "olive" : "ficus");
      } else if (type === "computer") {
        round(group, 0.68, 0.45, 0.09, "#354e49", 0, 1.08, -0.14);
        round(group, 0.59, 0.34, 0.015, "#b9d8cc", 0, 1.08, -0.085);
        round(group, 0.07, 0.2, 0.07, "#354e49", 0, 0.78, -0.14);
      } else if (type === "whiteboard") {
        round(group, 0.94, 0.85, 0.1, "#fbf8e9", 0, 1, 0);
        round(group, 0.95, 0.07, 0.2, p.wood, 0, 0.55, 0);
      } else if (type === "bookshelf") {
        round(group, 0.9, 1.5, 0.38, p.wood, 0, 0.75, 0);
        for (let row = 0; row < 3; row++)
          for (let col = 0; col < 5; col++)
            round(
              group,
              0.1,
              0.3,
              0.2,
              ["#7a937a", "#cfaa7d", "#e5d5b5"][col % 3],
              (col - 2) * 0.15,
              0.28 + row * 0.44,
              0.22,
            );
      } else if (type === "water_cooler") {
        round(group, 0.55, 0.65, 0.55, "#f4f1e7", 0, 0.33, 0);
        cylinder(group, 0.2, 0.2, 0.4, "#a7c9d0", 0, 0.87, 0);
      } else
        round(
          group,
          0.8,
          type === "cubicle_wall" ? 1 : 0.75,
          0.6,
          type === "coffee" ? "#435851" : p.wall,
          0,
          0.4,
          0,
        );
    }
    if (tech || trading || publishing) {
      const marker = new T.Group();
      marker.name = publishing
        ? "publishing-scene-ready"
        : trading
          ? "trading-scene-ready"
          : "tech-scene-ready";
      marker.userData.assetStatus = "loading";
      this.world.add(marker);
      const loads: Promise<boolean>[] = [];
      this.world.traverse((node) => {
        if (node.userData.assetReady) loads.push(node.userData.assetReady);
      });
      marker.userData.assetReady = Promise.all(loads).then((results) => {
        if (this.disposed || marker.parent !== this.world) return false;
        // Shared finalizer deduplicates textures and keeps exact seat pick proxies.
        finalizeStudioScene(this.world);
        // New geometry is attached as assets arrive — give those trees too.
        buildBoundsTrees(this.world);
        if (this.meetingCamera.active) this.meetingWalls.enter(this.meetingWallObjects);
        marker.userData.assetStatus = results.every(Boolean) ? "ready" : "failed";
        return results.every(Boolean);
      });
      if (keepMeeting) this.meetingWalls.enter(this.meetingWallObjects);
      return;
    }
    if (studio) {
      // Batch only generic additions; the asynchronous studio owns its own resources.
      for (const group of this.world.children)
        if (group instanceof T.Group && group.name.startsWith("generic-object:"))
          batchStaticFurniture(group, true, { vertexColors: true, batchSeats: true });
      if (keepMeeting) this.meetingWalls.enter(this.meetingWallObjects);
      return;
    }
    detailSurfaces(
      this.world,
      [p.wood],
      [
        officeFinish(isOfficeEnvironmentId(map.environment) ? map.environment : undefined)
          .upholstery,
        "#7c9c80",
      ],
      ["#35434b", "#77838a"],
    );
    batchStaticFurniture(this.world, true, { vertexColors: true, batchSeats: true });
    batchCoplanarGlass(this.world);
    if (keepMeeting) this.meetingWalls.enter(this.meetingWallObjects);
  }
  private createLabel(actor: ActorSnapshot): RenderedActor {
    const color =
      actor.kind === "player"
        ? "#668d72"
        : ["#b98064", "#7c91ab", "#9b87a2", "#a59963"][
            Array.from(actor.id).reduce((n, c) => n + c.charCodeAt(0), 0) % 4
          ];
    // Colors come only from look definitions. Actors without a look use createActor's default palette.
    const look = resolveOfficeLook(actor.appearance);
    const model = createActor(actor.id, color, this.actors.size % 4, undefined, look);
    const label = document.createElement("button"),
      name = document.createElement("span"),
      bubble = document.createElement("span");
    label.className = "office-actor-label";
    name.className = "office-actor-name";
    bubble.className = "office-actor-bubble";
    label.type = "button";
    label.append(name);
    bubble.tabIndex = 0;
    label.dataset.kind = actor.kind;
    label.addEventListener("click", () => {
      this.boardArrival.cancel();
      this.selectedActorId = actor.id;
      const a = this.lastActors.find((a) => a.id === actor.id);
      if (a && a.kind !== "player") {
        const r = label.getBoundingClientRect();
        this.bridge?.pointer("down", a.x, a.y, 0, r.x, r.y, actor.id);
      }
    });
    label.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const a = this.lastActors.find((a) => a.id === actor.id);
      if (a) this.bridge?.pointer("down", a.x, a.y, 2, event.clientX, event.clientY, actor.id);
    });
    this.labels.append(label, bubble);
    this.scene.add(model.root);
    return {
      model,
      label,
      name,
      bubble,
      lookId: look?.id,
    };
  }
  private tick = (time: number) => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.tick);
    if (document.hidden) {
      this.priorFrame = 0;
      this.sampleStart = 0;
      this.sampleIntervals = [];
      return;
    }
    if (this.pendingMove) {
      const move = this.pendingMove;
      this.pendingMove = null;
      this.point(move, "move");
    }
    if (this.bridge) {
      if (time >= this.mapTimer) {
        const fingerprint = this.bridge.mapKey();
        if (fingerprint !== this.lastMap) {
          this.buildMap(this.bridge.map());
          // buildMap exits through different branches per map kind — call it here so it is set up whichever branch runs.
          buildBoundsTrees(this.world);
          this.lastMap = fingerprint;
        }
        this.mapTimer = time + 1500;
      }
      this.lastActors = this.bridge.actors();
      const ids = new Set(this.lastActors.map((a) => a.id));
      for (const [id, actor] of this.actors)
        if (!ids.has(id)) {
          this.scene.remove(actor.model.root);
          disposeTree(actor.model.root);
          actor.label.remove();
          actor.bubble.remove();
          this.actors.delete(id);
          this.speech.delete(id);
        }
      const player = this.lastActors.find((a) => a.kind === "player");
      if (player && this.selectedSeat) {
        const action = this.selectedSeat.action;
        const playerWorld = pixelToWorld(player.x, player.y);
        const selectedId = seatReservationId(action.x, action.z);
        if (
          !seatSelectionHighlighted(
            selectedId,
            this.bridge.seatIntent?.() ?? selectedId,
            Math.hypot(playerWorld.x - action.x, playerWorld.z - action.z),
            player.walking,
          )
        )
          this.setSelectedSeat(null);
      }
      if (
        !this.meetingCamera.active &&
        !this.meetingEntryWalking &&
        this.boardArrival.update(
          player ? { x: player.x / 32, y: player.y / 32, walking: player.walking } : undefined,
          time,
        )
      )
        this.onKanbanOpen();
      if (!this.meetingCamera.active && this.following && player) {
        const p = pixelToWorld(player.x, player.y),
          target = new T.Vector3(p.x, 0, p.z);
        const offset = target.sub(this.controls.target).multiplyScalar(0.08);
        this.controls.target.add(offset);
        this.camera.position.add(offset);
      }
      this.controls.update();
      this.meetingCamera.update(
        this.priorFrame ? Math.min(0.1, (time - this.priorFrame) / 1000) : 0,
        this.lastActors,
      );
      if (this.meetingCamera.active) this.publishMeetingDiagnostics();
      if (this.meetingSpace) {
        this.meetingWalls.update(this.camera.position, this.meetingOcclusionTargets());
      }
      const labelAnchors: ActorLabelAnchor[] = [];
      const viewportWidth = this.host.clientWidth;
      const viewportHeight = this.host.clientHeight;
      const speechWidth = bubbleWidthFor(viewportWidth);
      for (const actor of this.lastActors) {
        let rendered = this.actors.get(actor.id);
        if (rendered && rendered.lookId !== resolveOfficeLook(actor.appearance)?.id) {
          this.scene.remove(rendered.model.root);
          disposeTree(rendered.model.root);
          rendered.label.remove();
          rendered.bubble.remove();
          this.actors.delete(actor.id);
          rendered = undefined;
        }
        if (!rendered) {
          rendered = this.createLabel(actor);
          this.actors.set(actor.id, rendered);
        }
        const { model, label, name, bubble } = rendered,
          p = pixelToWorld(actor.x, actor.y);
        const seat = seatAt(this.seats, p.x, p.z, actor.walking);
        model.root.position.set(seat?.x ?? p.x, seat?.elevation ?? 0, seat?.z ?? p.z);
        const previous = rendered.previous;
        const fallbackYaw =
          { down: 0, up: Math.PI, left: -Math.PI / 2, right: Math.PI / 2 }[
            seat?.direction ?? actor.direction
          ] ?? 0;
        const dx = p.x - (previous?.x ?? p.x),
          dz = p.z - (previous?.z ?? p.z);
        if (seat || !previous || (!actor.walking && previous.direction !== actor.direction))
          rendered.yaw = fallbackYaw;
        else if (actor.walking && Math.hypot(dx, dz) > 0.0001 && Math.hypot(dx, dz) < 2)
          rendered.yaw = Math.atan2(dx, dz);
        model.rig.rotation.y =
          seat || !previous
            ? fallbackYaw
            : turnToward(
                model.rig.rotation.y,
                rendered.yaw ?? fallbackYaw,
                (time - previous.time) / 1000,
              );
        rendered.gait ??= createGaitTracker();
        const pace = rendered.gait.update(
          dx,
          dz,
          previous ? (time - previous.time) / 1000 : 0,
          actor.walking && !seat,
        );
        rendered.previous = { x: p.x, z: p.z, time, direction: actor.direction };
        model.update(time / 1000, actor.walking, actorPosePhase(actor), !!seat, undefined, pace);
        label.dataset.running = String(pace.running);
        label.dataset.assetStatus = model.root.userData.assetStatus ?? "procedural";
        label.dataset.modelStyle = model.root.userData.modelStyle ?? "legacy";
        label.dataset.officeLookId = rendered.lookId ?? "";
        label.dataset.seated = String(!!seat);
        if (process.env.NODE_ENV === "development") {
          label.dataset.worldX = p.x.toFixed(3);
          label.dataset.worldZ = p.z.toFixed(3);
          label.dataset.walking = String(actor.walking);
        }
        const phase = actorPresentationPhase(actor);
        label.dataset.phase = phase;
        // D08: the tag carries the leading state; an unknown one is dimmed via CSS.
        label.dataset.state = actor.states?.[0] ?? "";
        label.dataset.unknown = String(actorStateUnknown(actor));
        if (actor.stateLabel) bubble.title = actor.stateLabel;
        else bubble.removeAttribute("title");
        label.dataset.hovered = String(actor.id === this.hoveredActorId);
        if (actor.id === this.hoveredActorId || phase === "attention")
          model.ring.material.opacity = 0.65;
        name.textContent = actor.name;
        label.setAttribute("aria-label", actor.name);
        const message = actor.bubble || ((this.speech.get(actor.id) || 0) > time ? "···" : "");
        const kind = actorIndicator(actor);
        const indicator = INDICATOR_GLYPH[kind ?? "none"] + indicatorCountLabel(kind, actor);
        const text = [indicator, message].filter(Boolean).join(" ");
        const screen = new T.Vector3(seat?.x ?? p.x, 0, seat?.z ?? p.z).project(this.camera);
        if (
          isCreativeStudioMap(this.bridge.map()) &&
          (!rendered.labelOcclusion || time - rendered.labelOcclusion.time > 200)
        ) {
          rendered.labelOcclusion = {
            time,
            hidden: studioLabelOccluded(
              this.camera.position,
              new T.Vector3(seat?.x ?? p.x, seat ? 1.55 : 2.3, seat?.z ?? p.z),
              this.world,
            ),
          };
        }
        const visible =
          !(isCreativeStudioMap(this.bridge.map()) && rendered.labelOcclusion?.hidden) &&
          screen.z >= -1 &&
          screen.z <= 1 &&
          Math.abs(screen.x) <= 1 &&
          Math.abs(screen.y) <= 1;
        label.hidden = !visible;
        bubble.hidden = !visible || !text;
        bubble.dataset.active = String(!!actor.active);
        if (!visible) continue;
        // Measure only when content/viewport changes; layout itself is pure screen-space arithmetic.
        const measure = rendered.labelMeasure;
        if (
          !measure ||
          measure.name !== actor.name ||
          measure.text !== text ||
          measure.width !== speechWidth
        ) {
          // A previously docked/offscreen bubble may have a hidden parent while remeasuring.
          if (bubble.parentElement !== this.labels) this.labels.append(bubble);
          bubble.textContent = text ? `${actor.name} · ${text}` : "";
          bubble.style.width = `${speechWidth}px`;
          rendered.labelMeasure = {
            name: actor.name,
            text,
            width: speechWidth,
            nameWidth: name.offsetWidth || 90,
            bubbleHeight: text ? bubble.getBoundingClientRect().height : 0,
          };
        }
        const head = new T.Vector3(seat?.x ?? p.x, seat ? 2.0 : 2.7, seat?.z ?? p.z).project(
          this.camera,
        );
        labelAnchors.push({
          id: actor.id,
          x: ((screen.x + 1) * viewportWidth) / 2,
          feetY: ((1 - screen.y) * viewportHeight) / 2,
          headY: ((1 - head.y) * viewportHeight) / 2,
          nameWidth: rendered.labelMeasure!.nameWidth,
          nameHeight: 26,
          bubbleHeight: text ? rendered.labelMeasure!.bubbleHeight : undefined,
          priority:
            actor.id === this.hoveredActorId || actor.id === this.selectedActorId
              ? 110
              : actor.kind === "player"
                ? 100
                : phase === "streaming" || !!message
                  ? 80
                  : actor.active
                    ? 50
                    : 0,
        });
      }
      const layout = layoutActorLabels(labelAnchors, viewportWidth, viewportHeight);
      this.speechRail.hidden = !layout.rail;
      if (layout.rail) {
        const rect = layout.rail;
        this.speechRail.style.left = `${rect.x}px`;
        this.speechRail.style.top = `${rect.y}px`;
        this.speechRail.style.width = `${rect.width}px`;
        this.speechRail.style.maxHeight = `${rect.height}px`;
      }
      for (const anchor of labelAnchors) {
        const actor = this.actors.get(anchor.id)!;
        const placement = layout.placements.get(anchor.id)!;
        actor.label.hidden = !placement.name;
        if (placement.name) {
          actor.label.style.transform = `translate(${placement.name.x}px,${placement.name.y}px)`;
          actor.label.style.zIndex = String(anchor.priority + 1);
        }
        actor.bubble.hidden = !placement.bubble && !placement.docked;
        if (placement.bubble) {
          if (actor.bubble.parentElement !== this.labels) this.labels.append(actor.bubble);
          actor.bubble.style.transform = `translate(${placement.bubble.x}px,${placement.bubble.y}px)`;
          actor.bubble.style.zIndex = String(anchor.priority + 1);
        }
      }
      this.syncSeatBadges(viewportWidth, viewportHeight);
      // Stable priority order and speaker prefix retain readable text for every visible overflow speaker.
      for (const [index, id] of layout.overflow.entries()) {
        const bubble = this.actors.get(id)!.bubble;
        const current = this.speechRail.children[index];
        if (current !== bubble) this.speechRail.insertBefore(bubble, current ?? null);
        bubble.style.transform = "none";
      }
    }
    if (!document.hidden) {
      if (!this.sampleStart) this.sampleStart = time;
      if (this.priorFrame && time - this.priorFrame < 250)
        this.sampleIntervals.push(time - this.priorFrame);
      this.sampleFrames++;
      if (time - this.sampleStart >= 3000 && this.sampleIntervals.length > 30) {
        const sorted = this.sampleIntervals.sort((a, b) => a - b);
        const fps = Math.round((1000 * sorted.length) / sorted.reduce((a, b) => a + b, 0));
        const adaptation = adaptRenderScale(
          this.renderer.getPixelRatio(),
          this.slowSamples,
          fps,
          sorted[Math.floor(sorted.length * 0.95)],
        );
        this.slowSamples = adaptation.slowSamples;
        if (adaptation.scale !== this.renderer.getPixelRatio())
          this.renderer.setPixelRatio(adaptation.scale);
        if (this.statsLabel)
          this.statsLabel.textContent = `${fps} fps · ${this.renderer.getPixelRatio().toFixed(2)}× · p95 ${sorted[Math.floor(sorted.length * 0.95)].toFixed(1)} ms · ${this.renderer.info.render.calls} draws · ${Math.round(this.renderer.info.render.triangles / 1000)}k triangles`;
        this.sampleStart = time;
        this.sampleFrames = 0;
        this.sampleIntervals = [];
      }
      this.priorFrame = time;
    } else {
      this.slowSamples = 0;
      this.priorFrame = 0;
      this.sampleStart = 0;
      this.sampleIntervals = [];
    }
    this.renderer.render(this.scene, this.camera);
    if (this.benchmark) {
      const active = this.benchmark;
      const report = active.capture.frame(this.readMetrics(), !document.hidden);
      if (report) {
        this.benchmark = null;
        active.complete(report);
      }
    }
  };
  /** Desk seat number badges for seat change mode — kept in the same DOM overlay as the actor labels. */
  private syncSeatBadges(width: number, height: number) {
    const labels = this.bridge?.editor().seatLabels ?? [];
    const live = new Set(labels.map((l) => l.number));
    for (const [number, el] of this.seatBadges) {
      if (live.has(number)) continue;
      el.remove();
      this.seatBadges.delete(number);
    }
    for (const label of labels) {
      let el = this.seatBadges.get(label.number);
      if (!el) {
        el = document.createElement("div");
        el.className = "office-seat-badge";
        el.dataset.testid = `seat-badge-${label.number}`;
        el.textContent = String(label.number);
        this.labels.append(el);
        this.seatBadges.set(label.number, el);
      }
      el.dataset.taken = String(label.taken);
      const screen = new T.Vector3(label.col + 0.5, 1.1, label.row + 0.5).project(this.camera);
      const x = ((screen.x + 1) / 2) * width,
        y = ((1 - screen.y) / 2) * height;
      el.hidden = screen.z > 1;
      el.style.transform = `translate(${x}px,${y}px) translate(-50%,-50%)`;
    }
  }

  dispose() {
    this.exitMeeting();
    this.meetingCamera.dispose();
    this.onMeetingCameraChange = undefined;
    this.cancelBenchmark("Renderer disposed");
    document.removeEventListener("keydown", this.cancelBoardKey);
    this.boardArrival.cancel();
    this.furnitureHighlight.dispose();
    document.removeEventListener("visibilitychange", this.benchmarkVisibility);
    this.setHoveredSeat(null);
    this.setSelectedSeat(null);
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.bridge?.setPresentation(false);
    this.controls.dispose();
    this.controls.removeEventListener("start", this.cameraInteractionStart);
    this.controls.removeEventListener("end", this.cameraInteractionEnd);
    this.pendingMove = null;
    this.renderer.domElement.removeEventListener("pointerdown", this.pointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.pointerUp, true);
    this.renderer.domElement.removeEventListener("pointermove", this.pointerMove);
    this.renderer.domElement.removeEventListener("pointercancel", this.pointerCancel);
    this.renderer.domElement.removeEventListener("lostpointercapture", this.pointerCancel);
    this.renderer.domElement.removeEventListener("pointerleave", this.pointerLeave);
    this.renderer.domElement.removeEventListener("contextmenu", this.contextMenu);
    disposeTree(this.scene);
    this.environmentTarget.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.statsLabel?.remove();
    this.labels.replaceChildren();
    this.seatBadges.clear();
    this.actors.clear();
  }
}
