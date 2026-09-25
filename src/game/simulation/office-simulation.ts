/**
 * The office simulation without a screen.
 *
 * It advances the positions and states of the player, NPCs and remote players, talks to the page via the socket and the EventBus,
 * and sends the results to the renderer (three.js) through `OfficeBridge`. This module does not draw — there are no textures,
 * sprites or camera, and the only browser APIs are the rAF loop and keyboard listeners after `start()`.
 * Construction alone does not touch the DOM, so handlers can be checked directly in node.
 */
import type { Socket } from "socket.io-client";
import { isNpcCallRejected, npcCallErrorKey } from "../../lib/npc-call-errors";
import { EventBus, pendingChannelData, setPendingChannelData } from "../EventBus";
import {
  DEFAULT_NPC_MOTION,
  normalizeNpcMotionConfig,
  type NpcMotionConfig,
} from "../../lib/npc-motion-config";
import { effectiveMapSpawn } from "../../lib/effective-map-spawn";
import { RemoteNpcPresentation } from "../remote-npc-presentation";
import {
  copyMotionContinuation,
  playerMotionGoal,
  type PlayerSpawnState,
  type PlayerMotionGoal,
} from "../runtime-hydration";
import { SpeechPreviews } from "../speech-previews";
import {
  MotionSnapshotCache,
  restoreOnSnapshot,
  untouchedSpawn,
  adoptNpcMotionHome,
  type MotionNpc,
  type MotionSnapshot,
} from "../motion-snapshot";
import { NpcMovementOwnership, publishNpcArrival } from "../npc-movement-ownership";
import { findPath, clearMovementSegment, type NavigationPoint } from "../navigation";
import { TrafficCoordinator, clearActors, findTrafficPath, type TrafficActor } from "../traffic";
import { peerMovementUncertainty, type PeerMotionSample } from "../peer-motion-envelope";
import {
  ambientTileAllowed,
  destinationTileAllowed,
  findTaggedDestinationPath,
  taggedPathTileAllowed,
  AmbientExitPolicy,
  type AmbientZone,
} from "../ambient-zones";
import { isSeatAnchor, isDeskSeatAnchor, deskSeatLabels, commonAreaSeats } from "../three/seating";
import { resolveSeatIntent, seatReservationId } from "../three/seat-action";
import {
  AmbientDepartures,
  ambientAllowed,
  ambientDestinations,
  createAmbientSchedule,
  advanceAmbientSchedule,
  randomDuration,
  restAtAmbientSeat,
} from "../npc-ambient";
import { NpcSmalltalk } from "../npc-smalltalk";
import { createEventScope } from "../three/event-scope";
import {
  matchesNpcTarget,
  type OfficeBridge,
  type ActorSnapshot,
  type EditorSnapshot,
} from "../three/bridge";
import { fetchChannelNpcs } from "../npc-prefetch";
import { shouldAutoReturn, shouldReturnOnRoomChange } from "../npc-auto-return";
import { decideNpcClick, shouldRememberTarget } from "../npc-click-intent";
import { decideNpcUpdate, type NpcUpdatedPayload } from "../npc-updated-dispatch";
import { createRejoinTracker, registerOnce, shouldRejoinForError } from "../socket-rejoin";
import { type MapObject } from "../../lib/object-types";
import { normalizeMeetingMap } from "../meeting-map-normalization";
import { insideMeetingSpace, type MeetingSpace } from "../meeting-space";
import { NpcController, type NpcData, type NpcPathfinder } from "./npc-controller";
import { RemotePlayer, type RemotePlayerData } from "./remote-player";
import { TickLoop } from "./tick-loop";
import { Scheduler } from "./scheduler";
import { loadLegacyRuntime, loadTiledRuntime, occupiedTiles, type MapRuntime } from "./map-runtime";
import {
  COLLISION_TILES,
  MAP_COLS,
  MAP_ROWS,
  MOVE_SEND_INTERVAL,
  NPC_INTERACT_RADIUS,
  PLAYER_SPEED,
  TILE_EMPTY,
  TILE_SIZE,
} from "./constants";
import {
  DIR_DOWN,
  DIR_LEFT,
  DIR_RIGHT,
  DIR_UP,
  directionFromName,
  directionName,
} from "./directions";

type PlayerBody = { x: number; y: number };

/** Do not intercept game keys when an input box or editable element has focus. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el.isContentEditable;
}

/** Keys the old game loop intercepted in the browser. Arrows (scrolling) and slash (Firefox quick find). */
const CAPTURED_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "]);

type PendingNpcCall = {
  npcId: string;
  message?: string;
  bubbleText?: string;
  npcName?: string;
  reason?: string;
  roomId?: string;
};

/** The distance (px) allowed per position report — how far the old 150px/s walk went in 200ms. */
const NPC_SYNC_CHORD_PX = 30;
const NPC_SYNC_MAX_INTERVAL_MS = 200;
/** Never send more often than 20 times per second — even at top speed (480px/s) it is 62ms, so this is not reached. */
const NPC_SYNC_MIN_INTERVAL_MS = 50;

export class OfficeSimulation {
  // ---------------------------------------------------------------------------
  // Lifetime · clock
  // ---------------------------------------------------------------------------
  private disposed = false;
  private paused = false;
  private booted = false;
  /** The rAF time (ms). Socket handlers also see the last tick's value — same as the old scene clock. */
  private now = 0;
  private delta = 0;
  private loop = new TickLoop((now, delta) => this.step(now, delta));
  private scheduler = new Scheduler();
  private eventScope = createEventScope();
  private keysDown = new Set<string>();
  private justPressed = new Set<string>();

  // ---------------------------------------------------------------------------
  // Meetings
  // ---------------------------------------------------------------------------
  private meetingMode = false;
  private meetingEntryPending = false;
  private meetingEntryStartedAt = 0;
  private meetingEntryPath: NavigationPoint[] | null = null;
  private meetingSeatTarget: string | null = null;
  private spatialNpcRoutes = new Map<string, { generation: number; done: boolean }>();

  // ---------------------------------------------------------------------------
  // Movement coordination · snapshots
  // ---------------------------------------------------------------------------
  private presentationActorId: string | undefined;
  private ambientDepartures = new AmbientDepartures();
  private traffic = new TrafficCoordinator();
  private npcOwnership = new NpcMovementOwnership();
  private connectedPlayerIds = new Set<string>();
  private peerPositions = new Map<
    string,
    { x: number; y: number; direction: string; animation: string }
  >();
  private motionSnapshot = new MotionSnapshotCache();
  private spawnRequest: { x: number; y: number } | null = null;
  private spawnInputStarted = false;
  private pendingSeatClaims = new Set<string>();
  private playerSeatGoal: string | null = null;
  private playerSpawnReady = false;
  private pendingPlayerResume: PlayerMotionGoal | null = null;
  private resumingPlayerGoal: PlayerMotionGoal | null = null;
  private lastSentMotion = "";
  private npcContinuationTimer = 0;
  private motionGeneration = 0;
  private peerSnapshotReady = false;
  private socketListenerCleanup: (() => void) | null = null;
  private pendingNpcCalls = new Map<string, PendingNpcCall>();
  private speechPreviews = new SpeechPreviews();
  private smalltalk: NpcSmalltalk;
  private responsePhases: Record<string, "queued" | "thinking" | "streaming"> = {};
  /** NPCs running cards or cron jobs (R27). Replaced wholesale by `npc:working-state`. */
  private workingNpcs = new Set<string>();
  /** npcId → number of items in progress. One employee can run several, so the count is received too. */
  private workingCounts: Record<string, number> = {};

  // ---------------------------------------------------------------------------
  // Player
  // ---------------------------------------------------------------------------
  private player: PlayerBody | null = null;
  private currentDirection: number = DIR_DOWN;
  private playerReady = false;
  private playerActuallyWalking = false;

  // ---------------------------------------------------------------------------
  // Multiplayer
  // ---------------------------------------------------------------------------
  private socket: Socket | null = null;
  private rejoin = createRejoinTracker();
  private joinedSocketId: string | undefined = undefined;
  private localPlayerIdentity: { socketId: string; userId: string } | undefined;
  private remotePlayers = new Map<string, RemotePlayer>();
  private peerMotionSamples = new Map<string, PeerMotionSample>();
  private lastMoveSent = 0;
  private lastSentX = 0;
  private lastSentY = 0;
  private lastSentDir = "";
  private lastSentAnim = "";
  private characterId = "";
  private characterName = "";
  private appearance: unknown = null;

  // ---------------------------------------------------------------------------
  // NPC
  // ---------------------------------------------------------------------------
  private npcs: NpcController[] = [];
  private npcTilePositions: Set<string> = new Set(); // "col,row" — for spawn collision checks
  private npcPositionSyncTimer = 0;
  private nearbyNpcs: NpcController[] = [];
  private nearbyPlayers: { id: string; name: string }[] = [];
  private dialogOpen = false;
  /** Which room's conversation is visible — GamePageClient reports it via room:visible. null means no room is visible. */
  private visibleRoomId: string | null = null;
  private lastToastMessage: string | null = null;
  private lastChatInputEnabled: boolean | null = null;
  private greetedNpcs: Set<string> = new Set();
  /** NPC speech bubbles. Without text it means "has something to say" (three dots). */
  private npcBubbles: Map<string, { text?: string }> = new Map();
  /** Bubbles shown as activity indicators. Counted separately to tell them apart from "has something to say" bubbles. */
  private activityBubbles: Set<string> = new Set();

  // ---------------------------------------------------------------------------
  // Path following
  // ---------------------------------------------------------------------------
  private currentPath: NavigationPoint[] | null = null;
  private pathIndex = 0;
  private targetNpcId: string | null = null;
  private pathStuckTimer = 0;
  private pathLastDist = Infinity;

  // ---------------------------------------------------------------------------
  // Map
  // ---------------------------------------------------------------------------
  private floorData: number[][] = [];
  private wallsData: number[][] = [];
  private collisionData: number[][] = [];
  private effectiveMapCols: number = MAP_COLS;
  private effectiveMapRows: number = MAP_ROWS;
  private mapObjects: MapObject[] = [];
  private collisionCells = new Set<string>();
  private objectOccupiedTiles = new Set<string>();
  private mapRevision?: string;
  private channelId = "";
  private meetingSpace: MeetingSpace | undefined;
  /**
   * The channel's NPC walking speed. A shared channel setting — when this browser drives NPCs they walk at this value,
   * and others follow the broadcast positions, so everyone sees the same speed.
   */
  private motion: NpcMotionConfig = DEFAULT_NPC_MOTION;
  private tiledMode = false;
  private officeEnvironment: string | undefined;
  private officeEnvironmentVersion: number | undefined;
  private ambientZones: AmbientZone[] = [];
  private tiledSpawnCol: number | null = null;
  private tiledSpawnRow: number | null = null;
  private savedPosition: { x: number; y: number } | null = null;
  private mapConfigSpawnCol: number | null = null;
  private mapConfigSpawnRow: number | null = null;

  // ---------------------------------------------------------------------------
  // Placement · start position selection
  // ---------------------------------------------------------------------------
  private placementMode = false;
  /** Cache of number labels for seat change mode — cleared on entering the mode and when NPCs are added/removed. */
  private seatLabelCache: EditorSnapshot["seatLabels"] | null = null;
  private placementNpcId: string | null = null;
  private isChannelOwner = false;
  private spawnSetMode = false;

  // ---------------------------------------------------------------------------
  // Diagnostics (for development)
  // ---------------------------------------------------------------------------
  private returnDiagnosticAt = 0;
  private returnDiagnosticNode: HTMLOutputElement | null = null;

  // ===========================================================================
  // Lifetime
  // ===========================================================================

  /**
   * The browser entry point. Consumes the channel data the page handed over via `setPendingChannelData` to build the map,
   * emits `scene-ready`, `three:bridge-ready` and `request-socket`, then runs the tick loop.
   * If channel data is not there yet, it waits for `channel-data-ready` and follows the same steps.
   */
  /** `locale` is the viewer's language — it only picks the local smalltalk lines, nothing leaves the browser. */
  constructor(options: { locale?: string | null } = {}) {
    this.smalltalk = new NpcSmalltalk(options.locale);
  }

  /** Switches the smalltalk language; the exchange on screen finishes in the old language. */
  setDisplayLocale(locale: string | null | undefined): void {
    this.smalltalk.setLocale(locale);
  }

  start(): void {
    if (this.disposed) return;
    const data = pendingChannelData;
    const source = data?.tiledJson ?? data?.mapData;
    if (!data || !source) {
      // The old scene's "Loading channel map..." waiting state. When data arrives, build again from scratch.
      const handleChannelDataReady = () => {
        EventBus.off("channel-data-ready", handleChannelDataReady);
        if (!this.disposed) this.start();
      };
      this.eventScope.on("channel-data-ready", handleChannelDataReady);
      return;
    }
    this.boot(data);
    this.loop.start();
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    window.addEventListener("blur", this.handleWindowBlur);
    this.eventScope.addCleanup(() => {
      window.removeEventListener("keydown", this.handleKeyDown);
      window.removeEventListener("keyup", this.handleKeyUp);
      window.removeEventListener("blur", this.handleWindowBlur);
    });
    // The socket may already have been ready, so request again.
    EventBus.emit("request-socket");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loop.stop();
    this.scheduler.clear();
    // Remove only the listeners this simulation attached — the page's EventBus listeners stay.
    this.eventScope.dispose();
    EventBus.off("socket-rejoin", this.handleSocketRejoin);
    this.socketListenerCleanup = null;
    this.returnDiagnosticNode?.remove();
    this.returnDiagnosticNode = null;
  }

