// Deterministic, manually stepped visual fixture; not a performance benchmark.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  http = require("node:http"),
  assert = require("node:assert/strict");
const { chromium } = require("playwright"),
  esbuild = require("esbuild");
const out = process.argv[2] || "/tmp/deskrpg-office-review";
const environment = process.argv[3] || "tech";
assert.ok(["trading", "agency", "tech", "executive", "publishing"].includes(environment));
(async () => {
  await fs.mkdir(out, { recursive: true });
  const bundle = await esbuild.build({
    stdin: {
      contents: `
 import {OfficeRenderer} from './src/game/three/office-renderer';
 import {buildOfficeEnvironment} from './src/game/three/office-environments';
 import {tiledSnapshot} from './src/game/three/tiled-preview';
 import {furnitureSeats} from './src/game/three/seating';
 const map=tiledSnapshot(buildOfficeEnvironment('${environment}'));
 const r:any=new OfficeRenderer(document.getElementById('view')!,document.getElementById('labels')!);
 Object.assign(window,{r,map,seats:furnitureSeats(map.objects),sofaSeats:furnitureSeats(map.objects.filter(o=>o.type.includes("sofa")))});
 r.attach({map:()=>map,mapKey:()=> 'tech-review',actors:()=>[],setPresentation:()=>{},editor:()=>({placement:false,spawn:false,owner:false,tiled:true}),walkable:()=>true,pointer:()=>{}} as any);
 r.overview(map.cols,map.rows);r.buildMap(map);r.lastMap='tech-review';
 `,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.NEXT_PUBLIC_README_CAPTURE": '"0"',
    },
  });
  const server = http.createServer(async (req, res) => {
    if (req.url === "/") {
      res.end(
        '<style>body{margin:0}#view{width:100vw;height:100vh}#labels{position:absolute;inset:0;pointer-events:none}</style><div id="view"></div><div id="labels"></div><script src="/entry.js"></script>',
      );
      return;
    }
    if (req.url === "/entry.js") {
      res.setHeader("content-type", "application/javascript");
      res.end(bundle.outputFiles[0].contents);
      return;
    }
    const file = path.resolve("public", "." + new URL(req.url, "http://localhost").pathname);
    if (!file.startsWith(path.resolve("public") + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      res.end(await fs.readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
    args: ["--enable-webgl", "--ignore-gpu-blocklist"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1748, height: 900 } }),
      errors = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.log(e.stack);
    });
    await page.addInitScript(() => {
      Object.defineProperty(document, "hidden", { get: () => false });
      window.requestAnimationFrame = () => 0;
      window.cancelAnimationFrame = () => {};
    });
    await page.goto("http://127.0.0.1:" + server.address().port, {
      waitUntil: "commit",
      timeout: 120000,
    });
    console.log("page loaded");
    await page
      .waitForFunction(() => window.r && window.r.readMetrics().assetsReady, null, {
        polling: 500,
        timeout: 120000,
      })
      .catch(async (e) => {
        console.log(
          await page.evaluate(() => {
            const states = [];
            window.r?.world.traverse((o) => {
              if (o.userData.assetStatus)
                states.push([o.name, o.userData.assetStatus, o.userData.sceneAssetUrl]);
            });
            return { metrics: window.r?.readMetrics(), states };
          }),
        );
        throw e;
      });
    await page.evaluate(() => window.r.tick(performance.now()));
    await fs.writeFile(
      path.join(out, "tech-overview.png"),
      Buffer.from(
        (
          await page.evaluate(() => {
            window.r.renderer.render(window.r.scene, window.r.camera);
            return window.r.renderer.domElement.toDataURL("image/png");
          })
        ).split(",")[1],
        "base64",
      ),
    );
    if (process.argv.includes("--interactions")) {
      const interaction = await page.evaluate(() => {
        const r = window.r;
        const project = (x, y, z) => {
          const p = r.board.position.clone().set(x, y, z).project(r.camera);
          const rect = r.host.getBoundingClientRect();
          return new PointerEvent("pointermove", {
            clientX: rect.left + ((p.x + 1) * rect.width) / 2,
            clientY: rect.top + ((1 - p.y) * rect.height) / 2,
            button: 0,
          });
        };
        let seatHover = false,
          sofaHover = false;
        for (const seat of window.seats) {
          r.point(project(seat.x, 0.65, seat.z), "move");
          if (r.furnitureHighlight.group.visible) {
            seatHover = true;
            if (window.sofaSeats.some((s) => s.x === seat.x && s.z === seat.z)) sofaHover = true;
          }
        }
        const actor = {
          id: "interaction-test",
          kind: "player",
          name: "test",
          x: window.map.cols * 16,
          y: (window.map.rows - 3) * 32,
          direction: "up",
          walking: false,
        };
        // Pick the start point of the reachability check from the floor that is actually connected.
        const first = window.seats[0];
        actor.x = (first.anchorX ?? first.x) * 32;
        actor.y = (first.anchorZ ?? first.z) * 32;
        let request = null,
          opened = 0;
        r.lastActors = [actor];
        r.bridge.actors = () => [actor];
        r.bridge.pointer = (kind, x, y) => {
          if (kind === "down") request = { x, y };
        };
        r.onKanbanOpen = () => opened++;
        const p = r.board.position;
        r.point(project(p.x, p.y, p.z + 0.14), "move");
        const boardHover = r.furnitureHighlight.group.visible;
        r.point(project(p.x, p.y, p.z + 0.14), "down");
        const before = opened;
        if (request) {
          actor.x = request.x;
          actor.y = request.y;
          r.tick(performance.now());
          r.tick(performance.now() + 16);
        }
        return { seatHover, sofaHover, boardHover, requested: !!request, before, opened };
      });
      console.log({ interaction });
      assert.ok(interaction.seatHover);
      assert.ok(interaction.sofaHover);
      assert.ok(interaction.boardHover);
      assert.ok(interaction.requested);
      assert.equal(interaction.before, 0);
      assert.equal(interaction.opened, 1);
    }
    const report = await page.evaluate(() => ({
      metrics: window.r.readMetrics(),
      seats: window.seats.length,
    }));
    await page.evaluate(() => {
      window.r.showRoom(7, 4, 18);
      window.r.tick(performance.now());
    });
    await fs.writeFile(
      path.join(out, "tech-detail.png"),
      Buffer.from(
        (
          await page.evaluate(() => {
            window.r.renderer.render(window.r.scene, window.r.camera);
            return window.r.renderer.domElement.toDataURL("image/png");
          })
        ).split(",")[1],
        "base64",
      ),
    );
    assert.deepEqual(errors, []);
    assert.equal(report.metrics.failedAssets, 0);
    if (environment === "tech") assert.equal(report.seats, 40);
    await fs.writeFile(
      path.join(out, "report.json"),
      JSON.stringify({ ...report, errors, manualFrames: true }, null, 2),
    );
    console.log(report);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
