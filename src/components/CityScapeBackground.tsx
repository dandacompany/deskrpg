"use client";

import { useEffect, useMemo, useRef } from "react";
import { compositeCharacter } from "@/lib/sprite-compositor";
import { useT } from "@/lib/i18n";
import { createWalkerSpeed, shouldAdvanceWalkerFrame } from "./cityscape-motion";

// Hair variants: blonde, black, chestnut, raven, ginger, platinum, ash, red, sandy
// (NO "brown" — use chestnut/raven instead)
const PRESETS = [
  { bodyType: "male", layers: { body: { itemKey: "body", variant: "light" }, eye_color: { itemKey: "eye_color", variant: "blue" }, hair: { itemKey: "hair_bangsshort", variant: "chestnut" }, clothes: { itemKey: "torso_clothes_tshirt", variant: "blue" }, legs: { itemKey: "legs_pants", variant: "charcoal" }, shoes: { itemKey: "feet_boots_basic", variant: "brown" } } },
  { bodyType: "female", layers: { body: { itemKey: "body", variant: "light" }, eye_color: { itemKey: "eye_color", variant: "blue" }, hair: { itemKey: "hair_bob", variant: "blonde" }, clothes: { itemKey: "torso_clothes_blouse", variant: "white" }, legs: { itemKey: "legs_skirts_plain", variant: "navy" }, shoes: { itemKey: "feet_boots_basic", variant: "brown" } } },
  { bodyType: "male", layers: { body: { itemKey: "body", variant: "olive" }, eye_color: { itemKey: "eye_color", variant: "brown" }, hair: { itemKey: "hair_bangs", variant: "black" }, clothes: { itemKey: "torso_clothes_longsleeve2_buttoned", variant: "white" }, legs: { itemKey: "legs_formal", variant: "charcoal" }, shoes: { itemKey: "feet_boots_basic", variant: "black" } } },
  { bodyType: "female", layers: { body: { itemKey: "body", variant: "bronze" }, eye_color: { itemKey: "eye_color", variant: "green" }, hair: { itemKey: "hair_bangslong", variant: "raven" }, clothes: { itemKey: "torso_clothes_tshirt_scoop", variant: "pink" }, legs: { itemKey: "legs_leggings", variant: "charcoal" }, shoes: { itemKey: "feet_boots_basic", variant: "brown" } } },
  { bodyType: "male", layers: { body: { itemKey: "body", variant: "brown" }, eye_color: { itemKey: "eye_color", variant: "brown" }, hair: { itemKey: "hair_bedhead", variant: "black" }, clothes: { itemKey: "torso_clothes_shortsleeve_polo", variant: "navy" }, legs: { itemKey: "legs_pants2", variant: "gray" }, shoes: { itemKey: "feet_boots_basic", variant: "brown" } } },
  { bodyType: "female", layers: { body: { itemKey: "body", variant: "light" }, eye_color: { itemKey: "eye_color", variant: "blue" }, hair: { itemKey: "hair_bob_side_part", variant: "ginger" }, clothes: { itemKey: "torso_clothes_blouse_longsleeve", variant: "white" }, legs: { itemKey: "legs_skirt_straight", variant: "charcoal" }, shoes: { itemKey: "feet_boots_basic", variant: "black" } } },
  { bodyType: "male", layers: { body: { itemKey: "body", variant: "light" }, eye_color: { itemKey: "eye_color", variant: "blue" }, hair: { itemKey: "hair_bangsshort", variant: "sandy" }, clothes: { itemKey: "torso_clothes_longsleeve", variant: "maroon" }, legs: { itemKey: "legs_pants2", variant: "charcoal" }, shoes: { itemKey: "feet_boots_basic", variant: "brown" } } },
];

const FRAME_W = 64;
const FRAME_H = 64;
const WALK_COLS = 9;
const SCALE = 1.5;