  /** Simulation state consumed by the renderer. */
  readonly officeBridge: OfficeBridge = {
    actors: () => this.actors(),
    mapKey: () =>
      JSON.stringify([
        this.effectiveMapCols,
        this.effectiveMapRows,
        this.floorData,
        this.wallsData,
        this.mapObjects,
        this.tiledMode,
        this.officeEnvironment,
      ]),
    map: () => {
      const blocked: string[] = [];
      for (let row = 0; row < this.effectiveMapRows; row++)
        for (let col = 0; col < this.effectiveMapCols; col++) {
          if (!this.isWalkable(col, row)) blocked.push(`${col},${row}`);
        }
      return {
        meetingSpace: this.meetingSpace,
        cols: this.effectiveMapCols,
        rows: this.effectiveMapRows,
        floor: this.floorData,
        walls: this.wallsData,
        blocked,
        objects: this.mapObjects,
        tiled: this.tiledMode,
        environment: this.officeEnvironment,
        environmentVersion: this.officeEnvironmentVersion,
      };
    },
    editor: () => ({
      placement: this.placementMode,
      spawn: this.spawnSetMode,
      owner: this.isChannelOwner,
      tiled: this.tiledMode,
      seatLabels: this.placementMode
        ? (this.seatLabelCache ??= deskSeatLabels(
            this.mapObjects,
            (col, row) => this.isWalkable(col, row),
            (col, row) =>
              this.npcs.some(
                (n) => n.id !== this.placementNpcId && n.homeCol === col && n.homeRow === row,
              ),
          ))
        : [],
    }),
    pointer: (kind, x, y, button, screenX, screenY, actorId) => {
      this.presentationActorId = actorId;
      if (kind === "down") this.handlePointerDown(x, y, button, screenX, screenY);
      this.presentationActorId = undefined;
    },
    walkable: (col, row) => this.isWalkable(col, row) && !this.isTileOccupied(col, row),
    seatAvailable: (x, z) => {
      const col = Math.floor(x),
        row = Math.floor(z);
      if (!this.isWalkable(col, row) || this.isTileOccupied(col, row)) return false;
      const seatId = seatReservationId(col + 0.5, row + 0.5);
      return !this.motionSnapshot.current?.seats.some((seat) => seat.seatId === seatId);
    },
    seatIntent: () => {
      const goal = this.currentPath?.[this.currentPath.length - 1];
      return resolveSeatIntent(
        goal ? { x: goal.x, y: goal.y, seat: isSeatAnchor(this.mapObjects, goal.x, goal.y) } : null,
        this.playerSeatGoal,
      );
    },
    // There is nothing to draw, so attach and detach notices are ignored.
    setPresentation: () => {},
  };

  private actors(): ActorSnapshot[] {
    const actors: ActorSnapshot[] = this.npcs.map((npc) => {
      const bubble = this.npcBubbles.get(npc.id);
      return {
        id: npc.id,
        name: npc.name,
        kind: "npc",
        x: npc.viewX,
        y: npc.viewY,
        direction: directionName(npc.direction),
        walking:
          !npc.ambientPaused &&
          (this.mayDriveNpc(npc)
            ? npc.actuallyWalking
            : (npc.remotePresentation?.walking ?? npc.remoteWalkingUntil > this.now)),
        appearance: npc.appearance,
        bubble:
          this.speechPreviews.get(npc.id, this.now) ||
          (bubble
            ? bubble.text || "···"
            : !this.responsePhases[npc.id] &&
                !this.activityBubbles.has(npc.id) &&
                !npc.calledForRoom &&
                !this.dialogOpen
              ? this.smalltalk.text(npc.id, this.now)
              : undefined),
        active: this.activityBubbles.has(npc.id),
        phase: this.responsePhases[npc.id],
        working: this.workingNpcs.has(npc.id),
        workingCount: this.workingCounts[npc.id] ?? 0,
      };
    });
    if (this.playerReady && this.player)
      actors.push({
        id: this.socket?.id || this.characterId || "local",
        userId:
          this.localPlayerIdentity?.socketId === this.socket?.id
            ? this.localPlayerIdentity?.userId
            : undefined,
        name: this.characterName,
        kind: "player",
        x: this.player.x,
        y: this.player.y,
        direction: directionName(this.currentDirection),
        walking: this.playerActuallyWalking,
        appearance: this.appearance,
        bubble: this.speechPreviews.get(this.socket?.id || this.characterId || "local", this.now),
      });
    for (const [id, remote] of this.remotePlayers)
      actors.push({
        id,
        userId: remote.userId,
        name: remote.name,
        kind: "remote",
        x: remote.x,
        y: remote.y,
        direction: remote.direction,
        walking: remote.animation !== "idle",
        appearance: remote.appearance,
        bubble: this.speechPreviews.get(remote.userId || id, this.now),
      });
    return actors;
  }

  // ===========================================================================
  // Boot — the old scene's create()
  // ===========================================================================

  private boot(data: NonNullable<typeof pendingChannelData>): void {
    this.booted = true;
    this.setMotionConfig(data.motionConfig);
    // When the owner changes it in channel settings it arrives via `channel:updated` — applied right away without reloading.
    this.eventScope.on("channel:motion-config", (config: unknown) => this.setMotionConfig(config));
    this.eventScope.on("meeting:request-entry", () => this.requestMeetingEntry());
    this.eventScope.on("meeting:cancel-entry", () => this.cancelMeetingEntry());
    this.eventScope.on("meeting:mode", (payload: { active: boolean }) =>
      this.setMeetingMode(payload.active),
    );
    this.meetingSpace = undefined;
    this.officeEnvironment = undefined;
    this.officeEnvironmentVersion = undefined;
    this.ambientZones = [];
    this.traffic.clear();
    this.joinedSocketId = undefined;
    this.npcOwnership.clear();
    this.motionSnapshot.clear();
    this.peerPositions.clear();
    this.peerMotionSamples.clear();
    this.pendingNpcCalls.clear();
    this.motionGeneration++;
    this.connectedPlayerIds.clear();

    let tiledJsonData: Record<string, unknown> | null = null;
    let legacyMapData: unknown = null;
    this.channelId = data.channelId;
    this.mapRevision = data.mapRevision;

    const source = data.tiledJson ?? data.mapData;
    if (source) {
      const normalized = normalizeMeetingMap(source, data.mapConfig);
      this.meetingSpace = normalized.meetingSpace;
      if (data.tiledJson) data.tiledJson = normalized.mapData;
      else data.mapData = normalized.mapData;
    }

    if (data.tiledJson) {
      tiledJsonData = data.tiledJson as Record<string, unknown>;
    } else if (data.mapData) {
      // mapData itself may be Tiled JSON (tiledversion field).
      const mapData = data.mapData as Record<string, unknown>;
      if ("tiledversion" in mapData) tiledJsonData = mapData;
      else legacyMapData = mapData;
    }

    if (data.mapConfig) {
      const config = data.mapConfig as Record<string, unknown>;
      if (typeof config.spawnCol === "number") {
        this.tiledSpawnCol = config.spawnCol;
        this.mapConfigSpawnCol = config.spawnCol;
      }
      if (typeof config.spawnRow === "number") {
        this.tiledSpawnRow = config.spawnRow;
        this.mapConfigSpawnRow = config.spawnRow;
      }
    }

    const effectiveSpawn = effectiveMapSpawn(tiledJsonData, data.mapConfig);
    if (effectiveSpawn) {
      this.tiledSpawnCol = this.mapConfigSpawnCol = effectiveSpawn.col;
      this.tiledSpawnRow = this.mapConfigSpawnRow = effectiveSpawn.row;
    }

    if (data.savedPosition) this.savedPosition = data.savedPosition;

    setPendingChannelData(null); // consumed

    this.applyMapRuntime(
      tiledJsonData ? loadTiledRuntime(tiledJsonData) : loadLegacyRuntime(legacyMapData),
    );

    // dialog
    this.eventScope.on("dialog:open", () => {
      this.dialogOpen = true;
    });
    this.eventScope.on("dialog:close", () => {
      this.dialogOpen = false;
    });
    // When the visible room changes, called NPCs not for that room go to their seats right away without a timer.
    this.eventScope.on("room:visible", (payload: { roomId: string | null }) => {
      this.visibleRoomId = payload.roomId;
      for (const npc of this.npcs) {
        if (!shouldReturnOnRoomChange(npc, payload.roomId)) continue;
        this.sendNpcHome(npc);
      }
    });

    // placement mode
    this.eventScope.on("placement-mode-start", (npc: { id: string }) => {
      this.placementNpcId = npc.id;
      this.placementMode = true;
      this.seatLabelCache = null;
    });
    this.eventScope.on("placement-mode-end", () => {
      this.placementMode = false;
      this.placementNpcId = null;
    });

    // start position selection mode
    this.eventScope.on("map-refresh-start", () => {
      this.paused = true;
    });
    this.eventScope.on("spawn-set-mode-start", () => {
      this.spawnSetMode = true;
    });
    this.eventScope.on("spawn-set-mode-end", () => {
      this.spawnSetMode = false;
    });
    this.eventScope.on("owner-status", (payload: { isOwner: boolean }) => {
      this.isChannelOwner = payload.isOwner;
    });

    // local NPC add/remove (own hiring/firing)
    this.eventScope.on(
      "npc:spawn-local",
      (raw: {
        id: string;
        name: string;
        positionX: number;
        positionY: number;
        direction?: string;
        appearance?: unknown;
      }) => {
        const npcData: NpcData = { ...raw, direction: raw.direction || "down" };
        this.addNpc(npcData);
      },
    );
    this.eventScope.on("npc:remove-local", (payload: { npcId: string }) => {
      this.removeNpcById(payload.npcId);
    });
    this.eventScope.on(
      "npc:update-local",
      (payload: { npcId: string; name?: string; direction?: string; appearance?: unknown }) => {
        const npc = this.npcs.find((n) => n.id === payload.npcId);
        if (!npc) return;
        npc.updateFromData(payload);
      },
    );

    this.eventScope.on("npc:movement-owner", (payload: { npcId: string; ownerId: string }) => {
      this.takeNpcOwnership(payload.npcId, payload.ownerId);
    });

    this.eventScope.on(
      "npc:start-move",
      (payload: {
        npcId: string;
        targetCol: number;
        targetRow: number;
        destinationTag?: string;
        message?: string;
      }) => {
        const npc = this.npcs.find((n) => n.id === payload.npcId);
        if (!npc || !this.ensureLocalNpcOwnership(npc) || npc.moveState !== "idle") return;
        const destinationTag =
          typeof payload.destinationTag === "string" && payload.destinationTag.length > 0
            ? payload.destinationTag
            : undefined;
        if (
          !destinationTag &&
          this.ambientZones.some((zone) => zone.access !== undefined) &&
          !destinationTileAllowed(this.ambientZones, payload.targetCol, payload.targetRow)
        )
          return;
        this.npcTilePositions.delete(`${npc.homeCol},${npc.homeRow}`);
        const origin = {
          x: Math.floor(npc.pixelX / TILE_SIZE),
          y: Math.floor(npc.pixelY / TILE_SIZE),
        };
        const started = npc.moveTo(
          payload.targetCol,
          payload.targetRow,
          destinationTag ? this.npcPathfinder(npc, destinationTag, origin) : findPath,
          this.createNpcWalkValidator(),
          payload.message || destinationTag
            ? { message: payload.message, destinationTag }
            : undefined,
        );
        if (!started) this.npcTilePositions.add(`${npc.homeCol},${npc.homeRow}`);
      },
    );

    this.eventScope.on("npc:call-to-player", (payload: PendingNpcCall) =>
      this.handleNpcCallToPlayer(payload),
    );

    // The NPC's response finished — if far from the player, walk over and deliver it
    this.eventScope.on("npc:deliver-response", (payload: { npcId: string; npcName: string }) => {
      if (!this.player) return;
      const npc = this.npcs.find((n) => n.id === payload.npcId);
      if (!npc) return;

      const dist = npc.distanceTo(this.player.x, this.player.y);
      if (dist < TILE_SIZE + 4) {
        // Already close — bubble only
        EventBus.emit("npc:bubble", { npcId: npc.id });
        return;
      }

      // Far — go to the player (only while resting)
      if (!this.ensureLocalNpcOwnership(npc) || npc.moveState !== "idle") return;
      this.npcTilePositions.delete(`${npc.homeCol},${npc.homeRow}`);
      const playerCol = Math.floor(this.player.x / TILE_SIZE);
      const playerRow = Math.floor(this.player.y / TILE_SIZE);
      npc.moveTo(playerCol, playerRow, findPath, this.createNpcWalkValidator(), {
        message: `${payload.npcName} wants to talk`,
      });
    });

    this.eventScope.on("npc:start-return", (payload: { npcId: string }) => {
      if (!this.npcOwnership.startReturn(payload.npcId)) return;
      const npc = this.npcs.find((n) => n.id === payload.npcId);
      if (!npc || !this.mayDriveNpc(npc) || npc.moveState === "returning") return;
      npc.returnToHome(this.npcPathfinder(npc), this.createNpcWalkValidator());
      if (npc.moveState === "idle") this.finishNpcReturn(npc, true);
    });

    this.eventScope.on(
      "npc:approach-and-interact",
      (payload: { npcId: string; npcName?: string }) => {
        this.approachNpcAndInteract(payload.npcId, payload.npcName);
      },
    );

    // Receive NPC positions first to line up spawn collision checks, then place the player.
    void this.prefetchNpcPositions().then((npcs) => {
      if (this.disposed) return;
      this.loadNpcs(npcs);
      this.createPlayer();
    });

    // The socket React provides — can come either before or after the player spawns
    this.eventScope.on(
      "socket-ready",
      (payload: {
        socket: Socket;
        characterId: string;
        characterName: string;
        appearance: unknown;
      }) => {
        this.socket = payload.socket;
        this.characterId = payload.characterId;
        this.characterName = payload.characterName;
        this.appearance = payload.appearance;
        this.setupSocketListeners();

        if (this.playerReady && this.player) {
          this.joinMultiplayer(this.player.x, this.player.y);
        }
      },
    );

    this.responsePhases = {};
    this.eventScope.on(
      "npc:response-phases",
      (payload: { phases: Record<string, "queued" | "thinking" | "streaming"> }) => {
        this.responsePhases = payload.phases;
      },
    );
    // Working indicator (R27) — GamePageClient folds the socket's `npc:working` into an id list + counts.
    this.workingNpcs = new Set();
    this.workingCounts = {};
    this.eventScope.on(
      "npc:working-state",
      (payload: { npcIds: string[]; counts?: Record<string, number> }) => {
        const previous = this.workingNpcs;
        this.workingNpcs = new Set(payload.npcIds);
        this.workingCounts = payload.counts ?? {};
        for (const npcId of this.workingNpcs) {
          if (!previous.has(npcId)) this.seatNpcForWork(npcId);
        }
      },
    );
    // Conversation previews are independent of activity and greeting lifetimes.
    this.eventScope.on("chat:speech", (payload: { actorId: string; text: string }) => {
      this.speechPreviews.set(payload.actorId, payload.text, this.now);
    });
    // Speech bubbles. Remote players' `chat:bubble` is drawn by the renderer directly.
    this.eventScope.on(
      "npc:bubble",
      (payload: { npcId: string; text?: string; durationMs?: number }) => {
        this.showNpcBubbleIcon(payload.npcId, payload.text, payload.durationMs);
      },
    );
    this.eventScope.on("npc:bubble-clear", (payload: { npcId: string }) => {
      this.clearNpcBubble(payload.npcId);
      this.activityBubbles.delete(payload.npcId);
    });
    // Working indicator. It shares the spot with the "has something to say" (three dots) bubble but means something different,
    // so only the ones shown as activity are remembered separately and only those are cleared when the activity ends —
    // otherwise bubbles the NPC showed because it really has something to say would vanish too.
    this.eventScope.on("npc:activity-bubble", (payload: { npcId: string; text?: string }) => {
      if (payload.text) {
        this.activityBubbles.add(payload.npcId);
        this.showNpcBubbleIcon(payload.npcId, payload.text);
        return;
      }
      if (this.activityBubbles.delete(payload.npcId)) {
        this.clearNpcBubble(payload.npcId);
      }
    });

    // React asks for the position so it can save it on leave
    // The meeting screen tells the opener, before starting, when more participants are picked than the room has spots.
    this.eventScope.on("meeting:capacity-request", () => {
      if (this.meetingSpace)
        EventBus.emit("meeting:capacity", {
          seats: this.meetingSpace.seatIds.length,
          standing: this.meetingSpace.standingPositions.length,
        });
    });

    this.eventScope.on("request-player-position", () => {
      if (this.player) {
        EventBus.emit("player-position-response", { x: this.player.x, y: this.player.y });
      }
    });

    // Tell React we are ready
    EventBus.emit("scene-ready");
    EventBus.emit("three:bridge-ready", this.officeBridge);
  }

