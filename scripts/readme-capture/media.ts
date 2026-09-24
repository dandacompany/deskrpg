import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  capturePaths,
  MEDIA_SPEC,
  SCENES,
  validateProbe,
  type CaptureScene,
  type VideoProbe,
} from "./contracts";

export type Timing = { startSeconds: number; durationSeconds: number };
type ProbeJson = {
  streams: Array<{
    codec_name?: string;
    codec_type?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    nb_read_frames?: string;
    duration?: string;
    pix_fmt?: string;
  }>;
  format: { duration?: string };
};
export type MediaProbe = VideoProbe & {
  codec: string;
  frames: number;
  pixelFormat?: string;
  averageFrameRate: string;
};
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifacts = (root: string) => path.join(root, ".artifacts/readme-capture");
const candidate = (root: string, scene: CaptureScene) =>
  path.join(artifacts(root), "candidates", `${scene}.gif`);

export function timingFromMarkers(markers: { startMs: number; endMs: number }): Timing {
  if (
    !Number.isFinite(markers.startMs) ||
    !Number.isFinite(markers.endMs) ||
    markers.startMs < 0 ||
    markers.endMs <= markers.startMs
  )
    throw new Error("Invalid recording timing markers");
  // Timer callbacks drift by milliseconds. Quantize duration to complete GIF frames.
  const durationSeconds = Math.round(((markers.endMs - markers.startMs) / 1000) * 12) / 12;
  if (durationSeconds < 8 || durationSeconds > 10) throw new Error("Timing must span 8-10 seconds");
  return { startSeconds: markers.startMs / 1000, durationSeconds };
}

const trim = (timing: Timing) =>
  `trim=start=${timing.startSeconds}:duration=${timing.durationSeconds},setpts=PTS-STARTPTS`;
const gifFilter = (timing: Timing) => `${trim(timing)},fps=12,scale=960:540:flags=lanczos`;

export function masterArgs(input: string, timing: Timing, output: string): string[] {
  return [
    "-i",
    input,
    "-vf",
    `${trim(timing)},fps=30,scale=1280:720:flags=lanczos,setsar=1`,
    "-an",
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-preset",
    "slow",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    output,
  ];
}

export function paletteArgs(
  input: string,
  timing: Timing,
  palette: string,
  colors: number,
): string[] {
  return [
    "-i",
    input,
    "-vf",
    `${gifFilter(timing)},palettegen=max_colors=${colors}:stats_mode=diff`,
    "-frames:v",
    "1",
    "-update",
    "1",
    palette,
  ];
}

export function gifArgs(input: string, timing: Timing, palette: string, output: string): string[] {
  return [
    "-i",
    input,
    "-i",
    palette,
    "-filter_complex",
    `[0:v]${gifFilter(timing)}[v];[v][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle[out]`,
    "-map",
    "[out]",
    "-an",
    "-loop",
    "0",
    output,
  ];
}

export function parseProbe(raw: ProbeJson, loop: VideoProbe["loop"]): MediaProbe {
  const stream = raw.streams.find((s) => s.width && s.height);
  if (!stream) throw new Error("No video stream in media");
  const duration = Number(stream.duration ?? raw.format.duration ?? 0);
  const frames = Number(stream.nb_read_frames ?? 0);
  const [n, d] = (stream.avg_frame_rate ?? "0/1").split("/").map(Number);
  // GIF timestamps use centiseconds (8/9/8 centisecond delays at 12 fps).
  // ffprobe can report 12.5 fps for that alternating timestamp cadence.
  // The full loop's frame count / duration is the actual mean playback cadence.
  const fps = stream.codec_name === "gif" && duration > 0 ? frames / duration : n / d;
  if (![duration, frames, fps].every(Number.isFinite)) throw new Error("Invalid video metadata");
  return {
    width: stream.width!,
    height: stream.height!,
    fps,
    duration,
    frames,
    codec: stream.codec_name ?? "unknown",
    pixelFormat: stream.pix_fmt,
    averageFrameRate: stream.avg_frame_rate ?? "0/1",
    loop,
  };
}

export function probeMedia(file: string): MediaProbe {
  const raw = JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", file],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: "pipe" },
    ),
  ) as ProbeJson;
  let loop: VideoProbe["loop"] = 1;
  if (raw.streams.some((s) => s.codec_name === "gif")) {
    // ffprobe does not expose NETSCAPE's GIF loop extension. Read its count.
    const bytes = fs.readFileSync(file);
    const extension = bytes.indexOf(Buffer.from("\x21\xff\x0bNETSCAPE2.0\x03\x01", "binary"));
    if (extension >= 0 && extension + 18 < bytes.length && bytes[extension + 18] === 0) {
      const count = bytes.readUInt16LE(extension + 16);
      loop = count === 0 ? "forever" : count;
    }
  }
  return parseProbe(raw, loop);
}

function run(args: string[], root: string, label: string) {
  const logDir = path.join(artifacts(root), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.openSync(path.join(logDir, `${label}.log`), "w");
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-y", ...args], { stdio: ["ignore", log, log] });
  } finally {
    fs.closeSync(log);
  }
}

export function selectPalette(encode: (colors: number) => number): number {
  let bytes = 0;
  // With the fast walking of the capture runtime the meeting scene has a lot of motion and slightly exceeds 10MB even at 96 colors
  // (measured 10.2MB). Going down to 64 colors fits at 9.7MB.
  for (const colors of [192, 160, 128, 96, 64]) {
    bytes = encode(colors);
    if (bytes <= MEDIA_SPEC.gif.maxBytes) return colors;
  }
  throw new Error(`All palette candidates exceed 10 MB; final size: ${bytes} bytes`);
}

