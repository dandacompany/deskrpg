"use client";
import { useEffect, useRef, useState } from "react";
import { OfficeRenderer } from "@/game/three/office-renderer";
import {
  OFFICE_ENVIRONMENTS,
  buildOfficeEnvironment,
  type OfficeEnvironmentId,
} from "@/game/three/office-environments";
import { OFFICE_ROOMS } from "@/game/three/office-room-layout";
import { roomLabel } from "@/game/three/room-labels";
import { tiledSnapshot } from "@/game/three/tiled-preview";
import { OFFICE_LOOKS, officeLookAppearance } from "@/game/three/office-looks";
import { furnitureSeats } from "@/game/three/seating";
import { findPath, clearSegment } from "@/game/navigation";
import type { ActorSnapshot, OfficeBridge } from "@/game/three/bridge";
import type { BenchmarkReport, FrameMetrics } from "@/game/three/frame-benchmark";
import "@/game/three/office.css";

import {
  studioReviewRooms,
  studioReviewSeatIndices,
  createReviewWalk,
  sampleReviewWalk,
} from "@/game/three/studio-review";

type SceneMode = "overview" | "close" | "moving";
const SCENES: SceneMode[] = ["overview", "close", "moving"];
type MatrixResult = {
  index: number;
  environment: OfficeEnvironmentId;
  scene: SceneMode;
  status: BenchmarkReport["status"];
  reason?: string;
  frameCount: number;
  captureMs: number;
  medianFps: number | null;
  averageFps: number | null;
  p95FrameMs: number | null;
  maxFrameMs: number | null;
  drawCallsMax: number;
  trianglesMax: number;
  viewport: FrameMetrics["viewport"] | undefined;
};
type MatrixProgress = {
  status: "running" | "complete" | "invalid";
  index: number;
  total: number;
  environment: OfficeEnvironmentId;
  scene: SceneMode;
  reason?: string;
  results: MatrixResult[];
};
function makeFixture(id: OfficeEnvironmentId) {
  const map = tiledSnapshot(buildOfficeEnvironment(id));
  const blocked = new Set(map.blocked);
  const walkable = (x: number, y: number) =>
    x >= 1 && x < map.cols - 1 && y >= 1 && y < map.rows - 1 && !blocked.has(`${x},${y}`);
  const seats = furnitureSeats(map.objects);
  const actors: ActorSnapshot[] = Array.from({ length: 12 }, (_, i) => {
    const seat = seats[id === "agency" ? studioReviewSeatIndices[i] : i % seats.length];
    return {
      id: `fixture-${i}`,
      name: i < 10 ? `NPC fixture ${i + 1}` : `Player fixture ${i - 9}`,
      kind: i < 10 ? "npc" : i === 10 ? "player" : "remote",
      x: (seat.anchorX ?? seat.x) * 32,
      y: (seat.anchorZ ?? seat.z) * 32,
      direction: seat.direction,
      walking: false,
      appearance: officeLookAppearance(OFFICE_LOOKS[i].id),
      bubble: i < 10 ? "Renderer check bubble" : undefined,
    };
  });
  const routes = actors.slice(0, 10).map((actor) => {
    const x = actor.x / 32 - 0.5,
      y = actor.y / 32 - 0.5;
    const path = findPath(x, y, Math.floor(map.cols / 2), map.rows - 3, walkable, (a, b) =>
      clearSegment(a, b, walkable),
    );
    if (!path) throw new Error(`No fixture path for ${actor.id}`);
    const roundTrip = [...path, ...path.slice(0, -1).reverse()];
    const lengths = roundTrip
      .slice(1)
      .map((p, i) => Math.hypot(p.x - roundTrip[i].x, p.y - roundTrip[i].y));
    return { points: roundTrip, lengths, total: lengths.reduce((a, b) => a + b, 0) };
  });
  return { map, walkable, actors, routes };
}
function moveFixture(fixture: ReturnType<typeof makeFixture>, seconds: number) {
  return fixture.actors.map((actor, index) => {
    const route = fixture.routes[index];
    if (!route || !route.total) return actor;
    let distance = (seconds * 1.6 + index * 0.7) % route.total;
    let segment = 0;
    while (segment < route.lengths.length - 1 && distance > route.lengths[segment])
      distance -= route.lengths[segment++];
    const a = route.points[segment],
      b = route.points[segment + 1];
    const progress = distance / Math.max(0.0001, route.lengths[segment]);
    return {
      ...actor,
      x: (a.x + (b.x - a.x) * progress + 0.5) * 32,
      y: (a.y + (b.y - a.y) * progress + 0.5) * 32,
      walking: true,
    };
  });
}