  private applyMapRuntime(runtime: MapRuntime): void {
    this.tiledMode = runtime.tiled;
    this.officeEnvironment = runtime.environment;
    this.officeEnvironmentVersion = runtime.environmentVersion;
    this.ambientZones = runtime.ambientZones;
    this.effectiveMapCols = runtime.cols;
    this.effectiveMapRows = runtime.rows;
    this.floorData = runtime.floor;
    this.wallsData = runtime.walls;
    this.collisionData = runtime.collision;
    this.mapObjects = runtime.objects;
    this.collisionCells = runtime.collisionCells;
    // The Objects layer's spawn is used only when mapConfig did not decide one
    if (this.mapConfigSpawnCol === null && runtime.tiledSpawn.col !== null)
      this.tiledSpawnCol = runtime.tiledSpawn.col;
    if (this.mapConfigSpawnRow === null && runtime.tiledSpawn.row !== null)
      this.tiledSpawnRow = runtime.tiledSpawn.row;
    this.refreshObjectOccupancy();
  }

  /** When the object list changes, rebuild occupied tiles (the decision part of the old renderObjects). */
  private refreshObjectOccupancy(): void {
    this.objectOccupiedTiles = occupiedTiles({
      objects: this.mapObjects,
      collisionCells: this.collisionCells,
    });
  }

  // ===========================================================================
  // Walkability · paths
  // ===========================================================================

  private isWalkable(tileX: number, tileY: number): boolean {
    if (tileX < 0 || tileX >= this.effectiveMapCols || tileY < 0 || tileY >= this.effectiveMapRows)
      return false;
    // the Tiled map's collision layer
    if (this.collisionData.length > 0) {
      const collisionGid = this.collisionData[tileY]?.[tileX] ?? 0;
      if (collisionGid !== 0) return false;
    }
    // legacy walls
    if (this.wallsData.length > 0 && this.collisionData.length === 0) {
      const wallTile = this.wallsData[tileY]?.[tileX] ?? TILE_EMPTY;
      if (COLLISION_TILES.has(wallTile)) return false;
    }
    // object-occupied tiles
    if (this.objectOccupiedTiles.has(`${tileX},${tileY}`)) return false;
    return true;
  }

  private trafficActors(): TrafficActor[] {
    const point = (x: number, y: number) => ({ x: x / TILE_SIZE - 0.5, y: y / TILE_SIZE - 0.5 });
    return [
      ...this.npcs.map((npc) => ({ id: npc.id, ...point(npc.pixelX, npc.pixelY) })),
      ...[...this.peerPositions].map(([id, remote]) => ({
        id: `player:${id}`,
        player: true,
        ...point(remote.x, remote.y),
        movementUncertainty: peerMovementUncertainty(
          this.peerMotionSamples.get(id) ?? {
            receivedAt: performance.now(),
            moving: remote.animation === "walk",
          },
          performance.now(),
          this.delta,
        ),
      })),
      ...(this.player
        ? [{ id: "player:local", player: true, ...point(this.player.x, this.player.y) }]
        : []),
    ];
  }

  private findPlayerPath(sx: number, sy: number, ex: number, ey: number) {
    const actors = this.trafficActors().filter((actor) => actor.id !== "player:local");
    const walkable = (x: number, y: number) => this.isWalkable(x, y);
    return (
      findPath(sx, sy, ex, ey, walkable, (a, b) => clearActors(a, b, actors)) ??
      findPath(sx, sy, ex, ey, walkable)
    );
  }

  private npcPathfinder(
    npc: NpcController,
    destinationTag = npc.destinationTag ?? undefined,
    purposeAccessOrigin = npc.purposeAccessOrigin ?? undefined,
  ): NpcPathfinder {
    return (sx, sy, ex, ey, walkable) => {
      const actors = this.trafficActors().filter((actor) => actor.id !== npc.id);
      if (destinationTag)
        return findTaggedDestinationPath(
          this.ambientZones,
          destinationTag,
          { x: sx, y: sy },
          { x: ex, y: ey },
          walkable,
          (from, to) => clearActors(from, to, actors),
          purposeAccessOrigin ?? { x: sx, y: sy },
        );
      return findTrafficPath(sx, sy, ex, ey, walkable, actors);
    };
  }

  private createNpcWalkValidator(): (tx: number, ty: number) => boolean {
    // Coarse paths see only static terrain; passing actors are handled by traffic coordination with swept disks.
    return (tx, ty) => this.isWalkable(tx, ty);
  }

