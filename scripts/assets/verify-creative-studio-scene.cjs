/** Production studio and actual ReviewClient browser verification. Run from repository root. */
const fs = require("node:fs/promises"),
  http = require("node:http"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const root = process.cwd(),
  out = path.resolve(process.argv[2] || "/tmp/deskrpg-task6-visual");
const { chromium } = require(path.join(root, "node_modules/playwright"));
const esbuild = require(path.join(root, "node_modules/esbuild"));
const entry =
  "import * as T from \"three\";\nimport {OfficeRenderer} from './src/game/three/office-renderer';\nimport {buildOfficeEnvironment} from './src/game/three/office-environments';\nimport {tiledSnapshot} from './src/game/three/tiled-preview';\nimport {furnitureSeats} from './src/game/three/seating';\nimport {OFFICE_LOOKS,officeLookAppearance} from './src/game/three/office-looks';\nimport {createReviewWalk,sampleReviewWalk} from './src/game/three/studio-review';\nimport {findPath,clearSegment} from './src/game/navigation';\nconst map=tiledSnapshot(buildOfficeEnvironment('agency')),seats=furnitureSeats(map.objects),blocked=new Set(map.blocked);\nconst walkable=(x:number,z:number)=>x>=0&&x<42&&z>=0&&z<26&&!blocked.has(x+','+z);\nconst slots=[0,3,5,8,12,15,18,23,26,31,35,37];\nlet actors=slots.map((slot,i)=>({id:'probe-'+i,name:['Mina','Jae','Yuna','Theo','Jin','Alex','Noah','Sora','Eli','Ari','Dante','Nari'][i],kind:i>=10?'player':'npc',x:seats[slot].anchorX!*32,y:seats[slot].anchorZ!*32,direction:seats[slot].direction,walking:false,bubble:i<10?'Working together in the studio':undefined,appearance:officeLookAppearance(OFFICE_LOOKS[i].id)}));\nconst paths=actors.map(a=>findPath(a.x/32-.5,a.y/32-.5,23,23,walkable,(a,b)=>clearSegment(a,b,walkable))!);\nlet mode='seated',start=0,walk:any=null;const pointers:any[]=[];\nconst r:any=new OfficeRenderer(document.querySelector('#view')!,document.querySelector('#labels')!);\nr.attach({map:()=>map,mapKey:()=> 'task6-scene-review',actors:()=>actors.map((actor,i)=>{\n if(i===10&&walk){const next=sampleReviewWalk(walk.route,(performance.now()-walk.start)/1000);if(!next.walking){actors[i]=next;walk=null;}return next;}\n if(mode!=='moving'||i>=10)return actor;const path=[...paths[i],...paths[i].slice(0,-1).reverse()];let length=(performance.now()-start)/1000*1.6+i*.2;const segments=path.slice(1).map((p,j)=>Math.hypot(p.x-path[j].x,p.y-path[j].y));length%=segments.reduce((a,b)=>a+b,0);let j=0;while(j<segments.length-1&&length>segments[j])length-=segments[j++];const t=length/segments[j],a=path[j],b=path[j+1];return {...actor,x:(a.x+(b.x-a.x)*t+.5)*32,y:(a.y+(b.y-a.y)*t+.5)*32,walking:true};\n}),setPresentation:()=>{},editor:()=>({placement:false,spawn:false,owner:false,tiled:true}),walkable,pointer:(kind:string,x:number,y:number,button:number,sx:number,sy:number,actorId?:string)=>{if(kind==='down'){pointers.push({x,y,actorId});if(actorId==='seat-target'){const route=createReviewWalk(actors[10],x,y,walkable);if(route)walk={route,start:performance.now()};}}}} as any);\nr.overview(42,26);\nObject.assign(window,{reviewRenderer:r,reviewMap:map,reviewSeats:seats,reviewPointers:pointers,reviewActors:()=>actors,reviewWalk:()=>walk,reviewThumbnail:()=>{actors=[];r.showOverview();},reviewMoving:(on:boolean)=>{mode=on?'moving':'seated';start=performance.now();},reviewFrame:()=>r.readMetrics(),reviewProject:(x:number,y:number,z:number)=>{const p=new T.Vector3(x,y,z).project(r.camera);return {x:(p.x+1)*innerWidth/2,y:(1-p.y)*innerHeight/2};},reviewBenchmark:()=>new Promise(res=>{const orbit=setInterval(()=>r.rotateCamera(.002),50);r.startBenchmark((result:any)=>{clearInterval(orbit);res(result);});})});\n";
(async () => {
  await fs.mkdir(out, { recursive: true });
  const css = await fs.readFile(path.join(root, "src/game/three/office.css"), "utf8");
  const reviewUI = process.argv.includes("--review-ui");
  const bundle = await esbuild.build({
    stdin: {
      contents: reviewUI
        ? `import React from "react";import {createRoot} from "react-dom/client";import ReviewClient from "./src/app/ui2-review/ReviewClient";import * as T from "three";import {creativeStudioOverview} from "./src/game/three/creative-studio-architecture";
        Object.assign(window,{reviewUIProject:(x:number,z:number)=>{const c=new T.PerspectiveCamera(38,1748/900,.1,250),p=creativeStudioOverview(42,26,1748/900);c.position.copy(p.position);c.lookAt(p.target);c.updateMatrixWorld(true);const v=new T.Vector3(x,0,z).project(c);return {x:(v.x+1)*874,y:(1-v.y)*450};}});
        createRoot(document.getElementById("view")).render(React.createElement(ReviewClient));`
        : process.argv.includes("--generic-object")
          ? entry.replace(
              "const walkable=",
              "map.objects.push({id:'custom-bookshelf',type:'bookshelf',col:4,row:15});map.blocked.push('4,15');blocked.add('4,15');\nconst walkable=",
            )
          : entry,
      loader: "ts",
      resolveDir: root,
    },
    loader: { ".css": "empty" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    define: {
      "process.env.NODE_ENV": reviewUI ? '"development"' : '"production"',
      "process.env.NEXT_PUBLIC_README_CAPTURE": '"0"',
    },
  });
  assert.doesNotMatch(
    bundle.outputFiles[0].text,
    /\bprocess\.env\b/,
    "Browser bundle must resolve environment access",
  );
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") {
      res.setHeader("Content-Type", "text/html");
      res.end(
        "<style>" +
          css +
          ' body{margin:0}#view{width:100vw;height:100vh}#labels{position:absolute;inset:0;pointer-events:none}</style><div id="view"></div><div id="labels"></div><script src="/entry.js"></script>',
      );
      return;
    }
    if (url.pathname === "/entry.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(bundle.outputFiles[0].contents);
      return;
    }
    const target = path.resolve(root, "public", "." + url.pathname);
    if (!target.startsWith(path.join(root, "public") + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const data = await fs.readFile(target);
      res.setHeader(
        "Content-Type",
        { ".glb": "model/gltf-binary", ".webp": "image/webp", ".png": "image/png" }[
          path.extname(target)
        ] || "application/octet-stream",
      );
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({
    headless: !process.argv.includes("--headed"),
    args: ["--enable-webgl", "--ignore-gpu-blocklist"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1748, height: 900 },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    const base = "http://127.0.0.1:" + server.address().port;
    const report = { viewport: { width: 1748, height: 900 }, dpr: 1, errors, metrics: {} };
    await page.goto(base);
    if (reviewUI) {
      await page.getByRole("button", { name: "Creative studio reference 1748×900" }).click();
      await page.waitForFunction(
        () => {
          const e = document.querySelector('[aria-label="Live metrics"]');
          if (!e) return false;
          const m = JSON.parse(e.textContent);
          return (
            m?.assetsReady &&
            m.viewport.width === 1748 &&
            m.viewport.height === 900 &&
            m.mapKey.startsWith("agency:")
          );
        },
        null,
        { timeout: 120000 },
      );
      const metrics = JSON.parse(await page.locator('[aria-label="Live metrics"]').innerText());
      const rooms = await page.locator('[aria-label="Room inspection"] option').allTextContents();
      assert.equal(rooms.length, 9);
      await page.getByRole("button", { name: "Hide names and bubbles" }).click();
      await page
        .locator('[aria-label="Renderer check area"]')
        .screenshot({ path: path.join(out, "review-ui-reference.png") });
      await page.getByLabel("Room inspection", { exact: true }).selectOption("pantry");
      await page
        .locator('[aria-label="Renderer check area"]')
        .screenshot({ path: path.join(out, "review-ui-pantry.png") });
      await page.getByLabel("Room inspection", { exact: true }).selectOption("");
      await page.waitForTimeout(250);
      const player = page.locator('.office-actor-label[data-kind="player"]');
      const state = () =>
        player.evaluate((el) => ({
          x: Number(el.dataset.worldX),
          z: Number(el.dataset.worldZ),
          walking: el.dataset.walking,
          seated: el.dataset.seated,
        }));
      const initial = await state();
      assert.equal(initial.seated, "true");
      const floor = await page.evaluate(() => window.reviewUIProject(23.53, 23.57));
      await page.locator('canvas[aria-label="DeskRPG 3D"]').click({ position: floor });
      await page.waitForTimeout(350);
      const departed = await state();
      assert.equal(departed.seated, "false");
      assert.equal(departed.walking, "true");
      assert.ok(Math.hypot(departed.x - initial.x, departed.z - initial.z) > 0.1);
      await page
        .locator('[aria-label="Renderer check area"]')
        .screenshot({ path: path.join(out, "review-ui-floor-departure.png") });
      await page.getByLabel("Room inspection", { exact: true }).selectOption("pantry");
      await page.getByLabel("Room inspection", { exact: true }).selectOption("");
      await page.waitForTimeout(200);
      const beforeRetarget = await state();
      assert.equal(beforeRetarget.walking, "true");
      const retarget = await page.evaluate(() => window.reviewUIProject(30.56, 23.54));
      await page.locator('canvas[aria-label="DeskRPG 3D"]').click({ position: retarget });
      await page.waitForTimeout(150);
      const afterRetarget = await state();
      assert.equal(afterRetarget.walking, "true");
      assert.ok(
        Math.hypot(afterRetarget.x - beforeRetarget.x, afterRetarget.z - beforeRetarget.z) < 1,
      );
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.office-actor-label[data-kind="player"]');
          return (
            el.dataset.walking === "false" &&
            Math.abs(Number(el.dataset.worldX) - 30.5) < 0.01 &&
            Math.abs(Number(el.dataset.worldZ) - 23.5) < 0.01
          );
        },
        null,
        { timeout: 20000 },
      );
      const arrived = await state();
      assert.equal(arrived.seated, "false");
      await page
        .locator('[aria-label="Renderer check area"]')
        .screenshot({ path: path.join(out, "review-ui-floor-retarget-arrival.png") });
      assert.deepEqual(errors, []);
      await fs.writeFile(
        path.join(out, "review-ui-report.json"),
        JSON.stringify(
          {
            metrics,
            rooms,
            errors,
            floorClick: { initial, departed, beforeRetarget, afterRetarget, arrived },
          },
          null,
          2,
        ),
      );
      return;
    }
    await page.waitForFunction(() => window.reviewRenderer.readMetrics().assetsReady, null, {
      timeout: 120000,
    });
    report.overview = await page.evaluate(() => window.reviewFrame());
    if (process.argv.includes("--generic-object")) {
      report.generic = await page.evaluate(() => {
        const host = window.reviewRenderer.world.getObjectByName("generic-object:custom-bookshelf");
        let meshes = 0;
        host?.traverse((o) => {
          if (o.isMesh && o.visible) meshes++;
        });
        return {
          meshes,
          blocked: window.reviewMap.blocked.includes("4,15"),
          ownedHosts: window.reviewRenderer.world.getObjectsByProperty(
            "name",
            "creative-studio-scene",
          ).length,
        };
      });
      assert.ok(report.generic.meshes > 0);
      assert.equal(report.generic.blocked, true);
      assert.equal(report.generic.ownedHosts, 1);
    }
    report.backend = await page.evaluate(() => {
      const gl = document.querySelector("canvas").getContext("webgl2");
      const e = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        vendor: e && gl.getParameter(e.UNMASKED_VENDOR_WEBGL),
        renderer: e && gl.getParameter(e.UNMASKED_RENDERER_WEBGL),
      };
    });
    report.instances = await page.evaluate(() => {
      let assets = 0,
        objects = 0;
      window.reviewRenderer.world.traverse((o) => {
        if (o.userData.sceneAssetUrl) assets++;
        if (o.userData.mapObjectId) objects++;
      });
      return { assets, objects };
    });
    report.graph = await page.evaluate(() => {
      const result = {};
      window.reviewRenderer.scene.traverse((o) => {
        if (!o.isMesh || !o.visible) return;
        let p = o;
        while (p.parent && p.parent !== window.reviewRenderer.scene) p = p.parent;
        const key = p.name || p.type;
        result[key] = (result[key] || 0) + 1;
      });
      return result;
    });
    await page.screenshot({ path: path.join(out, "overview-labels.png") });
    await page.evaluate(() => (document.querySelector("#labels").style.visibility = "hidden"));
    await page.screenshot({ path: path.join(out, "overview.png") });
    report.seated = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".office-actor-label")).map((el) => ({
        name: el.getAttribute("aria-label"),
        seated: el.dataset.seated,
        status: el.dataset.assetStatus,
      })),
    );
    report.actorKinds = await page.evaluate(() =>
      window.reviewActors().reduce((counts, actor) => {
        counts[actor.kind] = (counts[actor.kind] || 0) + 1;
        return counts;
      }, {}),
    );
    assert.deepEqual(report.actorKinds, { npc: 10, player: 2 });
    await page.evaluate(() => {
      const seat = window.reviewSeats[34];
      window.reviewRenderer.showRoom(seat.x, seat.z, 8);
    });
    await page.waitForTimeout(300);
    const hoverPoint = await page.evaluate(() => {
      const seat = window.reviewSeats[34];
      return window.reviewProject(seat.x, 0.55, seat.z);
    });
    await page.mouse.move(hoverPoint.x, hoverPoint.y);
    await page.waitForTimeout(100);
    report.seatHover = await page.evaluate(() => window.reviewRenderer.readPointerIndicator());
    assert.equal(report.seatHover.visible, true, "seat hover must display its floor highlight");
    assert.equal(report.seatHover.cursor, "pointer", "seat hover must advertise clickability");
    await page.evaluate(() => window.reviewRenderer.showOverview());
    if (process.argv.includes("--smoke")) {
      assert.deepEqual(errors, []);
      await fs.writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
      return;
    }
    report.seatClick = await page.evaluate(() => {
      const index = 34,
        seat = window.reviewSeats[index];
      window.reviewRenderer.showRoom(seat.x, seat.z, 8);
      return { index, seat };
    });
    await page.waitForTimeout(300);
    const clickPoint = await page.evaluate(() => {
      const seat = window.reviewSeats[34];
      return window.reviewProject(seat.x, 0.55, seat.z);
    });
    await page.mouse.click(clickPoint.x, clickPoint.y);
    await page.waitForTimeout(300);
    report.seatClick.pointer = await page.evaluate(() => window.reviewPointers.at(-1));
    assert.equal(
      report.seatClick.pointer?.actorId,
      "seat-target",
      "actual furniture click must select a seat",
    );
    await page.waitForFunction(() => window.reviewWalk() === null, null, { timeout: 60000 });
    await page.waitForTimeout(250);
    report.seatClick.actor = await page.evaluate(() => window.reviewActors()[10]);
    report.seatClick.seated = await page
      .locator(".office-actor-label")
      .nth(10)
      .getAttribute("data-seated");
    assert.equal(report.seatClick.seated, "true");
    await page.screenshot({ path: path.join(out, "seat-click-arrival.png") });
    for (const [name, x, z, d] of [
      ["photo", 5.5, 4.5, 12],
      ["ideation", 14.5, 12.5, 10],
      ["lounge", 26, 10, 9],
      ["production", 23, 19.5, 11],
      ["meeting", 37, 5, 11],
      ["pantry", 39, 11.5, 8],
      ["lounge-front", 36, 22, 9],
    ]) {
      await page.evaluate(([x, z, d]) => window.reviewRenderer.showRoom(x, z, d), [x, z, d]);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(out, name + ".png") });
      if (name === "production") {
        await page.evaluate(() => {
          window.reviewRenderer.world.traverse((o) => {
            if (!o.isMesh) return;
            for (const m of Array.isArray(o.material) ? o.material : [o.material])
              if (m.envMap) {
                m.userData.reviewReflectionIntensity = m.envMapIntensity;
                m.envMapIntensity = 0;
              }
          });
        });
        await page.screenshot({ path: path.join(out, "production-reflection-off.png") });
        await page.evaluate(() => {
          window.reviewRenderer.world.traverse((o) => {
            if (!o.isMesh) return;
            for (const m of Array.isArray(o.material) ? o.material : [o.material])
              if (m.envMap) m.envMapIntensity = m.userData.reviewReflectionIntensity;
          });
        });
      }
    }
    await page.evaluate(() => window.reviewRenderer.showOverview());
    await page.waitForTimeout(200);
    await page.mouse.move(860, 460);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(1050, 475, { steps: 12 });
    await page.mouse.up({ button: "right" });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(out, "orbit.png") });
    await page.mouse.move(850, 430);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(890, 450, { steps: 8 });
    await page.mouse.up({ button: "middle" });
    await page.mouse.wheel(0, -160);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(out, "pan-zoom.png") });
    await page.evaluate(() => {
      window.reviewRenderer.showOverview();
      window.reviewMoving(true);
    });
    await page.waitForTimeout(1500);
    report.moving = await page.evaluate(() => ({
      metrics: window.reviewFrame(),
      labels: Array.from(document.querySelectorAll(".office-actor-label")).map((el) => ({
        seated: el.dataset.seated,
        status: el.dataset.assetStatus,
      })),
    }));
    await page.screenshot({ path: path.join(out, "moving.png") });
    await page.evaluate(() => (document.querySelector("#labels").style.visibility = "visible"));
    if (process.argv.includes("--benchmark"))
      report.benchmark = await page.evaluate(() => window.reviewBenchmark());
    await page.evaluate(() => window.reviewMoving(false));
    await page.evaluate(() => window.reviewThumbnail());
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 874, height: 450 });
    await page.evaluate(() => window.reviewRenderer.showOverview());
    await page.waitForTimeout(300);
    const thumbnail = await page.evaluate(() => window.reviewRenderer.captureFrame());
    await fs.writeFile(
      path.join(out, "agency-v5.webp"),
      Buffer.from(thumbnail.split(",")[1], "base64"),
    );
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