interface Walker {
  sheet: HTMLCanvasElement;
  x: number;
  speed: number;
  direction: number; // 1=left, 3=right in spritesheet row
  frame: number;
}

type CarType = "compact" | "sedan" | "suv" | "truck" | "van";

interface Car {
  x: number;
  speed: number;
  direction: number; // 1=right, -1=left
  color: string;
  type: CarType;
}

const CAR_COLORS = ["#374151", "#1e293b", "#4b5563", "#334155", "#292524", "#3f3f46", "#1c1917", "#27272a"];
const CAR_TYPES: CarType[] = ["compact", "sedan", "suv", "truck", "van"];

function createCar(w: number, direction: number): Car {
  return {
    x: direction === 1 ? -140 : w + 140,
    speed: 2.5 + Math.random() * 2.5,
    direction,
    color: CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)],
    type: CAR_TYPES[Math.floor(Math.random() * CAR_TYPES.length)],
  };
}

function drawCar(ctx: CanvasRenderingContext2D, car: Car, roadY: number) {
  const y = roadY;
  const d = car.direction;
  const c = car.color;

  ctx.save();

  if (car.type === "compact") {
    const w = 70, h = 24;
    ctx.fillStyle = c;
    ctx.fillRect(car.x, y, w, h);
    ctx.fillRect(car.x + w * 0.25, y - 12, w * 0.5, 12);
    ctx.fillStyle = "rgba(147,197,253,0.5)";
    ctx.fillRect(car.x + w * 0.3, y - 10, w * 0.35, 8);
    ctx.fillStyle = "#111";
    ctx.fillRect(car.x + 6, y + h, 14, 8);
    ctx.fillRect(car.x + w - 20, y + h, 14, 8);
    drawLights(ctx, car.x, y, w, h, d);
  } else if (car.type === "sedan") {
    const w = 90, h = 26;
    ctx.fillStyle = c;
    ctx.fillRect(car.x, y, w, h);
    ctx.fillRect(car.x + w * 0.18, y - 14, w * 0.58, 14);
    ctx.fillStyle = "rgba(147,197,253,0.5)";
    ctx.fillRect(car.x + w * 0.22, y - 12, w * 0.2, 9);
    ctx.fillRect(car.x + w * 0.48, y - 12, w * 0.2, 9);
    ctx.fillStyle = "#111";
    ctx.fillRect(car.x + 10, y + h, 16, 8);
    ctx.fillRect(car.x + w - 26, y + h, 16, 8);
    drawLights(ctx, car.x, y, w, h, d);
  } else if (car.type === "suv") {
    const w = 105, h = 30;
    ctx.fillStyle = c;
    ctx.fillRect(car.x, y, w, h);
    ctx.fillRect(car.x + w * 0.15, y - 16, w * 0.65, 16);
    ctx.fillStyle = "rgba(147,197,253,0.5)";
    ctx.fillRect(car.x + w * 0.2, y - 14, w * 0.18, 10);
    ctx.fillRect(car.x + w * 0.42, y - 14, w * 0.18, 10);
    ctx.fillRect(car.x + w * 0.64, y - 14, w * 0.1, 10);
    ctx.fillStyle = "#111";
    ctx.fillRect(car.x + 12, y + h, 18, 10);
    ctx.fillRect(car.x + w - 30, y + h, 18, 10);
    drawLights(ctx, car.x, y, w, h, d);
  } else if (car.type === "truck") {
    const w = 160, h = 36;
    const cabW = w * 0.28;
    const cabX = d === 1 ? car.x + w - cabW : car.x;
    ctx.fillStyle = c;
    ctx.fillRect(cabX, y, cabW, h);
    ctx.fillRect(cabX + cabW * 0.1, y - 16, cabW * 0.8, 16);
    ctx.fillStyle = "rgba(147,197,253,0.5)";
    ctx.fillRect(cabX + cabW * 0.15, y - 14, cabW * 0.6, 10);
    const cargoX = d === 1 ? car.x : car.x + cabW + 3;
    const cargoW = w - cabW - 3;
    ctx.fillStyle = "#334155";
    ctx.fillRect(cargoX, y - 10, cargoW, h + 10);
    ctx.strokeStyle = "#1e293b";
    ctx.strokeRect(cargoX, y - 10, cargoW, h + 10);
    ctx.fillStyle = "#111";
    ctx.fillRect(car.x + 12, y + h, 18, 10);
    ctx.fillRect(car.x + w * 0.42, y + h, 18, 10);
    ctx.fillRect(car.x + w - 30, y + h, 18, 10);
    drawLights(ctx, car.x, y, w, h, d);
  } else {
    const w = 100, h = 32;
    ctx.fillStyle = c;
    ctx.fillRect(car.x, y, w, h);
    const roofX = d === 1 ? car.x + w * 0.55 : car.x;
    ctx.fillRect(roofX, y - 14, w * 0.4, 14);
    ctx.fillStyle = "rgba(147,197,253,0.5)";
    ctx.fillRect(roofX + 4, y - 12, w * 0.3, 9);
    const cargoX2 = d === 1 ? car.x : car.x + w * 0.45;
    ctx.fillStyle = c;
    ctx.fillRect(cargoX2, y - 10, w * 0.52, 10);
    ctx.fillStyle = "#111";
    ctx.fillRect(car.x + 10, y + h, 16, 8);
    ctx.fillRect(car.x + w - 26, y + h, 16, 8);
    drawLights(ctx, car.x, y, w, h, d);
  }

  ctx.restore();
}