  private findNearestWalkableTile(tileX: number, tileY: number): { x: number; y: number } | null {
    for (let radius = 1; radius < Math.max(MAP_COLS, MAP_ROWS); radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
          const nx = tileX + dx;
          const ny = tileY + dy;
          if (this.isWalkable(nx, ny) && !this.isTileOccupied(nx, ny)) return { x: nx, y: ny };
        }
      }
    }
    return null;
  }

  /** Whether an NPC, a remote player or a pre-received NPC seat is on that tile */
  private isTileOccupied(col: number, row: number): boolean {
    // Pre-received NPC seats are known even before controllers exist
    if (this.npcTilePositions.has(`${col},${row}`)) return true;

    return !clearActors(
      { x: col, y: row },
      { x: col, y: row },
      this.trafficActors().filter((actor) => actor.id !== "player:local"),
    );
  }

  /** An empty spawn position near the desired tile */
  private findFreeSpawn(preferCol: number, preferRow: number): { col: number; row: number } {
    if (this.isWalkable(preferCol, preferRow) && !this.isTileOccupied(preferCol, preferRow)) {
      return { col: preferCol, row: preferRow };
    }
    for (let radius = 1; radius < Math.max(MAP_COLS, MAP_ROWS); radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
          const c = preferCol + dx;
          const r = preferRow + dy;
          if (this.isWalkable(c, r) && !this.isTileOccupied(c, r)) {
            return { col: c, row: r };
          }
        }
      }
    }
    return { col: preferCol, row: preferRow }; // fallback
  }

  private canPlaceAt(col: number, row: number): boolean {
    return (
      isDeskSeatAnchor(this.mapObjects, col, row) &&
      this.isWalkable(col, row) &&
      !this.npcs.some((n) => n.id !== this.placementNpcId && n.homeCol === col && n.homeRow === row)
    );
  }

  // ===========================================================================
  // Meetings
  // ===========================================================================

  /** Only the arrival event lets the UI join the meeting. The request itself does not register participation. */
  isInMeetingSpace(): boolean {
    return (
      !!this.player &&
      !!this.meetingSpace &&
      insideMeetingSpace(this.meetingSpace.bounds, this.player.x / 32, this.player.y / 32)
    );
  }

  requestMeetingEntry(): boolean {
    if (this.meetingEntryPending) return false;
    if (!this.player || !this.canMovePlayer() || !this.meetingSpace) {
      EventBus.emit("meeting:entry-state", { status: "failed", reasonCode: "map_unavailable" });
      return false;
    }
    if (insideMeetingSpace(this.meetingSpace.bounds, this.player.x / 32, this.player.y / 32)) {
      this.currentPath = null;
      this.traffic.clear("player:local");
      EventBus.emit("meeting:entry-state", { status: "arrived" });
      return true;
    }
    const target = this.meetingSpace.entry;
    const path = this.findPlayerPath(
      Math.floor(this.player.x / 32),
      Math.floor(this.player.y / 32),
      Math.floor(target.x),
      Math.floor(target.y),
    );
    if (!path?.length) {
      EventBus.emit("meeting:entry-state", { status: "failed", reasonCode: "path_unavailable" });
      return false;
    }
    this.meetingEntryPending = true;
    this.meetingEntryStartedAt = this.now;
    this.currentPath = path;
    this.meetingEntryPath = path;
    this.pathIndex = 0;
    this.pathLastDist = Infinity;
    this.pathStuckTimer = 0;
    this.targetNpcId = null;
    EventBus.emit("meeting:entry-state", { status: "walking" });
    return true;
  }

  cancelMeetingEntry(): void {
    if (!this.meetingEntryPending) return;
    this.meetingEntryPending = false;
    if (this.currentPath === this.meetingEntryPath) this.currentPath = null;
    this.meetingEntryPath = null;
    EventBus.emit("meeting:entry-state", { status: "cancelled" });
  }

  setMeetingMode(active: boolean): void {
    this.meetingMode = active;
    if (active && !this.meetingSeatTarget) this.currentPath = null;
    if (!active && this.meetingSeatTarget) {
      this.currentPath = null;
      this.meetingSeatTarget = null;
    }
  }

  // ===========================================================================
  // NPC movement authority · applying snapshots
  // ===========================================================================

  /**
   * The server confirmed arrival while they were walking (`STALLED_MOTION_MS` — walking stopped because the tab was hidden).
   * This tab is the driver, so it normally does not accept snapshot coordinates, but it drops the remaining steps and moves to the confirmed spot.
   * When they arrived on their own, the coordinates are the same and no visible change occurs.
   */
  private snapToAuthority(npc: NpcController, state: MotionNpc): void {
    npc.pixelX = state.x;
    npc.pixelY = state.y;
    npc.direction = directionFromName(state.direction);
    npc.syncView();
    npc.remotePresentation?.accept(state.x, state.y, true);
    this.traffic.clear(npc.id);
  }

  private applySpatialNpc(npc: NpcController, state: MotionNpc): void {
    const target = state.spatialTarget!;
    if (state.ownerSocketId !== this.socket?.id) {
      this.spatialNpcRoutes.delete(npc.id);
      return;
    }
    if (!state.moving) {
      if (npc.moveState !== "waiting") this.snapToAuthority(npc, state);
      npc.cancelMovement();
      npc.moveState = "waiting";
      return;
    }
    const route = this.spatialNpcRoutes.get(npc.id);
    if (route?.generation === target.generation) return;
    this.spatialNpcRoutes.set(npc.id, { generation: target.generation, done: false });
    npc.cancelMovement();
    npc.destinationTag = null;
    npc.purposeAccessOrigin = null;
    npc.ambientExitPolicy = null;
    const path = this.npcPathfinder(npc)(
      Math.floor(npc.pixelX / 32),
      Math.floor(npc.pixelY / 32),
      Math.floor(target.x / 32),
      Math.floor(target.y / 32),
      this.createNpcWalkValidator(),
    );
    if (!path?.length) {
      this.socket?.emit("npc:spatial-failed", {
        channelId: this.channelId,
        npcId: npc.id,
        generation: target.generation,
      });
      return;
    }
    path[path.length - 1] = { x: target.x / 32 - 0.5, y: target.y / 32 - 0.5 };
    // Meeting call. It used to reuse the stroll path and gather at stroll speed (55px/s) — when called, they come running.
    npc.startStroll(path, this.motion.meetingSummon);
  }

  private updateSpatialNpc(npc: NpcController, state: MotionNpc): void {
    const target = state.spatialTarget!;
    if (state.ownerSocketId !== this.socket?.id || !state.moving) return;
    this.applySpatialNpc(npc, state);
    const route = this.spatialNpcRoutes.get(npc.id);
    if (!route || route.done) return;
    const result = npc.updateMovement(
      this.delta,
      this.player!.x,
      this.player!.y,
      this.npcPathfinder(npc),
      this.createNpcWalkValidator(),
      (position, goal, amount) =>
        this.traffic.step(
          npc.id,
          position,
          goal,
          amount,
          this.now,
          (x, y) => this.isWalkable(x, y),
          this.trafficActors(),
        ),
    );
    if (Math.hypot(npc.pixelX - target.x, npc.pixelY - target.y) <= 2) {
      route.done = true;
      npc.cancelMovement();
      npc.moveState = "waiting";
      this.socket?.emit("npc:position-update", {
        channelId: this.channelId,
        npcId: npc.id,
        x: npc.pixelX,
        y: npc.pixelY,
        direction: directionName(npc.direction),
      });
      this.socket?.emit("npc:arrived", {
        channelId: this.channelId,
        npcId: npc.id,
        generation: target.generation,
      });
    } else if (result === "idle" && npc.moveState === "idle") {
      route.done = true;
      this.socket?.emit("npc:spatial-failed", {
        channelId: this.channelId,
        npcId: npc.id,
        generation: target.generation,
      });
    }
  }

  private applyMotionNpc(npc: NpcController, state: MotionNpc, force = false): void {
    if (adoptNpcMotionHome(npc, state)) {
      force = true;
      this.seatLabelCache = null; // The occupancy marker follows the seat (home)
    }
    const previousOwner = this.npcOwnership.owner(npc.id);
    if (state.ownerSocketId) this.takeNpcOwnership(npc.id, state.ownerSocketId);
    else this.npcOwnership.clear(npc.id);
    if (state.phase === "returning") this.npcOwnership.startReturn(npc.id);
    const localDriver =
      state.ownerSocketId === this.socket?.id ||
      (!state.ownerSocketId && this.motionSnapshot.current?.ambientLeaderId === this.socket?.id);
    const reset =
      force ||
      npc.motionLocallyDriven !== localDriver ||
      previousOwner !== (state.ownerSocketId ?? undefined);
    npc.motionLocallyDriven = localDriver;
    npc.remotePresentation ??= new RemoteNpcPresentation(npc.pixelX, npc.pixelY);
    if (reset) {
      npc.cancelMovement();
      // The authority reset cancelled the path, so plan the same spatial move generation again.
      this.spatialNpcRoutes.delete(npc.id);
      npc.pixelX = state.x;
      npc.pixelY = state.y;
      npc.direction = directionFromName(state.direction);
      npc.syncView();
      npc.remotePresentation.accept(state.x, state.y, true);
      this.traffic.clear(npc.id);
    } else if (!localDriver) {
      // Update the authoritative collision coordinates now; the display follows every frame.
      npc.pixelX = state.x;
      npc.pixelY = state.y;
      npc.direction = directionFromName(state.direction);
      npc.remotePresentation.accept(state.x, state.y);
    }
    npc.remoteWalkingUntil = !localDriver && state.moving ? this.now + 500 : 0;
    if (state.spatialTarget) {
      this.applySpatialNpc(npc, state);
      return;
    }
    this.spatialNpcRoutes.delete(npc.id);
    if (force && state.continuation) {
      const restored = copyMotionContinuation(state.continuation);
      npc.ambientSchedule = restored.ambientSchedule;
      npc.ambientSeat = restored.ambientSeat ?? { x: npc.homeCol, y: npc.homeRow };
      npc.ambientTimer = restored.ambientTimer ?? 0;
      npc.ambientExitPolicy =
        restored.ambientSchedule.phase === "roam"
          ? new AmbientExitPolicy(this.ambientZones, {
              x: state.x / TILE_SIZE - 0.5,
              y: state.y / TILE_SIZE - 0.5,
            })
          : null;
      if (localDriver && state.phase === "ambient" && state.moving && restored.path?.length)
        npc.startStroll(restored.path);
    } else if (force && state.phase === "ambient") {
      npc.ambientSeat = { x: npc.homeCol, y: npc.homeRow };
      npc.ambientSchedule = {
        ...createAmbientSchedule(),
        phase: "roam",
        duration: 20000,
        ...(this.motionSnapshot.current?.seats.some((seat) => seat.actorId === npc.id)
          ? { seatRest: 10000, visitedSeat: true }
          : {}),
      };
    }
    if (localDriver && state.phase === "returning" && npc.moveState !== "returning") {
      npc.returnToHome(this.npcPathfinder(npc), this.createNpcWalkValidator());
      if (npc.moveState === "idle") this.finishNpcReturn(npc, true);
    } else if (localDriver && state.phase === "waiting" && npc.moveState !== "waiting") {
      this.snapToAuthority(npc, state);
      npc.cancelMovement();
      npc.moveState = "waiting";
    }
    if (
      force &&
      localDriver &&
      state.phase === "called" &&
      this.player &&
      !this.pendingNpcCalls.has(npc.id)
    )
      EventBus.emit("npc:call-to-player", { npcId: npc.id });
    if (!state.ownerSocketId && previousOwner) {
      npc.calledForRoom = null;
      if (!state.continuation) npc.ambientSchedule = { ...createAmbientSchedule(), phase: "home" };
      EventBus.emit("npc:movement-returned", { npcId: npc.id });
    }
  }

  private restoreMotionNpc(npc: NpcController): void {
    const state = this.motionSnapshot.current?.npcs.find((entry) => entry.npcId === npc.id);
    if (state) this.applyMotionNpc(npc, state, true);
    const pending = this.pendingNpcCalls.get(npc.id);
    if (pending && this.player && this.motionSnapshot.current) {
      this.pendingNpcCalls.delete(npc.id);
      EventBus.emit("npc:call-to-player", pending);
    }
  }

  private canMovePlayer(): boolean {
    return (
      !!this.socket?.connected &&
      this.playerSpawnReady &&
      this.peerSnapshotReady &&
      !!this.motionSnapshot.current
    );
  }

  private resumePlayerGoal(): void {
    if (!this.canMovePlayer() || !this.player || !this.pendingPlayerResume) return;
    const goal = this.pendingPlayerResume;
    this.pendingPlayerResume = null;
    this.resumingPlayerGoal = goal;
    const generation = this.motionGeneration;
    const resume = (accepted: boolean) => {
      if (this.resumingPlayerGoal === goal) this.resumingPlayerGoal = null;
      if (generation !== this.motionGeneration || this.spawnInputStarted || !this.player) {
        if (accepted && goal.seatId) this.releaseSeat(this.socket?.id ?? "");
        return;
      }
      if (!accepted) {
        this.currentPath = null;
        this.playerSeatGoal = null;
        // An expired cached seat may be under the restored avatar. Move it to an empty floor tile so it does not
        // look seated without a reservation.
        if (
          goal.seatId &&
          Math.hypot(goal.targetX - this.player.x, goal.targetY - this.player.y) <= 8
        ) {
          const col = Math.floor(this.player.x / TILE_SIZE),
            row = Math.floor(this.player.y / TILE_SIZE);
          let recovered = false;
          for (let radius = 1; radius < Math.max(MAP_COLS, MAP_ROWS) && !recovered; radius++) {
            for (let dx = -radius; dx <= radius && !recovered; dx++) {
              for (let dy = -radius; dy <= radius; dy++) {
                if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
                const x = col + dx,
                  y = row + dy;
                if (
                  !this.isWalkable(x, y) ||
                  this.isTileOccupied(x, y) ||
                  isSeatAnchor(this.mapObjects, x, y)
                )
                  continue;
                this.player.x = (x + 0.5) * TILE_SIZE;
                this.player.y = (y + 0.5) * TILE_SIZE;
                recovered = true;
                break;
              }
            }
          }
        }
        return;
      }
      this.playerSeatGoal = goal.seatId ?? null;
      if (Math.hypot(goal.targetX - this.player.x, goal.targetY - this.player.y) <= 2) return;
      const path = this.findPlayerPath(
        Math.floor(this.player.x / TILE_SIZE),
        Math.floor(this.player.y / TILE_SIZE),
        Math.floor(goal.targetX / TILE_SIZE),
        Math.floor(goal.targetY / TILE_SIZE),
      );
      if (path?.length) {
        this.currentPath = path;
        this.pathIndex = path.length > 1 ? 1 : 0;
        this.pathStuckTimer = 0;
        this.pathLastDist = Infinity;
      } else if (goal.seatId) {
        this.releaseSeat(this.socket?.id ?? "");
        this.playerSeatGoal = null;
      }
    };
    if (goal.seatId && this.socket?.id)
      this.reserveSeat(this.socket.id, goal.targetX, goal.targetY, resume);
    else resume(true);
  }

  private updateRemoteNpcPresentation(): void {
    for (const npc of this.npcs) {
      if (npc.motionLocallyDriven !== false || !npc.remotePresentation) continue;
      const view = npc.remotePresentation;
      view.step(this.delta);
      npc.viewX = view.x;
      npc.viewY = view.y;
    }
  }

  private npcContinuation(npc: NpcController) {
    return copyMotionContinuation({
      ambientSchedule: npc.ambientSchedule,
      ambientSeat: npc.ambientSeat ?? { x: npc.homeCol, y: npc.homeRow },
      ambientTimer: npc.ambientTimer,
      path: npc.currentPath?.slice(npc.pathIndex, npc.pathIndex + 256),
    });
  }

  private reserveSeat(actorId: string, x: number, y: number, done: (accepted: boolean) => void) {
    if (!this.socket?.connected || !this.motionSnapshot.current) {
      done(false);
      return;
    }
    const seatId = `${x}:${y}`;
    const existing = this.motionSnapshot.current.seats.find((seat) => seat.seatId === seatId);
    if (existing?.actorId === actorId) {
      done(true);
      return;
    }
    if (existing || this.pendingSeatClaims.has(actorId)) {
      done(false);
      return;
    }
    this.pendingSeatClaims.add(actorId);
    const generation = this.motionGeneration;
    const channelId = this.channelId;
    const socket = this.socket;
    socket
      .timeout(3000)
      .emit(
        "seat:claim",
        { channelId, seatId, actorId },
        (error: Error | null, result?: { ok: boolean }) => {
          if (
            generation !== this.motionGeneration ||
            socket !== this.socket ||
            channelId !== this.channelId
          ) {
            // The same Socket object may already hold a newer reservation after reconnecting.
            // Stale reservations are cleaned up by the server's departure/approach lease cleanup.
            return;
          }
          this.pendingSeatClaims.delete(actorId);
          done(!error && !!result?.ok);
        },
      );
  }

  private releaseSeat(actorId: string): void {
    this.socket?.emit("seat:release", { channelId: this.channelId, actorId });
  }

  private isAmbientLeader(): boolean {
    return (
      !!this.socket?.connected &&
      this.peerSnapshotReady &&
      !!this.motionSnapshot.current &&
      this.motionSnapshot.current.ambientLeaderId === this.socket.id
    );
  }

  private mayDriveNpc(npc: NpcController): boolean {
    return (
      !!this.socket?.connected &&
      this.peerSnapshotReady &&
      !!this.motionSnapshot.current &&
      this.npcOwnership.mayDrive(npc.id, this.socket.id, this.isAmbientLeader())
    );
  }

  private takeNpcOwnership(npcId: string, ownerId: string): void {
    if (!this.npcOwnership.claim(npcId, ownerId)) return;
    const npc = this.npcs.find((entry) => entry.id === npcId);
    if (npc) {
      npc.cancelMovement();
      npc.calledForRoom = null;
      delete npc.ambientSchedule.seatTarget;
      delete npc.ambientSchedule.seatRest;
      this.traffic.clear(npcId);
    }
  }

  private ensureLocalNpcOwnership(npc: NpcController, reason?: string, roomId?: string) {
    if (!this.socket?.connected || !this.socket.id || !this.motionSnapshot.current) return false;
    if (this.npcOwnership.owner(npc.id) === this.socket.id) return true;
    // Ownership is taken optimistically first — so walking is not interrupted for even one tick.
    // That is why it **must be reverted on refusal.** The ack used to be ignored entirely, so even when the server refused,
    // only the client believed it was the owner, and it never sent the call again afterwards.
    const previousOwner = this.npcOwnership.owner(npc.id);
    this.takeNpcOwnership(npc.id, this.socket.id);
    const npcId = npc.id;
    this.socket.emit(
      "npc:call",
      {
        channelId: this.channelId,
        npcId,
        ...(reason ? { reason } : {}),
        ...(roomId ? { roomId } : {}),
      },
      (result: unknown) => {
        if (this.disposed || !isNpcCallRejected(result)) return;
        if (previousOwner) this.npcOwnership.claim(npcId, previousOwner);
        else this.npcOwnership.clear(npcId);
        EventBus.emit("toast:show", {
          messageKey: npcCallErrorKey((result as { error?: unknown })?.error),
        });
      },
    );
    return true;
  }

  private finishNpcReturn(npc: NpcController, publish: boolean): void {
    const position = { x: npc.pixelX, y: npc.pixelY };
    const home = { x: (npc.homeCol + 0.5) * TILE_SIZE, y: (npc.homeRow + 0.5) * TILE_SIZE };
    if (publish)
      publishNpcArrival((event, payload) => this.socket?.emit(event, payload), {
        channelId: this.channelId,
        npcId: npc.id,
        ...position,
        direction: directionName(npc.direction),
      });
    if (this.npcOwnership.finishReturn(npc.id, position, home)) {
      npc.ambientSchedule = createAmbientSchedule();
      npc.calledForRoom = null;
      npc.remoteWalkingUntil = 0;
      this.traffic.clear(npc.id);
      EventBus.emit("npc:movement-returned", { npcId: npc.id });
    }
  }

  private releaseNpcOwner(ownerId: string): void {
    for (const npcId of this.npcOwnership.releaseOwner(ownerId)) {
      const npc = this.npcs.find((entry) => entry.id === npcId);
      if (!npc) continue;
      npc.cancelMovement();
      npc.calledForRoom = null;
      npc.ambientSchedule = { ...createAmbientSchedule(), phase: "home" };
      this.traffic.clear(npcId);
      EventBus.emit("npc:movement-returned", { npcId });
    }
  }

  private handleNpcCallToPlayer(payload: PendingNpcCall): void {
    if (
      !this.player ||
      !this.motionSnapshot.current ||
      !this.npcs.some((npc) => npc.id === payload.npcId)
    ) {
      this.pendingNpcCalls.set(payload.npcId, payload);
      return;
    }
    const playerCol = Math.floor(this.player.x / TILE_SIZE);
    const playerRow = Math.floor(this.player.y / TILE_SIZE);
    const npc = this.npcs.find((n) => n.id === payload.npcId);
    if (!npc) return;
    if (!this.ensureLocalNpcOwnership(npc, payload.reason, payload.roomId)) return;
    if (npc.moveState !== "idle") return;
    npc.calledForRoom = payload.reason === "map-chat" ? (payload.roomId ?? null) : null;

    // B-1. Working employees are also called **without blocking** — Hermes workers do the execution, so the card keeps running
    // even if they leave the seat. But do not leave the user unaware that they interrupted. The count is stated because
    // one employee can run several cards (the per-profile limit is unlimited by default).
    const busyCount = this.workingCounts[npc.id] ?? 0;
    if (busyCount > 0)
      EventBus.emit("toast:show", {
        messageKey: "game.calledWhileWorking",
        params: { name: payload.npcName || npc.name, count: String(busyCount) },
      });

    const dist = npc.distanceTo(this.player.x, this.player.y);
    if (dist < TILE_SIZE + 4) {
      npc.pendingMessage = payload.message || null;
      npc.arrivalBubbleText = payload.bubbleText || null;
      npc.waitDurationMs = 10000;
      npc.moveState = "waiting";
      npc.waitTimer = 0;
      if (!npc.calledForRoom)
        EventBus.emit("npc:bubble", {
          npcId: npc.id,
          text: npc.arrivalBubbleText || undefined,
        });
      EventBus.emit("toast:show", {
        messageKey: "game.pressToTalk",
        params: { name: payload.npcName || npc.name },
      });
      EventBus.emit("npc:movement-arrived", {
        npcId: npc.id,
        npcName: payload.npcName || npc.name,
        pendingMessage: npc.pendingMessage,
      });
      publishNpcArrival((event, data) => this.socket?.emit(event, data), {
        channelId: this.channelId,
        npcId: npc.id,
        x: npc.pixelX,
        y: npc.pixelY,
        direction: directionName(npc.direction),
      });
      return;
    }

    this.npcTilePositions.delete(`${npc.homeCol},${npc.homeRow}`);
    npc.moveTo(playerCol, playerRow, findPath, this.createNpcWalkValidator(), {
      message: payload.message,
      bubbleText: payload.bubbleText,
      // Call — when called they come running (default 2× the usual walk).
      speed: this.motion.summon,
    });
  }

  // ===========================================================================
  // Pointer · keyboard
  // ===========================================================================

  private handlePointerDown(
    worldX: number,
    worldY: number,
    button: number,
    screenX: number,
    screenY: number,
  ): void {
    const rightButtonDown = button === 2;
    // Placement mode: put the NPC on the clicked tile
    if (this.placementMode) {
      const col = Math.floor(worldX / TILE_SIZE);
      const row = Math.floor(worldY / TILE_SIZE);
      if (this.canPlaceAt(col, row)) EventBus.emit("placement-complete", { col, row });
      return;
    }

    // start position selection mode
    if (this.spawnSetMode) {
      const col = Math.floor(worldX / TILE_SIZE);
      const row = Math.floor(worldY / TILE_SIZE);
      if (this.isWalkable(col, row)) EventBus.emit("spawn:selected", { col, row });
      return;
    }

    if (!this.player || !this.playerReady || !this.canMovePlayer()) return;
    if (this.meetingMode) return;
    this.cancelMeetingEntry();

    // NPC right-click: context menu
    if (rightButtonDown) {
      for (const npc of this.npcs) {
        if (
          matchesNpcTarget(
            { id: npc.id, x: npc.pixelX, y: npc.pixelY },
            { x: worldX, y: worldY, actorId: this.presentationActorId },
          )
        ) {
          EventBus.emit("npc:context-menu", {
            npcId: npc.id,
            npcName: npc.name,
            screenX,
            screenY,
            moveState: npc.moveState,
          });
          return;
        }
      }
      return;
    }

    const targetTileX = Math.floor(worldX / TILE_SIZE);
    const targetTileY = Math.floor(worldY / TILE_SIZE);

    let clickedNpc: NpcController | null = null;
    for (const npc of this.npcs) {
      if (
        matchesNpcTarget(
          { id: npc.id, x: npc.pixelX, y: npc.pixelY },
          { x: worldX, y: worldY, actorId: this.presentationActorId },
        )
      ) {
        clickedNpc = npc;
        break;
      }
    }

    const startTileX = Math.floor(this.player.x / TILE_SIZE);
    const startTileY = Math.floor(this.player.y / TILE_SIZE);

    let destTileX = targetTileX;
    let destTileY = targetTileY;

    if (clickedNpc) {
      destTileX = Math.floor(clickedNpc.pixelX / TILE_SIZE);
      destTileY = Math.floor(clickedNpc.pixelY / TILE_SIZE);
      const neighbors = [
        [destTileX, destTileY + 1],
        [destTileX, destTileY - 1],
        [destTileX - 1, destTileY],
        [destTileX + 1, destTileY],
      ];
      const walkable = neighbors.find(
        ([x, y]) => this.isWalkable(x, y) && !this.isTileOccupied(x, y),
      );
      if (walkable) {
        destTileX = walkable[0];
        destTileY = walkable[1];
      }
    }

    if (!this.isWalkable(destTileX, destTileY) || this.isTileOccupied(destTileX, destTileY)) {
      const nearest = this.findNearestWalkableTile(destTileX, destTileY);
      if (!nearest) return;
      destTileX = nearest.x;
      destTileY = nearest.y;
    }

    const path = this.findPlayerPath(startTileX, startTileY, destTileX, destTileY);

    // Decide here what a single click means. It used to be only "walk over and talk on arrival",
    // so when already standing next to them no path formed and nothing happened.
    const intent = decideNpcClick({
      pathLength: path?.length ?? 0,
      clickedNpcId: clickedNpc?.id ?? null,
    });

    // Keep the target only when setting up an arrival wait — otherwise at the arrival of the next move
    // an unrelated NPC conversation opens.
    this.targetNpcId = clickedNpc && shouldRememberTarget(intent) ? clickedNpc.id : null;

    if (intent === "interact-now" && clickedNpc) {
      EventBus.emit("npc:interact", { npcId: clickedNpc.id, npcName: clickedNpc.name });
      return;
    }

    if (path && path.length > 1) {
      this.spawnInputStarted = true;
      this.traffic.clear("player:local");
      this.currentPath = path;
      this.pathIndex = 1;
      this.pathStuckTimer = 0;
      this.pathLastDist = Infinity;
    }
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return;
    if (CAPTURED_KEYS.has(event.key) || event.code === "Slash") event.preventDefault();
    const key = event.code === "Slash" ? "Slash" : event.key;
    if (!this.keysDown.has(key)) this.justPressed.add(key);
    this.keysDown.add(key);
    if (event.key === "Escape") {
      if (this.placementMode) EventBus.emit("placement-cancel");
      if (this.spawnSetMode) EventBus.emit("spawn-set-cancel");
    }
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    this.keysDown.delete(event.code === "Slash" ? "Slash" : event.key);
  };

  private handleWindowBlur = (): void => {
    this.keysDown.clear();
    this.justPressed.clear();
  };

  private isKeyDown(key: string): boolean {
    return this.keysDown.has(key);
  }

  // ===========================================================================
  // NPC loading
  // ===========================================================================

  /** Receive NPC seats before creating controllers so spawn collision checks line up */
  private async prefetchNpcPositions(): Promise<NpcData[]> {
    // Report failures distinctly from an empty list. It used to call `/api/npcs` without a channel and
    // ignore the response status, so a 400 was quietly drawn as "0 NPCs".
    const result = await fetchChannelNpcs(this.channelId);
    if (!result.ok) {
      console.warn(
        `[OfficeSimulation] prefetchNpcPositions failed (${result.reason}):`,
        result.message,
      );
      return [];
    }
    const npcs = result.npcs as NpcData[];
    for (const npc of npcs) {
      this.npcTilePositions.add(`${npc.positionX},${npc.positionY}`);
    }
    return npcs;
  }

  /** Receive the channel walking setting. It is not trusted but clamped, so empty or invalid values give defaults. */
  setMotionConfig(config: unknown): void {
    this.motion = normalizeNpcMotionConfig(config);
    for (const npc of this.npcs) this.applyMotion(npc);
  }

  /** Position report interval (ms). Keeps the fastest-moving NPC from exceeding 30px at a time. */
  private npcPositionSyncInterval(): number {
    let fastest = 0;
    for (const npc of this.npcs)
      if (npc.moveState !== "idle" && npc.moveState !== "waiting")
        fastest = Math.max(fastest, npc.currentSpeed());
    if (fastest <= 0) return NPC_SYNC_MAX_INTERVAL_MS;
    return Math.min(
      NPC_SYNC_MAX_INTERVAL_MS,
      Math.max(NPC_SYNC_MIN_INTERVAL_MS, (NPC_SYNC_CHORD_PX / fastest) * 1000),
    );
  }

  private applyMotion(npc: NpcController): void {
    npc.moveSpeed = this.motion.walk;
    npc.strollSpeed = this.motion.stroll;
  }

  private loadNpcs(npcDataList: NpcData[]): void {
    for (const npc of npcDataList) this.addNpc(npc);
  }

  private addNpc(data: NpcData): void {
    if (this.npcs.some((n) => n.id === data.id)) return;
    const npc = new NpcController(data);
    this.applyMotion(npc);
    this.npcs.push(npc);
    this.seatLabelCache = null;
    this.restoreMotionNpc(npc);
    this.npcTilePositions.add(`${data.positionX},${data.positionY}`);
  }

  private removeNpcById(npcId: string): void {
    this.npcOwnership.clear(npcId);
    this.spatialNpcRoutes.delete(npcId);
    const idx = this.npcs.findIndex((n) => n.id === npcId);
    if (idx === -1) return;
    const npc = this.npcs[idx];
    const col = Math.floor(npc.pixelX / TILE_SIZE);
    const row = Math.floor(npc.pixelY / TILE_SIZE);
    this.npcTilePositions.delete(`${col},${row}`);
    this.npcs.splice(idx, 1);
    this.seatLabelCache = null;
    // Bubbles live in a map keyed by npcId, not in the controller. Without clearing them here,
    // they stay forever at the last spot on clock-out and on npc:removed alike.
    this.clearNpcBubble(npcId);
    this.activityBubbles.delete(npcId);
  }

  // ===========================================================================
  // Socket listeners
  // ===========================================================================

  private handleSocketDisconnect = (): void => {
    this.localPlayerIdentity = undefined;
    this.cancelMeetingEntry();
    this.spatialNpcRoutes.clear();
    this.rejoin.onDisconnect();
    this.motionSnapshot.clear();
    this.peerSnapshotReady = false;
    this.playerSpawnReady = false;
    this.pendingPlayerResume = null;
    this.resumingPlayerGoal = null;
    this.motionGeneration++;
    this.pendingSeatClaims.clear();
  };

  private handleSocketConnect = (): void => {
    const reconnect = this.rejoin.shouldRejoin(this.playerReady && !!this.player);
    if (this.playerReady && this.player && (reconnect || this.joinedSocketId !== this.socket?.id)) {
      this.joinMultiplayer(this.player.x, this.player.y);
    }
  };

  // This path races with the connect tracker: on reconnect socket.io-client flushes the buffered
  // chat:send before the user's connect listener, so the server's chat:error not_joined can
  // arrive after the connect handler's join. Duplicates are filtered by socket id
  // (see the shouldRejoinForError comment in src/game/socket-rejoin.ts).
  private handleSocketRejoin = (): void => {
    if (!this.playerReady || !this.player) return;
    if (!shouldRejoinForError(this.socket?.id, this.joinedSocketId)) return;
    this.joinMultiplayer(this.player.x, this.player.y);
  };

  /** Learn my socket ↔ user from the participant list in the meeting state. Disconnected sockets are not learned. */
  private handleMeetingState(
    socket: Socket,
    state: { participants?: Array<{ id: string; userId?: string }> },
  ): void {
    if (this.socket !== socket || !socket.connected || !socket.id) return;
    const local = state.participants?.find((participant) => participant.id === socket.id);
    this.localPlayerIdentity =
      typeof local?.userId === "string" && local.userId
        ? { socketId: socket.id, userId: local.userId }
        : undefined;
  }

  private handleMotionState(snapshot: MotionSnapshot): void {
    const first = !this.motionSnapshot.current;
    const becameLeader =
      this.motionSnapshot.current?.ambientLeaderId !== this.socket?.id &&
      snapshot.ambientLeaderId === this.socket?.id;
    if (!this.motionSnapshot.accept(snapshot, this.channelId)) return;
    const ownSeat = snapshot.seats.find((seat) => seat.actorId === this.socket?.id);
    // The latch remembers which meeting seat we are already walking to, so it must not outlive the reservation.
    // After a meeting the host walked away (the server dropped the seat) and the next meeting reserved the *same*
    // seat — the latch still named it, no path was made, and the host stood still at "walking" until the gathering
    // timed out (observed on staging).
    if (!ownSeat?.spatial) this.meetingSeatTarget = null;
    if (ownSeat?.spatial && this.player && this.meetingSeatTarget !== ownSeat.seatId) {
      this.meetingSeatTarget = ownSeat.seatId;
      this.playerSeatGoal = ownSeat.seatId.startsWith("standing:") ? null : ownSeat.seatId;
      const path = this.findPlayerPath(
        Math.floor(this.player.x / 32),
        Math.floor(this.player.y / 32),
        Math.floor(ownSeat.x / 32),
        Math.floor(ownSeat.y / 32),
      );
      if (path?.length) {
        this.currentPath = path;
        this.pathIndex = 0;
        this.pathLastDist = Infinity;
        this.pathStuckTimer = 0;
      } else
        EventBus.emit("meeting:entry-state", {
          status: "failed",
          reasonCode: "path_unavailable",
        });
    }
    if (first && ownSeat) this.playerSeatGoal = ownSeat.seatId;
    if (
      this.playerSeatGoal &&
      !snapshot.seats.some(
        (seat) => seat.seatId === this.playerSeatGoal && seat.actorId === this.socket?.id,
      )
    )
      this.playerSeatGoal = null;
    this.resumePlayerGoal();
    for (const npc of this.npcs) {
      const state = snapshot.npcs.find((entry) => entry.npcId === npc.id);
      if (state) this.applyMotionNpc(npc, state, restoreOnSnapshot(first, becameLeader, state));
      const pending = this.pendingNpcCalls.get(npc.id);
      if (pending && this.player) {
        this.pendingNpcCalls.delete(npc.id);
        EventBus.emit("npc:call-to-player", pending);
      }
    }
  }

  /** The authoritative spawn. Only avatars with no input yet are moved to the server position, and restoring the movement target is scheduled. */
  private handlePlayerSpawn(position: PlayerSpawnState): void {
    if (this.player && untouchedSpawn(this.spawnRequest, this.player, this.spawnInputStarted)) {
      this.player.x = position.x;
      this.player.y = position.y;
      this.currentDirection = directionFromName(position.direction);
      this.playerActuallyWalking = false;
      this.currentPath = null;
      this.traffic.clear("player:local");
      // A remembered seat is only an intent, not evidence of a live reservation.
      this.playerSeatGoal = null;
      this.pendingPlayerResume = position.motion ?? null;
    }
    // Only after consuming the authoritative snapshot may local frames send movement.
    this.spawnRequest = null;
    this.playerSpawnReady = true;
    this.lastSentMotion = "";
    this.resumePlayerGoal();
  }

  /**
   * Old position packets. NPCs that the new snapshot already carries are not touched — duplicate packets
   * with the same coordinates must not break the display or clear the walking flag.
   */
  private handleLegacyPositionSync(data: {
    npcId: string;
    x: number;
    y: number;
    direction: string;
  }): void {
    const npc = this.npcs.find((n) => n.id === data.npcId);
    if (
      !npc ||
      this.motionSnapshot.current?.npcs.some((entry) => entry.npcId === data.npcId) ||
      this.mayDriveNpc(npc)
    )
      return;
    const moved = Math.hypot(npc.pixelX - data.x, npc.pixelY - data.y) > 0.01;
    npc.remoteWalkingUntil = moved ? this.now + 500 : 0;
    npc.direction = directionFromName(data.direction);
    npc.setPosition(data.x, data.y);
  }

  private setupSocketListeners(): void {
    if (!this.socket) return;
    this.socketListenerCleanup?.();
    const socket = this.socket;
    const cleanup: (() => void)[] = [];
    const listen = <Args extends unknown[]>(event: string, listener: (...args: Args) => void) => {
      socket.on(event, listener);
      cleanup.push(() => socket.off(event, listener));
    };
    const dispose = () => {
      for (const off of cleanup) off();
    };
    this.socketListenerCleanup = dispose;
    this.eventScope.addCleanup(dispose);

    // Reconnect = a new socket.id. It is not in the server's players map, so join again — without
    // it, channel chat and NPC mentions went silently dead after a reconnect.
    //
    // setupSocketListeners() is called twice in the normal flow — first from boot's request-socket →
    // socket-ready, second when createPlayer()'s player-spawned → ThreeGame re-emits socket-ready with the
    // same socket. Off-then-on makes it idempotent so one rejoin does not send
    // player:join twice (handlers are instance fields, so the references are stable).
    this.socket.off("disconnect", this.handleSocketDisconnect);
    listen("disconnect", this.handleSocketDisconnect);
    this.socket.off("connect", this.handleSocketConnect);
    listen("connect", this.handleSocketConnect);
    listen("meeting:state", (state: { participants?: Array<{ id: string; userId?: string }> }) =>
      this.handleMeetingState(socket, state),
    );
    registerOnce(EventBus, "socket-rejoin", this.handleSocketRejoin);

    listen("npc:motion-state", (snapshot: MotionSnapshot) => this.handleMotionState(snapshot));
    listen("player:spawn", (position: PlayerSpawnState) => this.handlePlayerSpawn(position));
    listen("players:state", (data: { players: RemotePlayerData[] }) => {
      this.peerMotionSamples = new Map(
        data.players.map((player) => [
          player.id,
          {
            receivedAt: performance.now(),
            moving: player.animation === "walk",
          },
        ]),
      );
      this.peerSnapshotReady = true;
      this.connectedPlayerIds = new Set(data.players.map((player) => player.id));
      this.peerPositions = new Map(
        data.players.map((player) => [
          player.id,
          { x: player.x, y: player.y, direction: player.direction, animation: player.animation },
        ]),
      );
      for (const id of [...this.remotePlayers.keys()]) {
        if (!this.connectedPlayerIds.has(id)) this.remotePlayers.delete(id);
      }
      this.resumePlayerGoal();
      for (const p of data.players) {
        const remote = this.remotePlayers.get(p.id);
        if (remote) remote.updatePosition(p.x, p.y, p.direction, p.animation);
        else this.addRemotePlayer(p);
      }
    });

    listen("player:joined", (data: RemotePlayerData) => {
      this.peerMotionSamples.set(data.id, {
        receivedAt: performance.now(),
        moving: data.animation === "walk",
      });
      this.connectedPlayerIds.add(data.id);
      this.peerPositions.set(data.id, {
        x: data.x,
        y: data.y,
        direction: data.direction,
        animation: data.animation,
      });
      this.addRemotePlayer(data);
    });

    listen(
      "player:moved",
      (data: { id: string; x: number; y: number; direction: string; animation: string }) => {
        this.peerMotionSamples.set(data.id, {
          receivedAt: performance.now(),
          moving: data.animation === "walk",
        });
        this.peerPositions.set(data.id, {
          x: data.x,
          y: data.y,
          direction: data.direction,
          animation: data.animation,
        });
        this.remotePlayers
          .get(data.id)
          ?.updatePosition(data.x, data.y, data.direction, data.animation);
      },
    );

    listen("player:left", (data: { id: string }) => {
      this.connectedPlayerIds.delete(data.id);
      this.peerPositions.delete(data.id);
      this.peerMotionSamples.delete(data.id);
      this.releaseNpcOwner(data.id);
      this.remotePlayers.delete(data.id);
    });

    // Real-time NPC sync
    listen("npc:added", (npcData: NpcData) => this.addNpc(npcData));

    // Two shapes arrive — the old `{ npcId, … }` (appearance/direction edits) and the new `{ npc }` (roster
    // toggle). `decideNpcUpdate` decides (a pure function tested in node).
    listen("npc:updated", (data: NpcUpdatedPayload) => {
      const action = decideNpcUpdate(data, (id) => this.npcs.some((n) => n.id === id));
      if (action.kind === "ignore") return;
      if (action.kind === "remove") {
        this.removeNpcById(action.npcId);
        return;
      }
      if (action.kind === "update") {
        const npc = this.npcs.find((n) => n.id === action.npcId);
        if (!npc) return;
        npc.updateFromData(action.fields);
        const motion = this.motionSnapshot.current?.npcs.find((state) => state.npcId === npc.id);
        if (motion) this.applyMotionNpc(npc, motion);
        return;
      }
      this.addNpc({ ...action.npc });
    });

    listen("npc:removed", (data: { npcId: string }) => {
      this.removeNpcById(data.npcId);
    });

    // Real-time map edit sync (legacy maps)
    listen("map:object-added", (data: { object: MapObject }) => {
      this.mapObjects.push(data.object);
      this.refreshObjectOccupancy();
    });

    listen("map:object-removed", (data: { objectId: string }) => {
      this.mapObjects = this.mapObjects.filter((o) => o.id !== data.objectId);
      this.refreshObjectOccupancy();
    });

    listen(
      "map:tiles-updated",
      (data: { layer: string; row: number; col: number; tileId: number }) => {
        if (this.tiledMode) return; // Tiled JSON maps do not use legacy tile editing
        if (data.layer === "floor" && this.floorData[data.row]) {
          this.floorData[data.row][data.col] = data.tileId;
        } else if (data.layer === "walls" && this.wallsData[data.row]) {
          this.wallsData[data.row][data.col] = data.tileId;
        }
      },
    );

    listen("npc:stop-moving", (data: { npcId: string }) => {
      const npc = this.npcs.find((n) => n.id === data.npcId);
      if (!npc) return;
      npc.remoteWalkingUntil = 0;
      this.finishNpcReturn(npc, false);
    });

    listen(
      "npc:position-sync",
      (data: { npcId: string; x: number; y: number; direction: string }) =>
        this.handleLegacyPositionSync(data),
    );
  }

  // ===========================================================================
  // Remote players · local player
  // ===========================================================================

  private addRemotePlayer(data: RemotePlayerData): void {
    if (this.remotePlayers.has(data.id)) return;
    if (!this.connectedPlayerIds.has(data.id)) return;
    this.remotePlayers.set(
      data.id,
      new RemotePlayer({ ...data, ...this.peerPositions.get(data.id) }),
    );
  }

  private createPlayer(): void {
    if (this.playerReady) return; // prevent duplicate creation

    let spawnX: number;
    let spawnY: number;

    // Existing members continue from where they left; the configured spawn is for first visits.
    if (this.savedPosition) {
      spawnX = this.savedPosition.x;
      spawnY = this.savedPosition.y;
      this.savedPosition = null;
    } else if (this.mapConfigSpawnCol !== null && this.mapConfigSpawnRow !== null) {
      const { col: spawnCol, row: spawnRow } = this.findFreeSpawn(
        this.mapConfigSpawnCol,
        this.mapConfigSpawnRow,
      );
      spawnX = spawnCol * TILE_SIZE + TILE_SIZE / 2;
      spawnY = spawnRow * TILE_SIZE + TILE_SIZE / 2;
      this.savedPosition = null;
    } else {
      // Find an empty spot avoiding NPCs, remote players and object-occupied tiles
      const preferSpawnCol = this.tiledSpawnCol ?? 8;
      const preferSpawnRow = this.tiledSpawnRow ?? 3;
      const { col: spawnCol, row: spawnRow } = this.findFreeSpawn(preferSpawnCol, preferSpawnRow);
      spawnX = spawnCol * TILE_SIZE + TILE_SIZE / 2;
      spawnY = spawnRow * TILE_SIZE + TILE_SIZE / 2;
    }

    this.player = { x: spawnX, y: spawnY };
    this.currentDirection = DIR_DOWN;
    this.playerReady = true;
    EventBus.emit("player-spawned");

    this.joinMultiplayer(spawnX, spawnY);
  }

  private joinMultiplayer(x: number, y: number): void {
    if (
      !this.socket?.connected ||
      !this.socket.id ||
      !this.characterId ||
      this.joinedSocketId === this.socket.id
    )
      return;

    this.motionSnapshot.clear();
    this.peerSnapshotReady = false;
    this.playerSpawnReady = false;
    this.pendingPlayerResume = null;
    this.resumingPlayerGoal = null;
    this.motionGeneration++;
    this.pendingSeatClaims.clear();
    this.playerSeatGoal = null;
    this.spawnRequest = { x, y };
    this.spawnInputStarted = false;
    // The server fills name and appearance from my character row — do not send them (characterId is for matching).
    this.socket.emit("player:join", {
      characterId: this.characterId,
      mapId: this.channelId || "office",
      mapRevision: this.mapRevision,
      x,
      y,
    });
    this.joinedSocketId = this.socket.id;
  }

  /** Position sending (throttled). Sent only after both authoritative snapshots have arrived. */
  private sendPosition(x: number, y: number, direction: string, animation: string): void {
    if (!this.socket?.connected || !this.playerSpawnReady || !this.peerSnapshotReady) return;

    const motion =
      playerMotionGoal(this.currentPath, this.playerSeatGoal, TILE_SIZE) ??
      (!this.spawnInputStarted ? this.resumingPlayerGoal : null) ??
      null;
    const motionKey = JSON.stringify(motion);
    const now = Date.now();
    if (now - this.lastMoveSent < MOVE_SEND_INTERVAL) return;

    if (
      Math.abs(x - this.lastSentX) < 0.5 &&
      Math.abs(y - this.lastSentY) < 0.5 &&
      direction === this.lastSentDir &&
      animation === this.lastSentAnim &&
      motionKey === this.lastSentMotion
    ) {
      return;
    }

    this.lastMoveSent = now;
    this.lastSentX = x;
    this.lastSentY = y;
    this.lastSentDir = direction;
    this.lastSentAnim = animation;

    this.lastSentMotion = motionKey;
    this.socket.emit("player:move", { x, y, direction, animation, motion });
  }

  /** Commit the endpoint that passed the check as is. Returns whether it moved. */
  private commitPlayerStep(to: { x: number; y: number }): boolean {
    const player = this.player!;
    const moved = player.x !== to.x || player.y !== to.y;
    player.x = to.x;
    player.y = to.y;
    return moved;
  }

  // ===========================================================================
  // Speech bubbles
  // ===========================================================================

  private showNpcBubbleIcon(npcId: string, text?: string, durationMs?: number): void {
    if (this.npcBubbles.has(npcId)) {
      if (durationMs || !text) return;
      this.clearNpcBubble(npcId);
    }

    const npc = this.npcs.find((n) => n.id === npcId);
    if (!npc) return;

    const bubble = { text };
    this.npcBubbles.set(npcId, bubble);
    if (durationMs)
      this.scheduler.delay(this.now, durationMs, () => {
        // An old greeting must not erase a newer work/report bubble.
        if (this.npcBubbles.get(npcId) === bubble) this.clearNpcBubble(npcId);
      });
  }

  private clearNpcBubble(npcId: string): void {
    this.npcBubbles.delete(npcId);
  }

  // ===========================================================================
  // NPC proximity
  // ===========================================================================

  private checkNpcProximity(): void {
    if (!this.playerReady || !this.player) return;
    const player = this.player;

    const nearby: NpcController[] = [];
    for (const npc of this.npcs) {
      if (npc.distanceTo(player.x, player.y) < NPC_INTERACT_RADIUS) nearby.push(npc);
    }
    nearby.sort((a, b) => a.distanceTo(player.x, player.y) - b.distanceTo(player.x, player.y));
    this.nearbyNpcs = nearby;

    // Automatic greeting when first approaching
    for (const npc of nearby) {
      if (!this.greetedNpcs.has(npc.id) && !this.dialogOpen && npc.moveState === "idle") {
        this.greetedNpcs.add(npc.id);
        EventBus.emit("npc:auto-greet", { npcId: npc.id, npcName: npc.name });
      }
    }

    // nearby remote players
    const nearbyP: { id: string; name: string }[] = [];
    for (const [id, remote] of this.remotePlayers) {
      if (remote.distanceTo(player.x, player.y) < NPC_INTERACT_RADIUS) {
        nearbyP.push({ id, name: remote.name });
      }
    }
    this.nearbyPlayers = nearbyP;

    const hasNearby = nearby.length > 0 || nearbyP.length > 0;

    // NPC dialog: close automatically when nobody is nearby
    // But do not close while the NPC is coming to the player (delivering a response)
    const npcApproaching = this.npcs.some((n) => n.moveState === "moving-to-player");
    if (
      this.dialogOpen &&
      nearby.length === 0 &&
      this.nearbyPlayers.length === 0 &&
      !npcApproaching
    ) {
      EventBus.emit("npc:dialog-auto-close");
    }

    // Channel chat: report input enabled/disabled by whether a conversation target is nearby.
    // NPCs can also be mentioned in map chat (@[name]), so the input must open even when only an NPC is nearby
    // with no people — looking only at nearbyP, a player alone could never call an NPC.
    const inputEnabled = hasNearby;
    if (inputEnabled !== this.lastChatInputEnabled) {
      this.lastChatInputEnabled = inputEnabled;
      EventBus.emit("chat:input-enabled", inputEnabled);
    }

    if (hasNearby && !this.dialogOpen) {
      const targetName = nearby.length > 0 ? nearby[0].name : nearbyP[0].name;
      // Judge duplicates by the target name, not the text itself — React does the translation.
      if (targetName !== this.lastToastMessage) {
        this.lastToastMessage = targetName;
        EventBus.emit("toast:show", {
          messageKey: "game.pressToTalk",
          params: { name: targetName },
        });
      }
    } else if (!this.dialogOpen) {
      if (this.lastToastMessage !== null) {
        this.lastToastMessage = null;
        EventBus.emit("toast:hide");
      }
    }
  }

  private approachNpcAndInteract(npcId: string, npcName?: string): void {
    if (!this.player || !this.playerReady || !this.canMovePlayer()) return;

    const npc = this.npcs.find((entry) => entry.id === npcId);
    if (!npc || npc.moveState !== "idle") return;

    if (npc.distanceTo(this.player.x, this.player.y) < NPC_INTERACT_RADIUS) {
      EventBus.emit("npc:interact", { npcId: npc.id, npcName: npcName || npc.name });
      return;
    }

    const npcTileX = Math.floor(npc.pixelX / TILE_SIZE);
    const npcTileY = Math.floor(npc.pixelY / TILE_SIZE);
    const startTileX = Math.floor(this.player.x / TILE_SIZE);
    const startTileY = Math.floor(this.player.y / TILE_SIZE);

    let destTileX = npcTileX;
    let destTileY = npcTileY;
    const neighbors = [
      [npcTileX, npcTileY + 1],
      [npcTileX, npcTileY - 1],
      [npcTileX - 1, npcTileY],
      [npcTileX + 1, npcTileY],
    ];
    const walkable = neighbors.find(
      ([x, y]) => this.isWalkable(x, y) && !this.isTileOccupied(x, y),
    );
    if (walkable) {
      destTileX = walkable[0];
      destTileY = walkable[1];
    }

    if (!this.isWalkable(destTileX, destTileY) || this.isTileOccupied(destTileX, destTileY)) {
      const nearest = this.findNearestWalkableTile(destTileX, destTileY);
      if (!nearest) return;
      destTileX = nearest.x;
      destTileY = nearest.y;
    }

    const path = this.findPlayerPath(startTileX, startTileY, destTileX, destTileY);

    if (!path || path.length <= 1) {
      EventBus.emit("npc:interact", { npcId: npc.id, npcName: npcName || npc.name });
      return;
    }

    this.traffic.clear("player:local");
    this.currentPath = path;
    this.pathIndex = 1;
    this.pathStuckTimer = 0;
    this.pathLastDist = Infinity;
    this.targetNpcId = npc.id;
  }

  // ===========================================================================
  // Tick
  // ===========================================================================

  /** Send a waiting NPC to their seat — timer expiry and channel chat closing use the same path. */
  /**
   * **Send an employee whose card started running back to their own assigned seat** (design 2026-09-21 npc-working-state, C-1).
   *
   * `mayDriveNpc` decides the owner — move only when I am the owner, or there is no owner and I am the ambient leader.
   * Dropping this check makes everyone connected walk the same NPC separately, and narrowing it too much makes
   * nobody walk (the movement ownership invariant in `src/game/AGENTS.md`).
   *
   * Do not touch them if they came when called (`calledForRoom`) or are already moving — what the user
   * called takes priority over automatic seating. Seat occupancy is owned by the server path `sendNpcHome` rides,
   * so the seat is not grabbed directly here.
   */
  private seatNpcForWork(npcId: string): void {
    const npc = this.npcs.find((entry) => entry.id === npcId);
    if (!npc) return;
    if (npc.calledForRoom || npc.moveState !== "idle") return;
    if (!this.mayDriveNpc(npc)) return;
    const atHome =
      Math.floor(npc.pixelX / TILE_SIZE) === npc.homeCol &&
      Math.floor(npc.pixelY / TILE_SIZE) === npc.homeRow;
    if (atHome) return;
    this.sendNpcHome(npc);
  }

  private sendNpcHome(npc: NpcController): void {
    if (!this.mayDriveNpc(npc)) return;
    if (this.motionSnapshot.current?.npcs.some((s) => s.npcId === npc.id && s.spatialTarget))
      return;
    npc.waitTimer = 0;
    this.clearNpcBubble(npc.id);
    this.npcOwnership.startReturn(npc.id);
    this.socket?.emit("npc:return-home", { channelId: this.channelId, npcId: npc.id });
    npc.returnToHome(this.npcPathfinder(npc), this.createNpcWalkValidator());
    if (npc.moveState === "idle") this.finishNpcReturn(npc, true);
  }

  private publishReturnDiagnostics(): void {
    if (
      process.env.NODE_ENV !== "development" ||
      process.env.NEXT_PUBLIC_DESKRPG_MOTION_DIAGNOSTICS !== "1" ||
      this.now - this.returnDiagnosticAt < 1000
    )
      return;
    this.returnDiagnosticAt = this.now;
    const states = this.npcs
      .filter(
        (npc) =>
          npc.moveState === "returning" ||
          this.motionSnapshot.current?.npcs.some(
            (state) => state.npcId === npc.id && state.phase === "returning",
          ),
      )
      .map((npc) => {
        const next = npc.currentPath?.[npc.pathIndex];
        return {
          name: npc.name,
          localOwner: this.npcOwnership.owner(npc.id) === this.socket?.id,
          drive: this.mayDriveNpc(npc),
          state: npc.moveState,
          position: [npc.pixelX, npc.pixelY],
          home: [npc.homeCol, npc.homeRow],
          homeWalkable: this.isWalkable(npc.homeCol, npc.homeRow),
          path: [npc.pathIndex, npc.currentPath?.length ?? 0],
          next,
          nextWalkable: next ? this.isWalkable(next.x, next.y) : null,
          nearby: this.trafficActors()
            .filter(
              (actor) =>
                actor.id !== npc.id &&
                Math.hypot(
                  actor.x - (npc.pixelX / TILE_SIZE - 0.5),
                  actor.y - (npc.pixelY / TILE_SIZE - 0.5),
                ) < 1.5,
            )
            .map(({ id, x, y }) => ({ id, x, y })),
        };
      });
    if (!states.length) {
      this.returnDiagnosticNode?.remove();
      this.returnDiagnosticNode = null;
      return;
    }
    if (!this.returnDiagnosticNode) {
      const node = document.createElement("output");
      node.id = "ui2-return-diagnostics";
      node.setAttribute("aria-label", "NPC return path diagnostics (development)");
      node.style.cssText =
        "position:fixed;bottom:0;left:0;z-index:99999;max-width:560px;max-height:100px;overflow:auto;font:10px monospace;background:#fff;color:#111;pointer-events:none";
      document.body.append(node);
      this.returnDiagnosticNode = node;
    }
    this.returnDiagnosticNode.textContent = JSON.stringify(states);
  }

  private step(now: number, delta: number): void {
    if (this.disposed || !this.booted) return;
    this.now = now;
    this.delta = delta;
    this.scheduler.tick(now);
    if (this.paused) {
      this.justPressed.clear();
      return;
    }
    this.update();
    this.justPressed.clear();
  }

  /** Frame update. The same order as the old scene's update(). */
  private update(): void {
    this.playerActuallyWalking = false;
    if (this.meetingEntryPending && this.currentPath !== this.meetingEntryPath)
      this.cancelMeetingEntry();
    if (this.meetingEntryPending && this.now - this.meetingEntryStartedAt > 120_000) {
      this.cancelMeetingEntry();
      EventBus.emit("meeting:entry-state", { status: "failed", reasonCode: "arrival_timeout" });
    }
    this.publishReturnDiagnostics();
    // Remote players are interpolated every frame
    for (const remote of this.remotePlayers.values()) remote.lerpUpdate();

    this.updateRemoteNpcPresentation();

    // Remote snapshots keep coming, but local input cannot compete with authoritative hydration.
    if (!this.canMovePlayer()) return;
    if (this.player) this.updateNpcs();

    // Placement mode: skip player movement (the renderer cursor handles highlighting)
    if (this.placementMode) return;
    // start position selection mode: same
    if (this.spawnSetMode) return;

    if (!this.playerReady || !this.player) return;

    this.checkNpcProximity();

    // Interact with NPCs/players with the `/` key
    if (this.justPressed.has("Slash")) {
      if (isTypingTarget(document.activeElement)) return;
      if (!this.dialogOpen) {
        const npcEntries = this.nearbyNpcs.map((n) => ({
          id: n.id,
          name: n.name,
          type: "npc" as const,
        }));
        const playerEntries = this.nearbyPlayers.map((p) => ({
          id: p.id,
          name: p.name,
          type: "player" as const,
        }));
        const allNearby = [...npcEntries, ...playerEntries];

        if (allNearby.length === 1) {
          if (allNearby[0].type === "npc") {
            EventBus.emit("npc:interact", { npcId: allNearby[0].id, npcName: allNearby[0].name });
          } else {
            EventBus.emit("player:chat-open");
          }
        } else if (allNearby.length > 1) {
          EventBus.emit("interact:select", { targets: allNearby });
        }
      }
    }

    this.updatePlayer();
  }

  private updateNpcs(): void {
    const player = this.player!;
    const leader = this.isAmbientLeader();
    this.smalltalk.update(
      this.npcs.map((npc) => ({
        id: npc.id,
        name: npc.name,
        x: npc.pixelX / TILE_SIZE,
        y: npc.pixelY / TILE_SIZE,
        walking: npc.moveState === "strolling" || npc.remoteWalkingUntil > this.now,
        available:
          !this.npcOwnership.owner(npc.id) &&
          ambientAllowed(
            !!this.responsePhases[npc.id] ||
              this.activityBubbles.has(npc.id) ||
              this.npcBubbles.has(npc.id),
            this.dialogOpen,
            !!npc.calledForRoom,
          ) &&
          (npc.moveState === "idle" || npc.moveState === "strolling"),
      })),
      this.now,
      (a, b) => {
        // Do not greet across walls or rows of bookshelves.
        for (let step = 1; step < 8; step++) {
          const x = Math.floor(a.x + ((b.x - a.x) * step) / 8);
          const y = Math.floor(a.y + ((b.y - a.y) * step) / 8);
          if (!this.isWalkable(x, y)) return false;
        }
        return true;
      },
    );
    for (const npc of this.npcs) {
      const partnerId = this.smalltalk.partner(npc.id, this.now);
      const partner = this.npcs.find((other) => other.id === partnerId);
      const paused = !!partner && leader;
      if (paused) {
        npc.pauseForSmalltalk(partner);
        if (!npc.ambientPaused && npc.moveState === "strolling") {
          this.socket?.emit("npc:position-update", {
            channelId: this.channelId,
            npcId: npc.id,
            continuation: this.npcContinuation(npc),
            x: npc.pixelX,
            y: npc.pixelY,
            direction: directionName(npc.direction),
          });
          this.socket?.emit("npc:arrived", { channelId: this.channelId, npcId: npc.id });
        }
      }
      npc.ambientPaused = paused;
    }
    // The person ready the longest gets the next departure slot.
    const ambientOrder = [...this.npcs].sort(
      (a, b) =>
        b.ambientSchedule.elapsed -
        b.ambientSchedule.duration -
        (a.ambientSchedule.elapsed - a.ambientSchedule.duration),
    );
    for (const npc of ambientOrder) {
      if (this.motionSnapshot.current?.npcs.some((s) => s.npcId === npc.id && s.spatialTarget))
        continue;
      const allowed =
        this.npcOwnership.mayRoam(npc.id, leader) &&
        ambientAllowed(
          // Do not go for a stroll while working. The activity bubble alone is not enough — long quiet
          // runs have no `tool.progress`, so the moment the ambient schedule (rest 60–100s) is due
          // they would get up from the seat wearing the badge (decision C-1 "when a run starts, go to the seat and sit").
          this.workingNpcs.has(npc.id) ||
            !!this.responsePhases[npc.id] ||
            this.activityBubbles.has(npc.id),
          this.dialogOpen,
          !!npc.calledForRoom,
        );
      if (!allowed) {
        if (npc.moveState === "strolling") {
          npc.stopStroll();
          if (leader)
            this.socket?.emit("npc:arrived", { channelId: this.channelId, npcId: npc.id });
        }
        npc.ambientTimer = 0;
        delete npc.ambientSchedule.seatTarget;
        delete npc.ambientSchedule.seatRest;
        // An employee whose work started mid-walk stops here. `seatNpcForWork` turns back when `moveState !== "idle"`,
        // so send them again from this spot so they do not stand where they stopped with just the badge.
        // This branch runs every tick while working, so even if not idle yet it retries on the next tick.
        if (this.workingNpcs.has(npc.id)) this.seatNpcForWork(npc.id);
        continue;
      }
      if (npc.ambientPaused) continue;
      if (npc.moveState !== "idle" && npc.moveState !== "strolling") continue;
      if (npc.remoteWalkingUntil > this.now) continue;
      const sx = Math.floor(npc.pixelX / TILE_SIZE),
        sy = Math.floor(npc.pixelY / TILE_SIZE);
      if (!npc.ambientSeat) {
        // The saved layout is the authoritative seat — do not pick another chair.
        npc.ambientSeat = { x: npc.homeCol, y: npc.homeRow };
        // Even the first arrival fixes the work seat before starting the cycle.
        npc.ambientSchedule.phase = "home";
      }
      const home = npc.ambientSeat;
      const atHome =
        Math.hypot(npc.pixelX / TILE_SIZE - home.x - 0.5, npc.pixelY / TILE_SIZE - home.y - 0.5) <
        0.1;
      if (
        restAtAmbientSeat(
          npc.ambientSchedule,
          { x: npc.pixelX / TILE_SIZE - 0.5, y: npc.pixelY / TILE_SIZE - 0.5 },
          npc.moveState === "strolling",
          this.delta,
        )
      )
        continue;
      const previousPhase = npc.ambientSchedule.phase;
      advanceAmbientSchedule(
        npc.ambientSchedule,
        this.delta,
        atHome,
        Math.random,
        this.ambientDepartures.canDepart(
          this.now,
          this.npcs.filter((other) => other !== npc && other.ambientSchedule.phase !== "rest")
            .length,
        ),
      );
      if (previousPhase === "rest" && npc.ambientSchedule.phase !== "rest") {
        this.ambientDepartures.departed(this.now);
      }

      if (previousPhase !== "roam" && npc.ambientSchedule.phase === "roam") {
        npc.ambientExitPolicy = new AmbientExitPolicy(this.ambientZones, {
          x: npc.pixelX / TILE_SIZE - 0.5,
          y: npc.pixelY / TILE_SIZE - 0.5,
        });
      }
      if (npc.ambientSchedule.phase === "home") npc.ambientExitPolicy = null;
      if (previousPhase !== "home" && npc.ambientSchedule.phase === "home") npc.stopStroll();
      if (npc.moveState !== "idle" || npc.ambientSchedule.phase === "rest") continue;
      if (this.npcs.filter((other) => other !== npc && other.moveState === "strolling").length >= 2)
        continue;
      npc.ambientTimer += Math.min(this.delta, 100);
      if (npc.ambientTimer < npc.ambientSchedule.pause) continue;
      npc.ambientTimer = 0;
      const zoneWalkable =
        npc.ambientExitPolicy?.at({
          x: npc.pixelX / TILE_SIZE - 0.5,
          y: npc.pixelY / TILE_SIZE - 0.5,
        }) ?? ((x: number, y: number) => ambientTileAllowed(this.ambientZones, x, y));
      const walkable = (x: number, y: number) =>
        (npc.ambientSchedule.phase === "home" || zoneWalkable(x, y)) && this.isWalkable(x, y);
      const destinationFree = (x: number, y: number) =>
        clearActors(
          { x, y },
          { x, y },
          this.trafficActors().filter((actor) => actor.id !== npc.id),
        );
      const publicSeats = commonAreaSeats(this.mapObjects)
        .map((seat) => ({
          x: Math.floor(seat.anchorX ?? seat.x),
          y: Math.floor(seat.anchorZ ?? seat.z),
        }))
        .filter(
          (seat) =>
            ambientTileAllowed(this.ambientZones, seat.x, seat.y) &&
            !this.npcs.some(
              (other) =>
                (other.homeCol === seat.x && other.homeRow === seat.y) ||
                (other !== npc &&
                  other.ambientSchedule.seatTarget?.x === seat.x &&
                  other.ambientSchedule.seatTarget?.y === seat.y),
            ) &&
            walkable(seat.x, seat.y) &&
            destinationFree(seat.x, seat.y) &&
            (seat.x !== sx || seat.y !== sy),
        );
      const visitSeats =
        npc.ambientSchedule.phase === "roam" &&
        !npc.ambientSchedule.visitedSeat &&
        Math.random() < 0.6;
      const destinations =
        npc.ambientSchedule.phase === "home"
          ? [home]
          : ambientDestinations(
              this.floorData[0]?.length ?? 0,
              this.floorData.length,
              { x: sx, y: sy },
              (x, y) => walkable(x, y) && ambientTileAllowed(this.ambientZones, x, y),
            );
      if (visitSeats) {
        // Shuffle seats separately so room/seat order is not biased per visit.
        for (let i = publicSeats.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [publicSeats[i], publicSeats[j]] = [publicSeats[j], publicSeats[i]];
        }
        destinations.unshift(...publicSeats);
      }
      // Limit A* per pass; if this random batch cannot reach, try again later.
      for (const destination of destinations.slice(0, 12)) {
        if (
          !walkable(destination.x, destination.y) ||
          !destinationFree(destination.x, destination.y)
        )
          continue;
        const path = findPath(sx, sy, destination.x, destination.y, walkable);
        if (path && path.length > 0) {
          if (npc.ambientSchedule.phase === "roam") {
            const seat = publicSeats.find((s) => s.x === destination.x && s.y === destination.y);
            npc.ambientSchedule.seatTarget = seat;
            if (seat) npc.ambientSchedule.visitedSeat = true;
          }
          if (isSeatAnchor(this.mapObjects, destination.x, destination.y)) {
            const phase = npc.ambientSchedule.phase;
            this.reserveSeat(
              npc.id,
              (destination.x + 0.5) * TILE_SIZE,
              (destination.y + 0.5) * TILE_SIZE,
              (ok) => {
                if (
                  ok &&
                  this.isAmbientLeader() &&
                  !this.npcOwnership.owner(npc.id) &&
                  npc.moveState === "idle" &&
                  this.npcs.filter((other) => other !== npc && other.moveState === "strolling")
                    .length < 2 &&
                  npc.ambientSchedule.phase === phase
                )
                  npc.startStroll(path);
                else if (ok) this.releaseSeat(npc.id);
              },
            );
          } else {
            this.releaseSeat(npc.id);
            npc.startStroll(path);
          }
          break;
        }
      }
      npc.ambientSchedule.pause =
        npc.ambientSchedule.phase === "home" ? 1000 : randomDuration(2000, 6000);
    }
    // NPCs who waited long enough without a dialog go back automatically
    for (const npc of this.npcs) {
      if (
        this.mayDriveNpc(npc) &&
        shouldAutoReturn(npc, {
          dialogOpen: this.dialogOpen,
          visibleRoomId: this.visibleRoomId,
        })
      ) {
        npc.waitTimer += this.delta;
        if (
          npc.waitTimer >= npc.waitDurationMs &&
          !this.motionSnapshot.current?.npcs.some((s) => s.npcId === npc.id && s.spatialTarget)
        )
          this.sendNpcHome(npc);
      }
    }

    for (const npc of this.npcs) {
      if (!this.mayDriveNpc(npc)) continue;
      const spatialMotion = this.motionSnapshot.current?.npcs.find(
        (s) => s.npcId === npc.id && s.spatialTarget,
      );
      if (spatialMotion) {
        this.updateSpatialNpc(npc, spatialMotion);
        continue;
      }
      if (npc.ambientPaused && npc.moveState === "strolling") continue;
      if (npc.moveState === "idle" || npc.moveState === "waiting") {
        this.traffic.clear(npc.id);
        continue;
      }
      const destination = npc.currentPath?.[npc.currentPath.length - 1];
      if (
        npc.moveState === "strolling" &&
        destination &&
        isSeatAnchor(this.mapObjects, destination.x, destination.y) &&
        !this.motionSnapshot.current?.seats.some(
          (seat) =>
            seat.actorId === npc.id &&
            seat.seatId ===
              `${(destination.x + 0.5) * TILE_SIZE}:${(destination.y + 0.5) * TILE_SIZE}`,
        )
      ) {
        npc.stopStroll();
        continue;
      }
      const wasStrolling = npc.moveState === "strolling";
      const position = { x: npc.pixelX / TILE_SIZE - 0.5, y: npc.pixelY / TILE_SIZE - 0.5 };
      const zoneWalkable =
        npc.ambientExitPolicy?.at(position) ??
        ((x: number, y: number) => ambientTileAllowed(this.ambientZones, x, y));
      const npcWalkable = this.createNpcWalkValidator();
      const routeWalkable = (x: number, y: number) =>
        npcWalkable(x, y) &&
        (!npc.destinationTag ||
          !npc.purposeAccessOrigin ||
          taggedPathTileAllowed(
            this.ambientZones,
            npc.destinationTag,
            npc.purposeAccessOrigin,
            x,
            y,
          )) &&
        (!wasStrolling || npc.ambientSchedule.phase === "home" || zoneWalkable(x, y));
      const result = npc.updateMovement(
        this.delta,
        player.x,
        player.y,
        this.npcPathfinder(npc),
        routeWalkable,
        (bodyPosition, goal, amount) => {
          const zoneWalkableNow =
            npc.ambientExitPolicy?.at(bodyPosition) ??
            ((x: number, y: number) => ambientTileAllowed(this.ambientZones, x, y));
          return this.traffic.step(
            npc.id,
            bodyPosition,
            goal,
            amount,
            this.now,
            (x, y) =>
              this.isWalkable(x, y) &&
              (!npc.destinationTag ||
                !npc.purposeAccessOrigin ||
                taggedPathTileAllowed(
                  this.ambientZones,
                  npc.destinationTag,
                  npc.purposeAccessOrigin,
                  x,
                  y,
                )) &&
              (!wasStrolling || npc.ambientSchedule.phase === "home" || zoneWalkableNow(x, y)),
            this.trafficActors(),
          );
        },
      );
      if (wasStrolling && result === "idle") {
        this.socket?.emit("npc:position-update", {
          channelId: this.channelId,
          npcId: npc.id,
          continuation: this.npcContinuation(npc),
          x: npc.pixelX,
          y: npc.pixelY,
          direction: directionName(npc.direction),
        });
        this.socket?.emit("npc:arrived", { channelId: this.channelId, npcId: npc.id });
      }
      if (result === "arrived") {
        if (!npc.calledForRoom)
          EventBus.emit("npc:bubble", {
            npcId: npc.id,
            text: npc.arrivalBubbleText || undefined,
          });
        EventBus.emit("toast:show", {
          messageKey: "game.pressToTalk",
          params: { name: npc.name },
        });
        EventBus.emit("npc:movement-arrived", {
          npcId: npc.id,
          npcName: npc.name,
          pendingMessage: npc.pendingMessage,
        });
        publishNpcArrival((event, payload) => this.socket?.emit(event, payload), {
          channelId: this.channelId,
          npcId: npc.id,
          x: npc.pixelX,
          y: npc.pixelY,
          direction: directionName(npc.direction),
        });
      } else if (result === "returning-done") {
        this.npcTilePositions.add(`${npc.homeCol},${npc.homeRow}`);
        this.finishNpcReturn(npc, true);
      }
    }

    // Also preserve the rest clock and stall clock; position updates alone miss the stopped state.
    this.npcContinuationTimer += this.delta;
    if (this.npcContinuationTimer >= 1000) {
      this.npcContinuationTimer = 0;
      for (const npc of this.npcs) {
        if (this.mayDriveNpc(npc))
          this.socket?.emit("npc:continuation-update", {
            channelId: this.channelId,
            npcId: npc.id,
            continuation: this.npcContinuation(npc),
          });
      }
    }
    // Send moving NPC positions to the server. The interval is set by **the distance moved per report** — the server
    // checks that the straight line between two consecutive reports is not blocked, and when walking fast that line cuts across
    // corners and furniture. Once rejected, the server position lags so the next line is even longer and is never accepted
    // (measured: with a fixed 200ms, meeting calls at 150px/s gathered while 300px/s stalled at "moving"). Shorten the interval
    // to match the speed so each report does not exceed the 30px the old walk (150px/s) covered in 200ms.
    this.npcPositionSyncTimer += this.delta;
    if (this.npcPositionSyncTimer >= this.npcPositionSyncInterval()) {
      this.npcPositionSyncTimer = 0;
      for (const npc of this.npcs) {
        if (!this.mayDriveNpc(npc)) continue;
        if (
          npc.moveState === "moving-to-player" ||
          npc.moveState === "returning" ||
          (npc.moveState === "strolling" && !npc.ambientPaused)
        ) {
          this.socket?.emit("npc:position-update", {
            channelId: this.channelId,
            npcId: npc.id,
            continuation: this.npcContinuation(npc),
            x: npc.pixelX,
            y: npc.pixelY,
            direction: directionName(npc.direction),
          });
        }
      }
    }
  }

  private updatePlayer(): void {
    const player = this.player!;
    // keyboard input
    const left = !this.meetingMode && this.isKeyDown("ArrowLeft");
    const right = !this.meetingMode && this.isKeyDown("ArrowRight");
    const up = !this.meetingMode && this.isKeyDown("ArrowUp");
    const down = !this.meetingMode && this.isKeyDown("ArrowDown");
    const hasKeyboardInput = left || right || up || down;
    if (hasKeyboardInput) {
      this.cancelMeetingEntry();
      this.spawnInputStarted = true;
      if (this.playerSeatGoal) {
        this.releaseSeat(this.socket?.id ?? "");
        this.playerSeatGoal = null;
      }
    }

    // arrow keys cancel path following
    if (hasKeyboardInput && this.currentPath) {
      this.traffic.clear("player:local");
      this.currentPath = null;
      this.targetNpcId = null;
    }

    // Reserve before approaching the seat; standing overlapped does not resolve contention.
    if (this.currentPath?.length && this.socket?.id) {
      const goal = this.currentPath[this.currentPath.length - 1];
      const goalId = `${(goal.x + 0.5) * TILE_SIZE}:${(goal.y + 0.5) * TILE_SIZE}`;
      if (this.playerSeatGoal && this.playerSeatGoal !== goalId) {
        this.releaseSeat(this.socket.id);
        this.playerSeatGoal = null;
      }
      if (isSeatAnchor(this.mapObjects, goal.x, goal.y) && this.playerSeatGoal !== goalId) {
        const path = this.currentPath;
        if (!this.pendingSeatClaims.has(this.socket.id))
          this.reserveSeat(
            this.socket.id,
            (goal.x + 0.5) * TILE_SIZE,
            (goal.y + 0.5) * TILE_SIZE,
            (ok) => {
              if (this.currentPath !== path) {
                if (ok) this.releaseSeat(this.socket?.id ?? "");
                return;
              }
              if (ok) this.playerSeatGoal = goalId;
              else this.currentPath = null;
            },
          );
        return;
      }
    }
    // path following
    if (this.currentPath && this.pathIndex < this.currentPath.length) {
      const target = this.currentPath[this.pathIndex];
      const targetPixelX = target.x * TILE_SIZE + TILE_SIZE / 2;
      const targetPixelY = target.y * TILE_SIZE + TILE_SIZE / 2;

      const dx = targetPixelX - player.x;
      const dy = targetPixelY - player.y;
      const dist = Math.hypot(dx, dy);

      if (dist < this.pathLastDist - 0.5) {
        this.pathStuckTimer = 0;
        this.pathLastDist = dist;
      } else {
        this.pathStuckTimer++;
      }

      // Unlike ordinary destinations, seats must be reached at their center.
      const arrivingAtSeat =
        this.pathIndex === this.currentPath.length - 1 &&
        isSeatAnchor(this.mapObjects, target.x, target.y);
      if (arrivingAtSeat && this.isTileOccupied(target.x, target.y)) {
        this.releaseSeat(this.socket?.id ?? "");
        this.playerSeatGoal = null;
        this.currentPath = null;
        return;
      }
      const reached = dist < 2;
      if (reached) {
        this.pathIndex++;
        this.pathStuckTimer = 0;
        this.pathLastDist = Infinity;
        if (this.pathIndex >= this.currentPath.length) {
          if (this.meetingEntryPending && this.currentPath === this.meetingEntryPath) {
            this.meetingEntryPending = false;
            this.meetingEntryPath = null;
            this.sendPosition(player.x, player.y, directionName(this.currentDirection), "idle");
            EventBus.emit("meeting:entry-state", { status: "arrived" });
          }
          this.currentPath = null;
          this.traffic.clear("player:local");

          if (this.targetNpcId) {
            const npc = this.npcs.find((n) => n.id === this.targetNpcId);
            if (npc) EventBus.emit("npc:interact", { npcId: npc.id, npcName: npc.name });
            this.targetNpcId = null;
          }
        }
      } else {
        const dt = Math.max(0.001, Math.min(this.delta, 100) / 1000);
        const next = this.traffic.step(
          "player:local",
          { x: player.x / TILE_SIZE - 0.5, y: player.y / TILE_SIZE - 0.5 },
          target,
          Math.min(PLAYER_SPEED * dt, dist) / TILE_SIZE,
          this.now,
          (x, y) => this.isWalkable(x, y),
          this.trafficActors(),
        );
        const vx = ((next.x + 0.5) * TILE_SIZE - player.x) / dt;
        const vy = ((next.y + 0.5) * TILE_SIZE - player.y) / dt;
        this.playerActuallyWalking = this.commitPlayerStep({
          x: (next.x + 0.5) * TILE_SIZE,
          y: (next.y + 0.5) * TILE_SIZE,
        });

        if (Math.abs(vx) > Math.abs(vy)) {
          this.currentDirection = vx > 0 ? DIR_RIGHT : DIR_LEFT;
        } else if (vy !== 0) {
          this.currentDirection = vy > 0 ? DIR_DOWN : DIR_UP;
        }
      }

      this.sendPosition(
        player.x,
        player.y,
        directionName(this.currentDirection),
        this.playerActuallyWalking ? "walk" : "idle",
      );
      return;
    }

    // Manual collision check (there are no layer colliders)
    if (hasKeyboardInput) {
      const currentTileX = Math.floor(player.x / TILE_SIZE);
      const currentTileY = Math.floor(player.y / TILE_SIZE);

      let vx = 0;
      let vy = 0;

      // Horizontal move (walkable and no NPC/player)
      if (left) {
        const checkX = Math.floor((player.x - 12) / TILE_SIZE);
        if (this.isWalkable(checkX, currentTileY)) vx = -PLAYER_SPEED;
      } else if (right) {
        const checkX = Math.floor((player.x + 12) / TILE_SIZE);
        if (this.isWalkable(checkX, currentTileY)) vx = PLAYER_SPEED;
      }

      // Vertical move
      if (up) {
        const checkY = Math.floor((player.y - 12) / TILE_SIZE);
        if (this.isWalkable(currentTileX, checkY)) vy = -PLAYER_SPEED;
      } else if (down) {
        const checkY = Math.floor((player.y + 12) / TILE_SIZE);
        if (this.isWalkable(currentTileX, checkY)) vy = PLAYER_SPEED;
      }

      if (vx !== 0 && vy !== 0) {
        const factor = Math.SQRT1_2;
        vx *= factor;
        vy *= factor;
      }

      const dt = Math.min(this.delta, 100) / 1000;
      if (
        !clearMovementSegment(
          { x: player.x / TILE_SIZE - 0.5, y: player.y / TILE_SIZE - 0.5 },
          {
            x: (player.x + vx * dt) / TILE_SIZE - 0.5,
            y: (player.y + vy * dt) / TILE_SIZE - 0.5,
          },
          (x, y) => this.isWalkable(x, y),
        ) ||
        !clearActors(
          { x: player.x / TILE_SIZE - 0.5, y: player.y / TILE_SIZE - 0.5 },
          {
            x: (player.x + vx * dt) / TILE_SIZE - 0.5,
            y: (player.y + vy * dt) / TILE_SIZE - 0.5,
          },
          this.trafficActors().filter((actor) => actor.id !== "player:local"),
        )
      ) {
        vx = 0;
        vy = 0;
      }
      this.playerActuallyWalking = this.commitPlayerStep({
        x: player.x + vx * dt,
        y: player.y + vy * dt,
      });

      if (vx !== 0 || vy !== 0) {
        if (Math.abs(vx) >= Math.abs(vy)) {
          this.currentDirection = vx < 0 ? DIR_LEFT : DIR_RIGHT;
        } else {
          this.currentDirection = vy < 0 ? DIR_UP : DIR_DOWN;
        }
        this.sendPosition(player.x, player.y, directionName(this.currentDirection), "walk");
      } else {
        this.sendPosition(player.x, player.y, directionName(this.currentDirection), "idle");
      }
    } else {
      this.sendPosition(player.x, player.y, directionName(this.currentDirection), "idle");
    }
  }
}
