/**
 * Regenerate the brand mark images — `npx tsx scripts/brand-mark/render.ts`.
 *
 * Renders the same three.js model as the sidebar headquarters once in headless Chromium and bakes it to PNG.
 * The screen does not have to start WebGL every time, and even the 16px favicon comes from the same picture.
 * The output is committed to the repo — the build does not run this script.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { build } from "esbuild";
import { chromium } from "@playwright/test";
import sharp from "sharp";

import { packIco } from "./ico";
import { simpleMarkSvg } from "./simple-mark";

const ROOT = path.resolve(__dirname, "../..");
/** What gets baked. Transparent backgrounds are for the sidebar and wordmark; the cream background is for app icons. */
const OUTPUTS = [
  { file: "public/assets/brand/deskrpg-mark-3d-512.png", size: 512, background: undefined },
  { file: "public/icon-192.png", size: 192, background: "#f3eee2" },
  { file: "public/icon-512.png", size: 512, background: "#f3eee2" },
  { file: "public/apple-icon.png", size: 180, background: "#f3eee2" },
];
const RENDER_SIZE = 1024;
/** The tab icon uses the simple form because 3D smears at that size (Dante's decision, 2026-09-20). */
const FAVICON_SIZES = [16, 32, 48, 64];

async function main() {
  const work = await mkdtemp(path.join(tmpdir(), "deskrpg-brand-mark-"));
  try {
    const bundle = path.join(work, "entry.js");
    await build({
      entryPoints: [path.join(ROOT, "scripts/brand-mark/entry.ts")],
      outfile: bundle,
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
    });
    await writeFile(path.join(work, "index.html"), "<!doctype html><title>mark</title>");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`file://${path.join(work, "index.html")}`);
      await page.addScriptTag({ path: bundle });
      for (const { file, size, background } of OUTPUTS) {
        const dataUrl = await page.evaluate(
          ([renderSize, color]) =>
            window.renderBrandMark(renderSize as number, color as string | undefined),
          [RENDER_SIZE, background] as const,
        );
        const png = Buffer.from(dataUrl.split(",")[1], "base64");
        // Render large once, then scale down — drawing straight from a small canvas leaves jaggies.
        await sharp(png).resize(size, size, { fit: "contain" }).png().toFile(path.join(ROOT, file));
        process.stdout.write(`${file} (${size}px)\n`);
      }
    } finally {
      await browser.close();
    }
    const icons = await Promise.all(
      FAVICON_SIZES.map(async (size) => ({
        size,
        png: await sharp(Buffer.from(simpleMarkSvg(size)))
          .png()
          .toBuffer(),
      })),
    );
    await writeFile(path.join(ROOT, "public/favicon.ico"), packIco(icons));
    await writeFile(
      path.join(ROOT, "public/assets/brand/deskrpg-mark-simple.svg"),
      simpleMarkSvg(64),
    );
    process.stdout.write(`public/favicon.ico (${FAVICON_SIZES.join("·")}px, 단순형)\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

void main();
