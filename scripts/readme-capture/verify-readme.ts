import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENES, validateProbe, type CaptureScene, type VideoProbe } from "./contracts";
import { probeMedia } from "./media";

const GIF_PATHS = SCENES.map((scene) => `public/readme/deskrpg-${scene}.gif`);
const HERO_PATH = "public/readme/home-screenshot.png";
const RETIRED_GIF_PATHS = [
  "public/readme/deskrpg-login-to-office.gif",
  "public/readme/deskrpg-npc-task-loop.gif",
  "public/readme/deskrpg-meeting-room.gif",
  "public/readme/deskrpg-map-editor.gif",
];
const ENGLISH_CAPTIONS = [
  "Morning Commute",
  "Call Them Over to Report",
  "Live Small Talk",
  "Agent Meeting",
];
const KOREAN_CAPTIONS = [
  "아침 출근길",
  "호출하면 걸어와서 보고",
  "실시간 스몰토크",
  "에이전트 회의",
];
/**
 * The map editor was removed — it must not appear in the README, neither as a current nor a planned feature.
 * Traces of legacy 2D (Phaser, LPC sprites) are blocked too. The public README claims only what actually
 * ships.
 */
const FORBIDDEN_CLAIMS: { pattern: RegExp; reason: string }[] = [
  { pattern: /map editor/i, reason: "Map Editor was removed and must not appear in the README" },
  { pattern: /맵 에디터/, reason: "맵 에디터는 제거됐다 — README 에 남기지 않는다" },
  {
    pattern: /Build or upload your own office maps/i,
    reason: "map upload was removed with the map editor",
  },
  {
    pattern: /오피스 맵을 직접 만들거나 올립니다/,
    reason: "맵 업로드는 맵 에디터와 함께 제거됐다",
  },
  { pattern: /\bphaser\b/i, reason: "the Phaser runtime was removed" },
  { pattern: /\bLPC\b/, reason: "LPC sprite assets were removed" },
  { pattern: /assets\/spritesheets/, reason: "the spritesheet assets were removed" },
];

type ProbeMedia = (file: string) => VideoProbe;

function extractGifPaths(readme: string): string[] {
  return [...readme.matchAll(/public\/readme\/[^\s"')>]+\.gif/g)].map(([match]) => match);
}

function extractHeroPaths(readme: string): string[] {
  return [...readme.matchAll(/<img\b[^>]*\bsrc=["'](public\/readme\/[^"']+\.png)["'][^>]*>/g)].map(
    ([, source]) => source,
  );
}

function assertOrderedGifPaths(label: string, actual: string[]): void {
  if (
    actual.length !== GIF_PATHS.length ||
    actual.some((value, index) => value !== GIF_PATHS[index])
  )
    throw new Error(`${label} must use the approved ordered GIF paths`);
}

function assertCaptions(label: string, readme: string, captions: string[]): void {
  for (const caption of captions)
    if (!readme.includes(caption))
      throw new Error(`${label} is missing approved caption: ${caption}`);
}

export async function verifyReadmes(
  root: string,
  probeMediaOverride: ProbeMedia = probeMedia,
): Promise<void> {
  const [english, korean] = await Promise.all([
    fs.readFile(path.join(root, "README.md"), "utf8"),
    fs.readFile(path.join(root, "README.ko.md"), "utf8"),
  ]);

  const englishGifPaths = extractGifPaths(english);
  const koreanGifPaths = extractGifPaths(korean);
  const englishHeroPaths = extractHeroPaths(english);
  const koreanHeroPaths = extractHeroPaths(korean);
  assertOrderedGifPaths("README.md", englishGifPaths);
  assertOrderedGifPaths("README.ko.md", koreanGifPaths);
  if (englishGifPaths.some((value, index) => value !== koreanGifPaths[index]))
    throw new Error("README files must use matching ordered GIF paths");
  if (
    englishHeroPaths.length !== 1 ||
    koreanHeroPaths.length !== 1 ||
    englishHeroPaths[0] !== HERO_PATH ||
    koreanHeroPaths[0] !== HERO_PATH ||
    englishHeroPaths[0] !== koreanHeroPaths[0]
  )
    throw new Error("Both README files must use the approved matching hero poster");

  assertCaptions("README.md", english, ENGLISH_CAPTIONS);
  assertCaptions("README.ko.md", korean, KOREAN_CAPTIONS);

  if (!english.includes("Website: [https://deskrpg.com](https://deskrpg.com) (live)"))
    throw new Error("README.md must mark https://deskrpg.com as a clickable live website");
  if (!korean.includes("웹사이트: [https://deskrpg.com](https://deskrpg.com) (운영 중)"))
    throw new Error("README.ko.md must mark https://deskrpg.com as a clickable live website");
  for (const { pattern, reason } of FORBIDDEN_CLAIMS)
    for (const [label, readme] of [
      ["README.md", english],
      ["README.ko.md", korean],
    ] as const)
      if (pattern.test(readme)) throw new Error(`${label} must not mention ${pattern}: ${reason}`);

  for (const relativePath of RETIRED_GIF_PATHS) {
    try {
      await fs.stat(path.join(root, relativePath));
    } catch {
      continue;
    }
    throw new Error(`Retired GIF must be absent: ${relativePath}`);
  }

  const hero = path.join(root, HERO_PATH);
  try {
    await fs.stat(hero);
  } catch {
    throw new Error(`Missing hero poster: ${HERO_PATH}`);
  }
  const heroProbe = probeMediaOverride(hero);
  if (heroProbe.width !== 1280 || heroProbe.height !== 720)
    throw new Error("Hero poster must be 1280x720");

  for (const [index, relativePath] of GIF_PATHS.entries()) {
    const file = path.join(root, relativePath);
    let bytes: number;
    try {
      bytes = (await fs.stat(file)).size;
    } catch {
      throw new Error(`Missing GIF: ${relativePath}`);
    }
    validateProbe(SCENES[index] as CaptureScene, probeMediaOverride(file), bytes);
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyReadmes(ROOT)
    .then(() => console.log("README media verification passed"))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
