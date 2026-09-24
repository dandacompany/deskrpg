import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SCENES, validateProbe } from "./contracts";
import {
  gifArgs,
  masterArgs,
  paletteArgs,
  parseProbe,
  selectPalette,
  timingFromMarkers,
  probeMedia,
  installCandidates,
  buildContactSheet,
} from "./media";

test("uses trim, 12 fps, 960x540 and two-pass palette GIF encoding", () => {
  const args = gifArgs(
    "raw.webm",
    { startSeconds: 12.25, durationSeconds: 9 },
    "palette.png",
    "out.gif",
  );
  assert.ok(args.join(" ").includes("trim=start=12.25:duration=9"));
  assert.ok(args.join(" ").includes("fps=12,scale=960:540"));
  assert.ok(args.join(" ").includes("paletteuse=dither=sierra2_4a:diff_mode=rectangle"));
  assert.equal(args[args.indexOf("-loop") + 1], "0");
  assert.ok(
    paletteArgs("raw.webm", { startSeconds: 0, durationSeconds: 9 }, "palette.png", 192)
      .join(" ")
      .includes("palettegen=max_colors=192:stats_mode=diff"),
  );
});

test("normalizes 25 fps raw recordings to 30 fps H.264 masters", () => {
  const args = masterArgs(
    "a path/raw.webm",
    { startSeconds: 4.25, durationSeconds: 9 },
    "master.mp4",
  );
  assert.ok(args.includes("a path/raw.webm"));
  assert.ok(args.join(" ").includes("fps=30,scale=1280:720"));
  assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
  assert.equal(args[args.indexOf("-crf") + 1], "18");
  assert.equal(args[args.indexOf("-pix_fmt") + 1], "yuv420p");
});

test("quantizes timer jitter to a whole GIF frame without moving the start marker", () => {
  assert.deepEqual(timingFromMarkers({ startMs: 4255.006625, endMs: 13266.306125 }), {
    startSeconds: 4.255006625,
    durationSeconds: 9,
  });
  assert.throws(() => timingFromMarkers({ startMs: -1, endMs: 9000 }));
  assert.throws(() => timingFromMarkers({ startMs: 100, endMs: 100 }));
});

test("rejects an 11 MB candidate before replacing committed media", () => {
  assert.throws(
    () =>
      validateProbe(
        "small-talk",
        { width: 960, height: 540, fps: 12, duration: 9, loop: "forever" },
        11_000_000,
      ),
    /exceeds 10 MB/,
  );
});

test("measures effective GIF cadence from frame count and centisecond duration", () => {
  const probe = parseProbe(
    {
      streams: [
        {
          codec_name: "gif",
          width: 960,
          height: 540,
          avg_frame_rate: "143/12",
          nb_read_frames: "108",
          duration: "9.000000",
        },
      ],
      format: {},
    },
    "forever",
  );
  assert.equal(probe.fps, 12);
  assert.equal(probe.frames, 108);
  assert.equal(probe.loop, "forever");
  assert.throws(() => parseProbe({ streams: [], format: {} }, 1), /video/);
});

test("retries oversize palettes in order, stops on success and reports final failure size", () => {
  const attempted: number[] = [];
  assert.equal(
    selectPalette((colors) => {
      attempted.push(colors);
      return colors > 128 ? 11_000_000 : 9_000_000;
    }),
    128,
  );
  assert.deepEqual(attempted, [192, 160, 128]);
  assert.throws(() => selectPalette(() => 12_345_678), /12345678/);
});

/** Skip this check where ffmpeg is missing (release CI runners) — the remaining argument computations still run. */
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test(
  "real FFmpeg outputs retain exact cadence and loop metadata; missing batch cannot touch committed files",
  { skip: hasFfmpeg ? false : "ffmpeg 없음" },
  () => {
    const base = path.resolve(".artifacts/readme-capture/tests");
    fs.mkdirSync(base, { recursive: true });
    const root = fs.mkdtempSync(path.join(base, "media-"));
    const raw = path.join(root, "raw.webm");
    const master = path.join(root, "master.mp4");
    const palette = path.join(root, "palette.png");
    const gif = path.join(root, "loop.gif");
    const run = (args: string[]) =>
      execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "pipe" });
    run(["-f", "lavfi", "-i", "color=c=navy:s=1280x720:r=25:d=10", "-c:v", "libvpx-vp9", raw]);
    const timing = { startSeconds: 0.5, durationSeconds: 9 };
    run(masterArgs(raw, timing, master));
    run(paletteArgs(master, { startSeconds: 0, durationSeconds: 9 }, palette, 192));
    run(gifArgs(master, { startSeconds: 0, durationSeconds: 9 }, palette, gif));
    assert.equal(probeMedia(master).fps, 30);
    assert.equal(probeMedia(master).frames, 270);
    const probe = probeMedia(gif);
    validateProbe("small-talk", probe, fs.statSync(gif).size);
    assert.equal(probe.fps, 12);
    assert.equal(probe.duration, 9);
    assert.equal(probe.frames, 108);
    const committed = path.join(root, "public/readme/deskrpg-home-commute.gif");
    fs.mkdirSync(path.dirname(committed), { recursive: true });
    fs.writeFileSync(committed, "previous committed asset");
    assert.throws(() => installCandidates(root));
    assert.equal(fs.readFileSync(committed, "utf8"), "previous committed asset");
    const candidates = path.join(root, ".artifacts/readme-capture/candidates");
    fs.mkdirSync(candidates, { recursive: true });
    for (const scene of SCENES) fs.copyFileSync(gif, path.join(candidates, `${scene}.gif`));
    const finite = fs.readFileSync(gif);
    const extension = finite.indexOf(Buffer.from("NETSCAPE2.0"));
    assert.ok(extension >= 0);
    finite.writeUInt16LE(2, extension + 13);
    fs.writeFileSync(path.join(candidates, "ai-meeting.gif"), finite);
    assert.equal(probeMedia(path.join(candidates, "ai-meeting.gif")).loop, 2);
    assert.throws(() => installCandidates(root), /infinitely looping/);
    assert.equal(fs.readFileSync(committed, "utf8"), "previous committed asset");
    fs.copyFileSync(gif, path.join(candidates, "ai-meeting.gif"));
    run([
      "-i",
      master,
      "-frames:v",
      "1",
      "-update",
      "1",
      path.join(candidates, "home-screenshot.png"),
    ]);
    const sheet = probeMedia(buildContactSheet(root));
    assert.equal(sheet.width, 2880);
    assert.equal(sheet.height, 2160);
    installCandidates(root);
    for (const scene of SCENES)
      assert.deepEqual(
        fs.readFileSync(path.join(root, `public/readme/deskrpg-${scene}.gif`)),
        fs.readFileSync(gif),
      );
    assert.equal(probeMedia(path.join(root, "public/readme/home-screenshot.png")).width, 1280);
  },
);