export default function ReviewClient() {
  const host = useRef<HTMLDivElement>(null),
    labels = useRef<HTMLDivElement>(null);
  const renderer = useRef<OfficeRenderer | null>(null);
  const runtime = useRef<{
    id: OfficeEnvironmentId;
    mode: SceneMode;
    generation: number;
    fixture: ReturnType<typeof makeFixture>;
  } | null>(null);
  const mounted = useRef(false);
  const matrixAbort = useRef<AbortController | null>(null);
  const [smallViewport, setSmallViewport] = useState(false);
  const [referenceViewport, setReferenceViewport] = useState(false);
  const playerWalk = useRef<{
    route: NonNullable<ReturnType<typeof createReviewWalk>>;
    start: number;
  } | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [matrix, setMatrix] = useState<MatrixProgress | null>(null);
  const [environment, setEnvironment] = useState<OfficeEnvironmentId>("publishing");
  const [mode, setMode] = useState<SceneMode>("overview");
  const [auditRoom, setAuditRoom] = useState<string>("");
  const [metrics, setMetrics] = useState<FrameMetrics | null>(null);
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState("Preparing renderer");
  const [report, setReport] = useState<unknown>(null);

  const frameRoom = (id: OfficeEnvironmentId, roomId: string) => {
    if (id === "agency") {
      const room = studioReviewRooms.find((r) => r.id === roomId);
      if (room) renderer.current?.showRoom(room.x, room.z, room.distance);
      else renderer.current?.showOverview();
      return;
    }
    const room = (OFFICE_ROOMS[id] ?? []).find((room) => room.id === roomId);
    if (!room) {
      renderer.current?.showOverview();
      return;
    }
    renderer.current?.showRoom(room.x + room.width / 2, room.z + room.depth / 2, 14);
  };
  const frameCamera = (id: OfficeEnvironmentId, scene: SceneMode) => {
    // Benchmark close scenes always use the meeting room, independent of the visual audit.
    if (scene === "close") frameRoom(id, "meeting");
    else renderer.current?.showOverview();
  };
  const resetAuditCamera = () => {
    setAuditRoom("");
    if (runtime.current) frameCamera(runtime.current.id, runtime.current.mode);
  };
  const selectEnvironment = (id: OfficeEnvironmentId, updateCamera = true) => {
    const current = runtime.current;
    if (!current) return;
    current.id = id;
    current.fixture = makeFixture(id);
    playerWalk.current = null;
    current.generation++;
    setEnvironment(id);
    if (updateCamera) frameCamera(id, current.mode);
  };
  useEffect(() => {
    mounted.current = true;
    runtime.current = {
      id: "publishing",
      mode: "overview",
      generation: 0,
      fixture: makeFixture("publishing"),
    };
    const instance = new OfficeRenderer(host.current!, labels.current!);
    renderer.current = instance;
    const bridge: OfficeBridge = {
      actors: () => {
        const r = runtime.current!;
        if (playerWalk.current) {
          r.fixture.actors[10] = sampleReviewWalk(
            playerWalk.current.route,
            (performance.now() - playerWalk.current.start) / 1000,
          );
          if (!r.fixture.actors[10].walking) playerWalk.current = null;
        }
        return r.mode === "moving"
          ? moveFixture(r.fixture, performance.now() / 1000)
          : r.fixture.actors;
      },
      mapKey: () => `${runtime.current!.id}:${runtime.current!.generation}`,
      map: () => runtime.current!.fixture.map,
      walkable: (x, y) => runtime.current!.fixture.walkable(x, y),
      editor: () => ({ placement: false, spawn: false, owner: false, tiled: true, seatLabels: [] }),
      pointer: (kind, x, y, button, _sx, _sy, actorId) => {
        const r = runtime.current!;
        if (
          kind !== "down" ||
          button !== 0 ||
          r.mode === "moving" ||
          (actorId && actorId !== "seat-target")
        )
          return;
        const now = performance.now();
        const current = playerWalk.current
          ? sampleReviewWalk(playerWalk.current.route, (now - playerWalk.current.start) / 1000)
          : r.fixture.actors[10];
        const route = createReviewWalk(current, x, y, r.fixture.walkable);
        if (route) {
          r.fixture.actors[10] = sampleReviewWalk(route, 0);
          playerWalk.current = { route, start: now };
        }
      },
      setPresentation: () => {},
    };
    instance.attach(bridge);
    instance.showOverview();
    const timer = window.setInterval(() => setMetrics(instance.readMetrics()), 500);
    setStatus("Check readiness, then start measuring.");
    return () => {
      mounted.current = false;
      matrixAbort.current?.abort("Review unmounted");
      clearInterval(timer);
      instance.dispose();
      renderer.current = null;
    };
  }, []);
  const metadata = () => ({
    fixture: "renderer fixture only; not real AI or multiplayer proof",
    environment: runtime.current?.id,
    scene: runtime.current?.mode,
    npcCount: 10,
    playerFixtureCount: 2,
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    capturedAt: new Date().toISOString(),
    containerFixture: smallViewport
      ? "390x600 CSS pixels; not browser viewport or product mobile proof"
      : "responsive renderer container",
    browserViewport: { width: window.innerWidth, height: window.innerHeight },
    rendererContainer: { width: host.current?.clientWidth, height: host.current?.clientHeight },
  });
  const benchmark = () => {
    resetAuditCamera();
    setMatrix(null);
    const context = metadata();
    setBusy(true);
    setReport(null);
    setStatus("10 s warm-up + 30 s measurement. Keep the tab and window size unchanged.");
    try {
      renderer.current!.startBenchmark((result) => {
        if (!mounted.current) return;
        setReport({ ...context, benchmark: result });
        setBusy(false);
        setStatus(
          result.status === "complete"
            ? "Measurement complete"
            : `Measurement invalid: ${result.reason}`,
        );
      });
    } catch (error) {
      setBusy(false);
      setStatus(String(error));
    }
  };
  const benchmarkMatrix = async () => {
    if (matrixAbort.current || !renderer.current || !runtime.current) return;
    resetAuditCamera();
    const controller = new AbortController();
    matrixAbort.current = controller;
    const context = metadata();
    const raw: Array<{
      index: number;
      environment: OfficeEnvironmentId;
      scene: SceneMode;
      benchmark: BenchmarkReport;
    }> = [];
    let progress: MatrixProgress = {
      status: "running",
      index: 0,
      total: OFFICE_ENVIRONMENTS.length * SCENES.length,
      environment: runtime.current.id,
      scene: runtime.current.mode,
      results: [],
    };
    const initial = {
      width: host.current!.clientWidth,
      height: host.current!.clientHeight,
      browserWidth: window.innerWidth,
      browserHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
    };
    let capturing = false;
    const cancel = (reason: string) => {
      if (!controller.signal.aborted) controller.abort(reason);
      renderer.current?.cancelBenchmark(reason);
    };
    const guard = () => {
      if (!mounted.current || !renderer.current || !host.current)
        throw new Error("Renderer became unavailable");
      if (controller.signal.aborted) throw new Error(String(controller.signal.reason));
      if (document.hidden) throw new Error("Document became hidden");
      if (
        host.current.clientWidth !== initial.width ||
        host.current.clientHeight !== initial.height ||
        window.innerWidth !== initial.browserWidth ||
        window.innerHeight !== initial.browserHeight ||
        window.devicePixelRatio !== initial.dpr
      )
        throw new Error("Viewport, renderer container or device pixel ratio changed");
      if (capturing && !renderer.current.readMetrics().assetsReady)
        throw new Error("Actor assets or map became unavailable");
    };
    const monitor = () => {
      try {
        guard();
      } catch (error) {
        cancel(String(error));
      }
    };
    const visibility = () => {
      if (document.hidden) cancel("Document became hidden");
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("resize", monitor);
    const monitorTimer = window.setInterval(monitor, 100);
    const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
    setBusy(true);
    setReport(null);
    setMatrix(progress);
    try {
      guard();
      for (const entry of OFFICE_ENVIRONMENTS) {
        for (const scene of SCENES) {
          guard();
          progress = { ...progress, index: raw.length + 1, environment: entry.id, scene };
          setMatrix(progress);
          setStatus(
            `All ${progress.index}/${progress.total} · ${entry.nameEn} / ${scene} · waiting for assets`,
          );
          // Wait for the new map generation, rather than accepting the previous map's ready flag.
          selectEnvironment(entry.id, false);
          runtime.current!.mode = scene;
          setMode(scene);
          const mapKey = `${entry.id}:${runtime.current!.generation}`;
          const started = performance.now();
          while (true) {
            guard();
            const current = renderer.current!.readMetrics();
            if (current.mapKey === mapKey && current.assetsReady) break;
            if (performance.now() - started > 30000) throw new Error("Asset/map readiness timeout");
            await wait(100);
          }
          frameCamera(entry.id, scene);
          await wait(100);
          guard();
          capturing = true;
          setStatus(
            `All ${progress.index}/${progress.total} · ${entry.nameEn} / ${scene} · 10 s warm-up + 30 s measurement`,
          );
          const result = await new Promise<BenchmarkReport>((resolve) =>
            renderer.current!.startBenchmark(resolve),
          );
          capturing = false;
          if (!mounted.current) throw new Error("Review unmounted");
          raw.push({ index: progress.index, environment: entry.id, scene, benchmark: result });
          const summary: MatrixResult = {
            index: progress.index,
            environment: entry.id,
            scene,
            status: result.status,
            ...(result.reason ? { reason: result.reason } : {}),
            frameCount: result.frameCount,
            captureMs: result.captureMs,
            medianFps: result.medianFps,
            averageFps: result.averageFps,
            p95FrameMs: result.p95FrameMs,
            maxFrameMs: result.maxFrameMs,
            drawCallsMax: result.drawCallsMax,
            trianglesMax: result.trianglesMax,
            viewport: result.end?.viewport,
          };
          progress = { ...progress, results: [...progress.results, summary] };
          setMatrix(progress);
          if (result.status !== "complete") throw new Error(result.reason ?? "Benchmark invalid");
          guard();
        }
      }
      guard();
      progress = { ...progress, status: "complete" };
      setMatrix(progress);
      setReport({ ...context, matrixStatus: "complete", results: raw });
      setStatus(`All ${progress.total} scenes measured · expand the full frame JSON below.`);
    } catch (error) {
      cancel(String(error));
      if (mounted.current) {
        progress = { ...progress, status: "invalid", reason: String(error) };
        setMatrix(progress);
        setReport({
          ...context,
          matrixStatus: "invalid",
          reason: String(error),
          results: progress.results,
        });
        setStatus(
          `Full run stopped · ${progress.results.filter((result) => result.status === "complete").length}/${progress.total} scenes valid · ${String(error)}`,
        );
      }
    } finally {
      clearInterval(monitorTimer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("resize", monitor);
      matrixAbort.current = null;
      if (mounted.current) setBusy(false);
    }
  };
  const transitions = async () => {
    resetAuditCamera();
    setMatrix(null);
    const original = runtime.current!.id;
    const context = metadata();
    const samples: { step: number; environment: string; metrics: FrameMetrics }[] = [];
    let hidden = document.hidden;
    const visibility = () => {
      if (document.hidden) hidden = true;
    };
    document.addEventListener("visibilitychange", visibility);
    setBusy(true);
    setReport(null);
    const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
    const settle = async () => {
      const started = performance.now();
      while (true) {
        if (!mounted.current) throw new Error("Review unmounted");
        if (hidden) throw new Error("Document became hidden");
        if (renderer.current!.readMetrics().assetsReady) break;
        if (performance.now() - started > 30_000) throw new Error("Asset/map readiness timeout");
        await wait(100);
      }
      await wait(2000);
      if (hidden) throw new Error("Document became hidden");
      if (!mounted.current || !renderer.current?.readMetrics().assetsReady)
        throw new Error("Renderer became unavailable");
      return renderer.current.readMetrics();
    };
    try {
      samples.push({ step: 0, environment: original, metrics: await settle() });
      const startIndex = OFFICE_ENVIRONMENTS.findIndex((entry) => entry.id === original);
      for (let step = 1; step <= 10; step++) {
        const id = OFFICE_ENVIRONMENTS[(startIndex + step) % OFFICE_ENVIRONMENTS.length].id;
        setStatus(`Live renderer map switch ${step}/10 · ${id}`);
        selectEnvironment(id);
        samples.push({ step, environment: id, metrics: await settle() });
      }
      const deltas = samples.slice(6).map((sample) => {
        const earlier = samples[sample.step - 5];
        return {
          environment: sample.environment,
          geometryDelta: sample.metrics.geometries - earlier.metrics.geometries,
          textureDelta: sample.metrics.textures - earlier.metrics.textures,
        };
      });
      setReport({
        ...context,
        transitionStatus: "complete",
        samples,
        sameMapSecondCycleDeltas: deltas,
        note: "Inspect same-map cycles for sustained growth; cache warm-up can establish a bounded plateau.",
      });
      setStatus("10 switches done · back to the original environment");
    } catch (error) {
      if (mounted.current) {
        setReport({ ...context, transitionStatus: "invalid", reason: String(error), samples });
        setStatus(String(error));
      }
    } finally {
      document.removeEventListener("visibilitychange", visibility);
      if (mounted.current) {
        if (runtime.current!.id !== original) selectEnvironment(original);
        setBusy(false);
      }
    }
  };
  return (
    <main style={{ padding: 16, background: "#f7f2e6", color: "#1a1a1a" }}>
      <h1>UI2 renderer review (development)</h1>
      <p>
        Renderer fixture: 10 NPCs + 2 player models. Not evidence of real AI replies or multiplayer.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
        <label>
          Environment{" "}
          <select
            aria-label="Environment"
            value={environment}
            disabled={busy}
            onChange={(e) => {
              const id = e.target.value as OfficeEnvironmentId;
              selectEnvironment(id, !auditRoom);
              if (auditRoom) frameRoom(id, auditRoom);
            }}
          >
            {OFFICE_ENVIRONMENTS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.nameEn}
              </option>
            ))}
          </select>
        </label>
        <label>
          Scene{" "}
          <select
            aria-label="Scene"
            value={mode}
            disabled={busy}
            onChange={(e) => {
              const next = e.target.value as SceneMode;
              runtime.current!.mode = next;
              setMode(next);
              setAuditRoom("");
              frameCamera(environment, next);
            }}
          >
            <option value="overview">Overview</option>
            <option value="close">Meeting room close-up</option>
            <option value="moving">10 NPCs moving with bubbles</option>
          </select>
        </label>
        <label>
          Room inspection{" "}
          <select
            aria-label="Room inspection"
            value={auditRoom}
            disabled={busy}
            onChange={(e) => {
              const roomId = e.target.value;
              setAuditRoom(roomId);
              if (roomId) frameRoom(environment, roomId);
              else frameCamera(environment, mode);
            }}
          >
            <option value="">Restore scene camera</option>
            {(environment === "agency" ? studioReviewRooms : (OFFICE_ROOMS[environment] ?? [])).map(
              (room) => (
                <option key={room.id} value={room.id}>
                  {roomLabel(room.label, "en")} close-up
                </option>
              ),
            )}
          </select>
        </label>
        <button
          disabled={busy}
          aria-pressed={referenceViewport}
          onClick={() => {
            setReferenceViewport((v) => !v);
            setSmallViewport(false);
            selectEnvironment("agency");
            setTimeout(() => renderer.current?.showOverview(), 100);
          }}
        >
          Creative studio reference 1748×900
        </button>
        <button disabled={busy || !metrics?.assetsReady || !showLabels} onClick={benchmark}>
          Measure performance
        </button>
        <button disabled={busy || !metrics?.assetsReady || !showLabels} onClick={benchmarkMatrix}>
          Measure all 15 scenes
        </button>
        {matrixAbort.current && (
          <button
            onClick={() => {
              matrixAbort.current?.abort("Cancelled by user");
              renderer.current?.cancelBenchmark("Cancelled by user");
            }}
          >
            Stop full run
          </button>
        )}
        <button
          disabled={busy}
          aria-pressed={smallViewport}
          onClick={() => {
            setSmallViewport((value) => !value);
            setReferenceViewport(false);
            setStatus("Renderer container resized. Check readiness and the measured size.");
          }}
        >
          {smallViewport ? "Restore default size" : "Small screen 390px"}
        </button>
        <button
          disabled={busy}
          aria-pressed={showLabels}
          onClick={() => setShowLabels((value) => !value)}
        >
          {showLabels ? "Hide names and bubbles" : "Show names and bubbles"}
        </button>
        <button disabled={busy || !metrics?.assetsReady} onClick={transitions}>
          Switch maps 10 times
        </button>
        <button disabled={busy} onClick={() => renderer.current?.rotateCamera(2)}>
          Rotate 90°
        </button>
        <button disabled={busy} onClick={() => renderer.current?.zoom(0.8)}>
          Zoom in
        </button>
        <button disabled={busy} onClick={() => renderer.current?.zoom(1.25)}>
          Zoom out
        </button>
      </div>
      <p role="status">{status}</p>
      <p>
        Room inspection keeps showing the selected room when the environment changes. Measuring or
        switching maps restores the scene camera; the close-up scene is always the meeting room.
      </p>
      <p>
        The full run measures 5 environments × 3 scenes in order and takes 10+ minutes. Hiding the
        tab, resizing, an asset error or stopping skips the remaining scenes and keeps only the
        reason and the finished results.
      </p>
      <p>
        The small-screen fixture only sizes the renderer container to 390×600 CSS px. It is not a
        Chrome viewport change or a mobile check of the product. Current:{" "}
        {smallViewport ? "390×600 CSS px" : "default responsive container"}.
      </p>
      <div
        aria-label="Renderer check area"
        style={{
          position: "relative",
          pointerEvents: busy ? "none" : undefined,
          width: referenceViewport ? 1748 : smallViewport ? 390 : "100%",
          height: referenceViewport ? 900 : smallViewport ? 600 : "min(68vh, 760px)",
          minHeight: smallViewport ? 600 : 400,
        }}
      >
        <div ref={host} className="office-three-canvas" />
        <div
          ref={labels}
          className="office-actor-labels"
          style={{ visibility: showLabels ? "visible" : "hidden" }}
        />
      </div>
      <details open>
        <summary>Live renderer metrics</summary>
        <pre aria-label="Live metrics">{JSON.stringify(metrics, null, 2)}</pre>
      </details>
      {matrix && (
        <section aria-label="All-scene results">
          <p>
            Status: {matrix.status} · {matrix.index}/{matrix.total} · {matrix.environment} /{" "}
            {matrix.scene}
          </p>
          <p>
            Last result:{" "}
            {matrix.results.at(-1)
              ? `${matrix.results.at(-1)!.environment} / ${matrix.results.at(-1)!.scene} · ${matrix.results.at(-1)!.status} · median ${matrix.results.at(-1)!.medianFps?.toFixed(1) ?? "—"} FPS`
              : "none yet"}
          </p>
          <pre
            aria-label="15-scene progress"
            style={{ maxHeight: 400, overflow: "auto", whiteSpace: "pre-wrap" }}
          >
            {JSON.stringify(matrix, null, 2)}
          </pre>
        </section>
      )}
      <details open={!matrix}>
        <summary>
          {matrix?.status === "complete" ? "Full frame results JSON" : "Results JSON"}
        </summary>
        <pre
          aria-label="Results"
          style={{ maxHeight: 500, overflow: "auto", whiteSpace: "pre-wrap" }}
        >
          {JSON.stringify(report, null, 2)}
        </pre>
      </details>
    </main>
  );
}