function drawLights(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, d: number) {
  const frontX = d === 1 ? x + w - 3 : x;
  ctx.fillStyle = "#fef3c7";
  ctx.fillRect(frontX, y + 3, 4, 6);
  ctx.fillRect(frontX, y + h - 9, 4, 6);
  const tailX = d === 1 ? x : x + w - 4;
  ctx.fillStyle = "#dc2626";
  ctx.fillRect(tailX, y + 3, 4, 5);
  ctx.fillRect(tailX, y + h - 8, 4, 5);
}

// Pre-generate stable window data so re-renders don't randomize them
interface WindowCell { on: boolean; opacity: string; delay: string; }
function generateWindows(cols: number, rows: number, baseOffChance: number): WindowCell[] {
  const cells: WindowCell[] = [];
  for (let r = 0; r < rows; r++) {
    // Top floors: some lights, bottom floors: nearly all dark
    const rowRatio = r / rows; // 0 = top, 1 = bottom
    const offChance = baseOffChance + rowRatio * rowRatio * 0.5; // quadratic dropoff
    for (let c = 0; c < cols; c++) {
      const on = Math.random() > offChance;
      cells.push({
        on,
        opacity: on ? (Math.random() * 0.5 + 0.2).toFixed(2) : "0",
        delay: (Math.random() * 20).toFixed(1),
      });
    }
  }
  return cells;
}