function validateMaster(probe: MediaProbe, timing: Timing) {
  if (
    probe.width !== 1280 ||
    probe.height !== 720 ||
    probe.fps !== 30 ||
    probe.codec !== "h264" ||
    probe.pixelFormat !== "yuv420p" ||
    Math.abs(probe.duration - timing.durationSeconds) > 1 / 30
  )
    throw new Error(`Invalid normalized MP4 master: ${JSON.stringify(probe)}`);
}

export function encodeScene(scene: CaptureScene, root = ROOT) {
  const paths = capturePaths(root, scene);
  const timing = timingFromMarkers(JSON.parse(fs.readFileSync(paths.timing, "utf8")));
  fs.mkdirSync(path.dirname(paths.master), { recursive: true });
  fs.mkdirSync(path.dirname(candidate(root, scene)), { recursive: true });
  run(
    masterArgs(path.join(artifacts(root), "raw", `${scene}.webm`), timing, paths.master),
    root,
    `${scene}-master`,
  );
  const masterProbe = probeMedia(paths.master);
  validateMaster(masterProbe, timing);
  const normalized = { startSeconds: 0, durationSeconds: timing.durationSeconds };
  const colors = selectPalette((count) => {
    const palette = path.join(artifacts(root), "candidates", `${scene}-palette-${count}.png`);
    const attempt = path.join(artifacts(root), "candidates", `${scene}-${count}.gif`);
    run(paletteArgs(paths.master, normalized, palette, count), root, `${scene}-palette-${count}`);
    run(gifArgs(paths.master, normalized, palette, attempt), root, `${scene}-gif-${count}`);
    const bytes = fs.statSync(attempt).size;
    if (bytes <= MEDIA_SPEC.gif.maxBytes) {
      validateProbe(scene, probeMedia(attempt), bytes);
      fs.copyFileSync(attempt, candidate(root, scene));
    }
    return bytes;
  });
  return {
    scene,
    timing,
    colors,
    master: { ...masterProbe, bytes: fs.statSync(paths.master).size },
    gif: { ...probeMedia(candidate(root, scene)), bytes: fs.statSync(candidate(root, scene)).size },
  };
}

export function buildContactSheet(root = ROOT): string {
  const frameDir = path.join(artifacts(root), "frames");
  fs.mkdirSync(frameDir, { recursive: true });
  let index = 0;
  for (const scene of SCENES) {
    const probe = probeMedia(candidate(root, scene));
    for (const frame of [0, Math.floor(probe.frames / 2), probe.frames - 1]) {
      run(
        [
          "-i",
          candidate(root, scene),
          "-vf",
          `select=eq(n\\,${frame})`,
          "-frames:v",
          "1",
          "-update",
          "1",
          path.join(frameDir, `${String(index++).padStart(2, "0")}.png`),
        ],
        root,
        `${scene}-frame-${frame}`,
      );
    }
  }
  const output = path.join(artifacts(root), "contact-sheet.png");
  run(
    [
      "-framerate",
      "1",
      "-i",
      path.join(frameDir, "%02d.png"),
      "-vf",
      "tile=3x4",
      "-frames:v",
      "1",
      "-update",
      "1",
      output,
    ],
    root,
    "contact-sheet",
  );
  return output;
}

export function installCandidates(root = ROOT) {
  const files = SCENES.map((scene) => {
    const source = candidate(root, scene);
    validateProbe(scene, probeMedia(source), fs.statSync(source).size);
    return { source, target: capturePaths(root, scene).gif };
  });
  const poster = path.join(artifacts(root), "candidates/home-screenshot.png");
  const probe = probeMedia(poster);
  if (probe.width !== 1280 || probe.height !== 720 || probe.codec !== "png")
    throw new Error("Invalid homepage poster");
  files.push({ source: poster, target: path.join(root, "public/readme/home-screenshot.png") });
  const backupDir = path.join(artifacts(root), "backups", randomUUID());
  fs.mkdirSync(backupDir, { recursive: true });
  const staged: Array<{ target: string; temporary: string; backup?: string }> = [];
  const replaced: typeof staged = [];
  try {
    for (const { source, target } of files) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      const backup = fs.existsSync(target)
        ? path.join(backupDir, path.basename(target))
        : undefined;
      if (backup) fs.copyFileSync(target, backup);
      staged.push({ target, temporary, backup });
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    }
    // Each rename is atomic; rollback covers errors in the multi-file batch.
    for (const item of staged) {
      fs.renameSync(item.temporary, item.target);
      replaced.push(item);
    }
  } catch (error) {
    for (const item of replaced.reverse()) {
      if (item.backup) {
        fs.copyFileSync(item.backup, item.temporary);
        fs.renameSync(item.temporary, item.target);
      } else fs.unlinkSync(item.target);
    }
    throw error;
  } finally {
    for (const item of staged) if (fs.existsSync(item.temporary)) fs.unlinkSync(item.temporary);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--install")) installCandidates();
  else {
    const report = SCENES.map((scene) => {
      console.log(`Encoding ${scene}`);
      return encodeScene(scene);
    });
    run(
      [
        "-i",
        capturePaths(ROOT, "home-commute").master,
        "-frames:v",
        "1",
        "-update",
        "1",
        path.join(artifacts(ROOT), "candidates/home-screenshot.png"),
      ],
      ROOT,
      "poster",
    );
    buildContactSheet();
    fs.writeFileSync(
      path.join(artifacts(ROOT), "probe-report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    if (!process.argv.includes("--prepare-only")) installCandidates();
    console.log(JSON.stringify(report, null, 2));
  }
}