export default function CityScapeBackground() {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const walkersRef = useRef<Walker[]>([]);
  const carsRef = useRef<Car[]>([]);
  const readyRef = useRef(false);

  // Stable window data — computed once
  const midWindows = useMemo(() => [
    generateWindows(48, 56, 0.92), generateWindows(56, 32, 0.92),
    generateWindows(32, 48, 0.92), generateWindows(40, 56, 0.92),
    generateWindows(44, 52, 0.92), generateWindows(28, 56, 0.92),
  ], []);
  const nearWindows = useMemo(() => [
    generateWindows(64, 48, 0.88), generateWindows(52, 40, 0.88), generateWindows(72, 44, 0.88),
  ], []);

  useEffect(() => {
    const walkers: Walker[] = [];

    Promise.all(
      PRESETS.map(async (preset, i) => {
        const offscreen = document.createElement("canvas");
        await compositeCharacter(offscreen, preset);
        const dir = i % 2 === 0 ? 3 : 1;
        walkers.push({
          sheet: offscreen,
          x: Math.random() * window.innerWidth,
          speed: createWalkerSpeed(Math.random()),
          direction: dir,
          frame: Math.floor(Math.random() * WALK_COLS),
        });
      })
    ).then(() => {
      walkersRef.current = walkers;
      readyRef.current = true;
    });

    // Initialize cars
    const w = window.innerWidth;
    carsRef.current = [
      createCar(w, 1),
      createCar(w, -1),
      { ...createCar(w, 1), x: w * 0.3 },
    ];

    let animId = 0;
    let frameCount = 0;

    const animate = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const w = canvas.width;
      const h = canvas.height;

      const groundTop = h * 0.82;
      const sidewalkY = groundTop + (h * 0.18 * 0.35);
      const charY = sidewalkY - FRAME_H * SCALE + 4;
      const roadY = groundTop + (h * 0.18 * 0.58);

      ctx.clearRect(0, 0, w, h);

      // Draw cars (on road, below characters)
      for (const car of carsRef.current) {
        car.x += car.speed * car.direction;
        // Reset when off screen
        if (car.direction === 1 && car.x > w + 150) {
          Object.assign(car, createCar(w, 1));
        } else if (car.direction === -1 && car.x < -150) {
          Object.assign(car, createCar(w, -1));
        }
        drawCar(ctx, car, roadY);
      }

      // Randomly spawn new car
      if (frameCount % 300 === 0 && carsRef.current.length < 5) {
        carsRef.current.push(createCar(w, Math.random() > 0.5 ? 1 : -1));
      }

      if (readyRef.current) {
        // Advance the walk cycle more slowly so pedestrians feel less frantic.
        if (shouldAdvanceWalkerFrame(frameCount)) {
          for (const walker of walkersRef.current) {
            walker.frame = (walker.frame + 1) % WALK_COLS;
          }
        }

        for (const walker of walkersRef.current) {
          if (walker.direction === 3) {
            walker.x += walker.speed;
            if (walker.x > w + 100) walker.x = -FRAME_W * SCALE - 50;
          } else {
            walker.x -= walker.speed;
            if (walker.x < -FRAME_W * SCALE - 100) walker.x = w + 50;
          }

          ctx.drawImage(
            walker.sheet,
            walker.frame * FRAME_W,
            walker.direction * FRAME_H,
            FRAME_W,
            FRAME_H,
            walker.x,
            charY,
            FRAME_W * SCALE,
            FRAME_H * SCALE,
          );
        }
      }

      frameCount++;
      animId = requestAnimationFrame(animate);
    };

    animId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animId);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ background: "linear-gradient(180deg,#030712 0%,#0a1128 30%,#111d3a 60%,#162040 100%)" }}>
      {/* Stars */}
      <div className="absolute inset-0">
        {[
          { top: "3%", left: "5%", size: 1.5, delay: 0 },
          { top: "7%", left: "15%", size: 1, delay: 1 },
          { top: "2%", left: "28%", size: 2, delay: 0.5 },
          { top: "8%", left: "42%", size: 1, delay: 2 },
          { top: "4%", left: "58%", size: 1.5, delay: 1.5 },
          { top: "7%", left: "72%", size: 1, delay: 0.8 },
          { top: "10%", left: "85%", size: 1, delay: 2.5 },
          { top: "1%", left: "92%", size: 2, delay: 1.2 },
          { top: "12%", left: "36%", size: 1, delay: 3 },
          { top: "5%", left: "50%", size: 1, delay: 0.3 },
        ].map((s, i) => (
          <div
            key={i}
            className="absolute rounded-full bg-white animate-twinkle"
            style={{ top: s.top, left: s.left, width: s.size, height: s.size, animationDelay: `${s.delay}s` }}
          />
        ))}
      </div>

      {/* Moon */}
      <div
        className="absolute"
        style={{
          top: "6vh", right: "12vw", width: 28, height: 28,
          background: "radial-gradient(circle,#fef9e7 0%,#fde68a 50%,transparent 100%)",
          borderRadius: "50%",
          boxShadow: "0 0 50px rgba(253,230,138,0.15),0 0 100px rgba(253,230,138,0.06)",
        }}
      />

      {/* Buildings - Far layer */}
      <div className="absolute left-0 right-0" style={{ bottom: "18%" }}>
        {[
          { left: "0%", width: "6vw", height: "32vh", beacon: false },
          { left: "7vw", width: "5vw", height: "38vh", beacon: true },
          { left: "14vw", width: "7vw", height: "28vh", beacon: false },
          { left: "23vw", width: "4vw", height: "35vh", beacon: false },
          { left: "34vw", width: "5vw", height: "30vh", beacon: false },
          { left: "48vw", width: "6vw", height: "36vh", beacon: true },
          { left: "56vw", width: "4vw", height: "26vh", beacon: false },
          { left: "68vw", width: "5vw", height: "33vh", beacon: false },
          { left: "78vw", width: "7vw", height: "38vh", beacon: true },
          { left: "87vw", width: "5vw", height: "28vh", beacon: false },
          { left: "94vw", width: "6vw", height: "34vh", beacon: false },
        ].map((b, i) => (
          <div key={i} className="absolute bottom-0 rounded-t-sm" style={{ left: b.left, width: b.width, height: b.height, background: "#060b18" }}>
            {b.beacon && (
              <div className="absolute -top-2.5 left-1/2 -translate-x-1/2">
                <div className="w-0.5 h-2 bg-gray-800 mx-auto" />
                <div className="w-1 h-1 rounded-full bg-red-500 mx-auto animate-beacon" />
              </div>
            )}
          </div>
        ))}

        {/* Church building */}
        <div className="absolute bottom-0" style={{ left: "42vw", width: "5vw", height: "25vh", background: "#080d1a" }}>
          {/* Steeple (pointed roof) */}
          <div style={{
            position: "absolute",
            top: -20,
            left: "50%",
            transform: "translateX(-50%)",
            width: 0,
            height: 0,
            borderLeft: "12px solid transparent",
            borderRight: "12px solid transparent",
            borderBottom: "20px solid #080d1a",
          }} />
          {/* Cross */}
          <div style={{
            position: "absolute",
            top: -36,
            left: "50%",
            transform: "translateX(-50%)",
          }}>
            <div style={{ width: 2, height: 14, background: "#fbbf24", margin: "0 auto", boxShadow: "0 0 6px rgba(251,191,36,0.4)" }} />
            <div style={{ width: 10, height: 2, background: "#fbbf24", position: "absolute", top: 3, left: -4, boxShadow: "0 0 6px rgba(251,191,36,0.4)" }} />
          </div>
          {/* Round window */}
          <div style={{
            position: "absolute",
            top: 8,
            left: "50%",
            transform: "translateX(-50%)",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "rgba(251,191,36,0.3)",
            boxShadow: "0 0 6px rgba(251,191,36,0.2)",
          }} />
        </div>
      </div>

      {/* Buildings - Mid layer (with billboard on wall) */}
      <div className="absolute left-0 right-0" style={{ bottom: "18%" }}>
        {[
          { left: "1vw", width: "12vw", height: "24vh", color: "warm", billboard: false, cols: 48, rows: 56 },
          { left: "15vw", width: "14vw", height: "28vh", color: "cool", billboard: true, cols: 56, rows: 32 },
          { left: "40vw", width: "8vw", height: "22vh", color: "warm", billboard: false, cols: 32, rows: 48 },
          { left: "60vw", width: "9vw", height: "26vh", color: "purple", billboard: false, cols: 40, rows: 56 },
          { right: "1vw", width: "11vw", height: "23vh", color: "warm", billboard: false, cols: 44, rows: 52 },
          { right: "14vw", width: "7vw", height: "25vh", color: "cool", billboard: false, cols: 28, rows: 56 },
        ].map((b, i) => {
          const windowColor = b.color === "cool" ? "rgba(255,241,200," : b.color === "purple" ? "rgba(255,255,235," : "rgba(251,191,36,";
          return (
            <div
              key={i}
              className="absolute bottom-0 rounded-t-sm overflow-hidden"
              style={{
                ...(b.left ? { left: b.left } : { right: b.right }),
                width: b.width, height: b.height,
                background: "#0a1020", border: "1px solid #131c30", borderBottom: "none",
              }}
            >
              {b.billboard && (
                <div
                  className="absolute overflow-hidden"
                  style={{
                    top: "12%", left: "6%", right: "6%", height: "28%",
                    background: "#0a0f1e", border: "2px solid #1e293b", borderRadius: 2,
                    boxShadow: "0 0 20px rgba(99,102,241,0.2),0 2px 8px rgba(0,0,0,0.5)",
                  }}
                >
                  <div className="w-full h-full flex flex-col items-center justify-center animate-screen-shift relative"
                    style={{ background: "linear-gradient(135deg,#1e1b4b,#312e81,#4338ca)" }}>
                    <div className="text-[clamp(8px,1.2vw,14px)] font-black text-indigo-200 font-mono tracking-widest" style={{ textShadow: "0 0 8px rgba(199,210,254,0.5)" }}>
                      DeskRPG
                    </div>
                    <div className="text-[clamp(4px,0.5vw,7px)] text-indigo-400 tracking-widest">{t("auth.subtitle")}</div>
                    <div className="absolute inset-0 pointer-events-none" style={{ background: "repeating-linear-gradient(0deg,transparent 0px,transparent 2px,rgba(0,0,0,0.06) 2px,rgba(0,0,0,0.06) 4px)" }} />
                    <div className="absolute left-0 right-0 h-0.5 animate-scan-line" style={{ background: "rgba(255,255,255,0.05)" }} />
                  </div>
                </div>
              )}
              <div
                className="grid gap-[2px] p-[4px]"
                style={{
                  gridTemplateColumns: `repeat(${b.cols}, 1fr)`,
                  marginTop: b.billboard ? "44%" : "6px",
                }}
              >
                {midWindows[i].map((cell, j) => (
                    <div key={j} className={cell.on ? "animate-window-flicker" : ""} style={{
                      aspectRatio: "1",
                      borderRadius: 0.5,
                      background: cell.on ? `${windowColor}${cell.opacity})` : "#0a1020",
                      animationDelay: cell.on ? `${cell.delay}s` : undefined,
                    }} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Buildings - Near layer */}
      <div className="absolute left-0 right-0" style={{ bottom: "18%" }}>
        {[
          { left: "0%", width: "18vw", height: "22vh", color: "warm", cols: 64, rows: 48 },
          { left: "38vw", width: "14vw", height: "19vh", color: "cool", cols: 52, rows: 40 },
          { right: "0%", width: "20vw", height: "20vh", color: "purple", cols: 72, rows: 44 },
        ].map((b, i) => {
          const windowColor = b.color === "cool" ? "rgba(255,241,200," : b.color === "purple" ? "rgba(255,255,235," : "rgba(251,191,36,";
          return (
            <div
              key={i}
              className="absolute bottom-0 rounded-t-sm overflow-hidden"
              style={{
                ...(b.left !== undefined ? { left: b.left } : { right: b.right }),
                width: b.width, height: b.height,
                background: "#111827", border: "1px solid #1f2937", borderBottom: "none",
              }}
            >
              <div className="grid gap-[3px] p-[5px] mt-2" style={{ gridTemplateColumns: `repeat(${b.cols}, 1fr)` }}>
                {nearWindows[i].map((cell, j) => (
                    <div key={j} className={cell.on ? "animate-window-flicker" : ""} style={{
                      aspectRatio: "1",
                      borderRadius: 0.5,
                      background: cell.on ? `${windowColor}${cell.opacity})` : "#111827",
                      boxShadow: cell.on && parseFloat(cell.opacity) > 0.5 ? `0 0 3px ${windowColor}0.3)` : "none",
                      animationDelay: cell.on ? `${cell.delay}s` : undefined,
                    }} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Korean flag (태극기) on street lamp */}
      <div className="absolute" style={{ bottom: "calc(18% + 4vh)", left: "62.3vw" }}>
        {/* Small arm from lamp pole */}
        <div style={{ width: 8, height: 2, background: "#6b7280", marginLeft: -5 }} />
        {/* Flag */}
        <div
          className="animate-flag-wave"
          style={{
            position: "absolute",
            top: -16,
            left: 3,
            width: 28,
            height: 18,
            background: "#fff",
            borderRadius: 1,
            overflow: "hidden",
            boxShadow: "1px 1px 3px rgba(0,0,0,0.3)",
          }}
        >
          {/* Taegeuk circle */}
          <div style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%,-50%) rotate(-15deg)",
            width: 10,
            height: 10,
            borderRadius: "50%",
            overflow: "hidden",
          }}>
            <div style={{ width: "100%", height: "50%", background: "#c60c30" }} />
            <div style={{ width: "100%", height: "50%", background: "#003478" }} />
          </div>
          {/* Corner trigrams (simplified) */}
          <div style={{ position: "absolute", top: 2, left: 2, display: "flex", flexDirection: "column", gap: 1 }}>
            <div style={{ width: 4, height: 1, background: "#000" }} />
            <div style={{ width: 4, height: 1, background: "#000" }} />
            <div style={{ width: 4, height: 1, background: "#000" }} />
          </div>
          <div style={{ position: "absolute", top: 2, right: 2, display: "flex", flexDirection: "column", gap: 1 }}>
            <div style={{ width: 4, height: 1, background: "#000" }} />
            <div style={{ display: "flex", gap: 1 }}><div style={{ width: 1.5, height: 1, background: "#000" }} /><div style={{ width: 1.5, height: 1, background: "#000" }} /></div>
            <div style={{ width: 4, height: 1, background: "#000" }} />
          </div>
          <div style={{ position: "absolute", bottom: 2, left: 2, display: "flex", flexDirection: "column", gap: 1 }}>
            <div style={{ display: "flex", gap: 1 }}><div style={{ width: 1.5, height: 1, background: "#000" }} /><div style={{ width: 1.5, height: 1, background: "#000" }} /></div>
            <div style={{ width: 4, height: 1, background: "#000" }} />
            <div style={{ display: "flex", gap: 1 }}><div style={{ width: 1.5, height: 1, background: "#000" }} /><div style={{ width: 1.5, height: 1, background: "#000" }} /></div>
          </div>
          <div style={{ position: "absolute", bottom: 2, right: 2, display: "flex", flexDirection: "column", gap: 1 }}>
            <div style={{ width: 4, height: 1, background: "#000" }} />
            <div style={{ width: 4, height: 1, background: "#000" }} />
            <div style={{ width: 4, height: 1, background: "#000" }} />
          </div>
        </div>
      </div>

      {/* Neon signs */}
      {[
        { text: "CAFE", color: "#34d399", shadow: "rgba(52,211,153,0.5)", bottom: "calc(18% + 4vh)", left: "54vw", delay: 2 },
        { text: "BAR", color: "#f472b6", shadow: "rgba(244,114,182,0.5)", bottom: "calc(18% + 5vh)", right: "4vw", delay: 0 },
        { text: "24H", color: "#22d3ee", shadow: "rgba(34,211,238,0.5)", bottom: "calc(18% + 3vh)", left: "42vw", delay: 1 },
      ].map((n, i) => (
        <div
          key={i}
          className="absolute px-2 py-0.5 rounded-sm font-mono text-[7px] tracking-wider animate-neon-flicker"
          style={{
            bottom: n.bottom,
            ...(n.left ? { left: n.left } : { right: n.right }),
            border: `1px solid ${n.color}`, color: n.color,
            textShadow: `0 0 6px ${n.shadow}`,
            boxShadow: `0 0 8px ${n.shadow.replace("0.5", "0.15")}`,
            animationDelay: `${n.delay}s`,
          }}
        >
          {n.text}
        </div>
      ))}

      {/* Ground */}
      <div className="absolute bottom-0 left-0 right-0" style={{ height: "18%", background: "linear-gradient(180deg,#141c2e,#111827)", borderTop: "2px solid #2d3a50" }}>
        <div className="absolute left-0 right-0 h-0.5 bg-gray-800" style={{ top: "35%" }} />
        <div className="absolute left-0 right-0 flex gap-[2vw] px-[3vw]" style={{ top: "60%" }}>
          {Array.from({ length: 14 }).map((_, i) => (
            <div key={i} className="flex-1 h-0.5 bg-gray-600 opacity-40" />
          ))}
        </div>
      </div>

      {/* Street lamps */}
      {["8vw", "35vw", "62vw", "90vw"].map((left, i) => (
        <div key={i} className="absolute" style={{ bottom: "18%", left }}>
          <div className="w-[10px] h-1 rounded-full mx-auto" style={{ background: "#fbbf24", boxShadow: "0 0 14px rgba(251,191,36,0.5),0 0 35px rgba(251,191,36,0.12)" }} />
          <div className="w-[3px] mx-auto bg-gray-500" style={{ height: "6vh" }} />
        </div>
      ))}

      {/* Character + Car canvas */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none"
        style={{ zIndex: 10, imageRendering: "pixelated" }}
      />

      <style jsx global>{`
        @keyframes twinkle { 0%,100% { opacity: 0.15; } 50% { opacity: 0.9; } }
        .animate-twinkle { animation: twinkle 3s ease-in-out infinite; }
        @keyframes beacon { 0%,100% { opacity: 1; } 50% { opacity: 0.15; } }
        .animate-beacon { animation: beacon 2s infinite; }
        @keyframes neon-flicker { 0%,93%,97%,100% { opacity: 1; } 94% { opacity: 0.3; } 96% { opacity: 0.7; } 98% { opacity: 0.5; } }
        .animate-neon-flicker { animation: neon-flicker 4s infinite; }
        @keyframes screen-shift { 0%,100% { background: linear-gradient(135deg,#1e1b4b,#312e81,#4338ca); } 50% { background: linear-gradient(135deg,#312e81,#4338ca,#4f46e5); } }
        .animate-screen-shift { animation: screen-shift 8s ease infinite; }
        @keyframes scan-line { 0% { top: -2px; } 100% { top: 100%; } }
        .animate-scan-line { animation: scan-line 3s linear infinite; }
        @keyframes window-flicker { 0%,85%,100% { opacity: 1; } 87% { opacity: 0.1; } 90% { opacity: 0.8; } 92% { opacity: 0.15; } 95% { opacity: 1; } }
        .animate-window-flicker { animation: window-flicker 15s ease-in-out infinite; }
        @keyframes flag-wave { 0%,100% { transform: scaleX(1) skewY(0deg); } 25% { transform: scaleX(0.95) skewY(1deg); } 50% { transform: scaleX(1.02) skewY(-0.5deg); } 75% { transform: scaleX(0.97) skewY(0.5deg); } }
        .animate-flag-wave { animation: flag-wave 3s ease-in-out infinite; transform-origin: left center; }
      `}</style>
    </div>
  );
}
