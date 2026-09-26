import { detailSurfaces } from "./surface-detail";
import { idleMotion, isHeldPose, statePose } from "./idle-motion";
import * as T from "three";
import { round, sphere } from "./primitives";
import type { OfficeLook } from "./office-looks";
import type { ActorPhase } from "./characters";

function hairMesh(head: T.Group, look: OfficeLook) {
  const h = look.hair;
  sphere(head, 0.276, h, 0, 0.095, -0.048, 1.04, 0.77, 1);
  if (look.hairStyle === "bun") {
    sphere(head, 0.15, h, 0, 0.22, -0.22, 1, 0.85, 1);
    round(head, 0.32, 0.075, 0.14, h, 0, 0.2, 0.14, 0.03);
    round(head, 0.19, 0.028, 0.025, "#b79a6b", 0, 0.2, -0.35, 0.008);
  }
  if (look.hairStyle === "long") {
    round(head, 0.47, 0.69, 0.2, h, 0, -0.23, -0.17, 0.07);
    for (const side of [-1, 1]) round(head, 0.095, 0.6, 0.15, h, side * 0.245, -0.2, 0.035, 0.04);
    round(head, 0.2, 0.07, 0.16, h, -0.09, 0.2, 0.14, 0.03).rotation.z = -0.18;
  }
  if (look.hairStyle === "braids") {
    for (const side of [-1, 1]) {
      for (let i = 0; i < 8; i++)
        sphere(
          head,
          0.055,
          h,
          side * (0.255 + Math.sin(i * 2) * 0.025),
          0.1 - i * 0.072,
          -0.035,
          1,
          1.2,
          1,
        );
      round(head, 0.075, 0.035, 0.07, look.coat, side * 0.26, -0.45, -0.035, 0.01);
    }
    for (const x of [-0.16, -0.08, 0, 0.08, 0.16])
      round(head, 0.02, 0.025, 0.35, h, x, 0.265 - Math.abs(x) * 0.3, -0.035, 0.008);
  }
  if (look.hairStyle === "part" || look.hairStyle === "crop") {
    const fringe = round(head, 0.37, 0.1, 0.18, h, -0.03, 0.19, 0.14, 0.045);
    fringe.rotation.z = -0.17;
    if (look.hairStyle === "part") round(head, 0.11, 0.12, 0.14, h, 0.2, 0.14, 0.1, 0.045);
  }
  if (look.hairStyle === "bob") {
    round(head, 0.52, 0.4, 0.27, h, 0, -0.1, -0.13, 0.1);
    for (const s of [-1, 1]) round(head, 0.105, 0.4, 0.22, h, s * 0.25, -0.085, 0.015, 0.045);
    round(head, 0.42, 0.1, 0.12, h, 0, 0.17, 0.19, 0.04);
  }
  if (look.hairStyle === "pony") {
    sphere(head, 0.105, h, 0, 0.09, -0.29);
    round(head, 0.16, 0.46, 0.16, h, 0, -0.17, -0.3, 0.065).rotation.x = -0.2;
    round(head, 0.13, 0.045, 0.16, "#8d6e4b", 0, 0.01, -0.3, 0.018);
    round(head, 0.34, 0.08, 0.14, h, -0.04, 0.2, 0.12, 0.035).rotation.z = -0.12;
  }
  if (look.hairStyle === "curls") {
    for (let i = 0; i < 17; i++) {
      const a = i * 2.39996;
      const y = 0.1 + (i % 3) * 0.055;
      sphere(head, 0.095, h, Math.cos(a) * 0.235, y, Math.sin(a) * 0.22 - 0.02, 1, 0.9, 1);
    }
    for (const s of [-1, 1])
      for (let i = 0; i < 3; i++) sphere(head, 0.085, h, s * 0.26, -0.03 - i * 0.08, -0.055);
  }
  if (look.hairStyle === "wave") {
    for (let i = 0; i < 5; i++)
      sphere(head, 0.112, h, -0.21 + i * 0.1, 0.18 + Math.sin(i) * 0.02, 0.1, 0.9, 0.75, 1);
    if (look.bodyType === "female")
      for (const s of [-1, 1]) {
        round(head, 0.14, 0.49, 0.24, h, s * 0.235, -0.15, -0.065, 0.065);
        sphere(head, 0.105, h, s * 0.23, -0.35, -0.03, 0.85, 1.2, 1);
      }
  }
}

/** One rig for gallery, map and meeting. Clothing moves with its anatomical parent. */
export function createOfficeActor(id: string, look: OfficeLook, index: number) {
  const root = new T.Group(),
    rig = new T.Group();
  root.add(rig);
  root.userData.actorId = id;
  root.userData.officeLookId = look.id;
  rig.scale.x = look.build;
  const material = (color: string) => new T.MeshStandardMaterial({ color, roughness: 0.82 });
  const torso = new T.Group();
  torso.position.y = 1.02;
  rig.add(torso);
  const isJacket =
    look.outfit === "suit" ||
    look.outfit === "coat" ||
    look.outfit === "cardigan" ||
    look.outfit === "double-breasted" ||
    look.outfit === "labcoat";
  round(torso, 0.49, 0.62, 0.28, look.shirt, 0, 0.09, 0, 0.07);
  // Neck and crisp shirt collar.
  sphere(torso, 0.09, look.skin, 0, 0.45, 0, 1, 1.3, 1);
  for (const s of [-1, 1]) {
    const collar = round(torso, 0.11, 0.12, 0.024, look.shirt, s * 0.07, 0.36, 0.155, 0.012);
    collar.rotation.z = s * 0.3;
  }
  if (look.outfit === "coat") round(torso, 0.16, 0.1, 0.2, look.shirt, 0, 0.4, 0, 0.03);
  if (isJacket) {
    round(torso, 0.51, 0.65, 0.17, look.coat, 0, 0.075, -0.095, 0.065);
    for (const s of [-1, 1]) {
      round(torso, 0.17, 0.65, 0.13, look.coat, s * 0.19, 0.075, 0.105, 0.035);
      const lapel = round(torso, 0.1, 0.34, 0.033, look.coat, s * 0.115, 0.2, 0.193, 0.014);
      lapel.rotation.z = -s * 0.23;
      round(torso, 0.105, 0.02, 0.015, "#9a9483", s * 0.19, -0.075, 0.178, 0.003);
    }
    for (const y of [-0.05, 0.06]) sphere(torso, 0.016, "#aa9674", 0.06, y, 0.178, 1, 1, 0.4);
    if (look.outfit === "coat" || look.outfit === "labcoat") {
      for (const s of [-1, 1])
        round(torso, 0.23, 0.46, 0.29, look.coat, s * 0.14, -0.4, -0.01, 0.035);
    }
    if (look.pattern === "pinstripe") {
      round(torso, 0.24, 0.39, 0.045, "#43525b", 0, 0.03, 0.17, 0.02); // waistcoat
      for (const x of [-0.21, -0.17, 0.17, 0.21])
        round(torso, 0.007, 0.52, 0.005, "#657179", x, 0.08, 0.175, 0.001);
    }
  }
  if (look.outfit === "double-breasted") {
    round(torso, 0.31, 0.42, 0.04, look.coat, 0.045, -0.01, 0.2, 0.025);
    for (const x of [-0.065, 0.16])
      for (const y of [-0.12, 0.02, 0.16]) sphere(torso, 0.018, "#c6af7b", x, y, 0.232, 1, 1, 0.4);
    round(torso, 0.07, 0.045, 0.014, look.shirt, -0.2, 0.22, 0.182, 0.005);
  }
  if (look.outfit === "labcoat") {
    for (const x of [-0.17, 0.17])
      round(torso, 0.13, 0.13, 0.025, look.coat, x, -0.31, 0.16, 0.015);
    round(torso, 0.012, 0.07, 0.012, "#557c92", -0.17, 0.22, 0.18, 0.003);
  }
  if (look.outfit === "hoodie") {
    round(torso, 0.56, 0.65, 0.35, look.shirt, 0, 0.045, 0, 0.09);
    round(torso, 0.34, 0.28, 0.2, look.shirt, 0, 0.35, -0.19, 0.075);
    round(torso, 0.3, 0.16, 0.035, look.coat, 0, -0.1, 0.185, 0.03);
    for (const x of [-0.07, 0.07])
      round(torso, 0.012, 0.18, 0.012, "#e6ddce", x, 0.27, 0.18, 0.004);
  }
  if (look.neckwear === "turtleneck") round(torso, 0.18, 0.13, 0.2, look.shirt, 0, 0.42, 0, 0.035);
  if (look.neckwear === "bow") {
    for (const side of [-1, 1]) {
      round(
        torso,
        0.15,
        0.09,
        0.05,
        look.tie ?? look.coat,
        side * 0.075,
        0.32,
        0.205,
        0.025,
      ).rotation.z = side * 0.2;
      round(
        torso,
        0.035,
        0.22,
        0.025,
        look.tie ?? look.coat,
        side * 0.04,
        0.19,
        0.2,
        0.008,
      ).rotation.z = side * 0.18;
    }
  }
  if (look.neckwear === "scarf") {
    round(torso, 0.26, 0.1, 0.27, look.tie ?? look.coat, 0, 0.37, 0.02, 0.03);
    round(torso, 0.105, 0.4, 0.035, look.tie ?? look.coat, -0.08, 0.12, 0.21, 0.015).rotation.z =
      -0.13;
  }
  if (look.outfit === "vest") {
    round(torso, 0.5, 0.42, 0.31, look.coat, 0, 0.005, 0, 0.055);
    for (const s of [-1, 1]) round(torso, 0.17, 0.27, 0.3, look.coat, s * 0.16, 0.25, 0, 0.035);
    if (look.pattern === "pinstripe") {
      // Fine flat stripes distinguish a tailored waistcoat from raised sweater ribs.
      const stripe = `#${new T.Color(look.coat).lerp(new T.Color("#eeeade"), 0.35).getHexString()}`;
      for (const x of [-0.18, -0.12, -0.06, 0, 0.06, 0.12, 0.18])
        round(torso, 0.005, 0.36, 0.004, stripe, x, 0, 0.159, 0.001);
      for (const x of [-0.18, -0.12, 0.12, 0.18])
        round(torso, 0.005, 0.17, 0.004, stripe, x, 0.255, 0.153, 0.001);
    } else {
      for (let i = 0; i < 7; i++)
        round(torso, 0.012, 0.36, 0.008, "#899283", -0.21 + i * 0.07, 0, 0.16, 0.002);
    }
  }
  if (look.outfit === "cardigan" && look.pattern === "knit") {
    const rib = `#${new T.Color(look.coat).lerp(new T.Color("#eeeade"), 0.22).getHexString()}`;
    // Keep the center opening clear: ribbing follows the two front panels and hem.
    for (const side of [-1, 1]) {
      for (const x of [0.15, 0.19, 0.23])
        round(torso, 0.012, 0.45, 0.012, rib, side * x, 0.015, 0.178, 0.003);
      round(torso, 0.14, 0.025, 0.012, rib, side * 0.19, -0.225, 0.178, 0.003);
    }
  }
  if (look.outfit === "blouse") {
    for (let i = 0; i < 6; i++)
      round(torso, 0.009, 0.44, 0.008, "#d1ad68", -0.18 + i * 0.072, 0.07, 0.145, 0.002);
  }
  if (look.pattern === "check") {
    for (const x of [-0.23, -0.17, 0.17, 0.23])
      round(torso, 0.012, 0.55, 0.005, "#a8997d", x, 0.05, 0.176, 0.002);
    for (const y of [-0.12, 0.03, 0.18])
      for (const s of [-1, 1]) round(torso, 0.13, 0.012, 0.005, "#a8997d", s * 0.2, y, 0.18, 0.002);
  }
  if (look.tie && !look.neckwear) {
    const knot = round(torso, 0.055, 0.065, 0.035, look.tie, 0, 0.31, 0.18, 0.012);
    knot.rotation.z = 0.1;
    round(torso, 0.055, 0.28, 0.025, look.tie, 0, 0.14, 0.183, 0.013).rotation.z =
      look.outfit === "shirt" ? 0.09 : 0;
  }
  if (
    look.accessory === "badge" ||
    look.id === "office-jun" ||
    look.id === "office-tae" ||
    look.id === "office-seo"
  ) {
    for (const s of [-1, 1])
      round(torso, 0.012, 0.23, 0.012, "#6d8692", s * 0.04, 0.27, 0.19, 0.003).rotation.z =
        -s * 0.16;
    round(torso, 0.088, 0.115, 0.02, "#eeeade", 0.0, 0.1, 0.2, 0.008);
    round(torso, 0.035, 0.038, 0.008, "#7697a0", -0.017, 0.12, 0.215, 0.003);
  }
  const head = new T.Group();
  head.position.y = 1.66;
  rig.add(head);
  sphere(head, 0.27, look.skin, 0, 0, 0, 1, 1.08, 0.94);
  hairMesh(head, look);
  for (const s of [-1, 1]) {
    sphere(head, 0.044, look.skin, s * 0.265, -0.035, -0.005, 0.8, 1, 1);
    sphere(head, 0.022, "#263331", s * 0.088, 0.0, 0.243, 0.8, 1.05, 0.45);
    round(head, 0.065, 0.015, 0.014, look.hair, s * 0.088, 0.052, 0.241, 0.005).rotation.z =
      -s * 0.09;
  }
  sphere(head, 0.03, look.skin, 0, -0.06, 0.257, 1, 1.1, 0.9);
  round(head, 0.062, 0.012, 0.016, "#975f4e", 0, -0.12, 0.242, 0.004);
  if (look.glasses) {
    for (const s of [-1, 1]) {
      const g = new T.Mesh(
        new T.TorusGeometry(0.065, 0.008, 5, 20),
        material(look.hair === "#c7c6bf" ? "#a89e83" : "#403f36"),
      );
      g.position.set(s * 0.09, 0, 0.27);
      head.add(g);
      round(head, 0.14, 0.012, 0.014, "#514d40", s * 0.2, 0.006, 0.21, 0.003).rotation.y = s * 0.7;
    }
    round(head, 0.05, 0.008, 0.01, "#514d40", 0, 0, 0.27, 0.002);
  }
  if (look.accessory === "headset") {
    const band = new T.Mesh(new T.TorusGeometry(0.29, 0.018, 5, 20, Math.PI), material("#414a48"));
    band.position.set(0, 0.015, -0.01);
    head.add(band);
    for (const side of [-1, 1])
      round(head, 0.05, 0.115, 0.09, "#414a48", side * 0.29, -0.015, 0, 0.02);
    round(head, 0.015, 0.018, 0.23, "#414a48", 0.26, -0.075, 0.11, 0.005);
    round(head, 0.09, 0.025, 0.025, "#414a48", 0.225, -0.075, 0.22, 0.007);
  }
  const arms: T.Group[] = [],
    legs: T.Group[] = [];
  const knees: T.Group[] = [];
  for (const s of [-1, 1]) {
    const arm = new T.Group();
    arm.position.set(s * 0.3, 1.32, 0);
    rig.add(arm);
    const sleeve = look.outfit === "vest" ? look.shirt : isJacket ? look.coat : look.shirt;
    round(arm, 0.15, 0.39, 0.18, sleeve, 0, -0.17, 0, 0.045);
    if (look.outfit === "shirt") {
      round(arm, 0.17, 0.08, 0.2, look.shirt, 0, -0.26, 0, 0.025);
      round(arm, 0.115, 0.16, 0.13, look.skin, 0, -0.37, 0, 0.04);
    } else round(arm, 0.13, 0.15, 0.16, sleeve, 0, -0.38, 0, 0.035);
    sphere(arm, 0.066, look.skin, 0, -0.48, 0.005, 0.8, 1.2, 1);
    arms.push(arm);
    const leg = new T.Group();
    leg.position.set(s * 0.125, 0.8, 0);
    rig.add(leg);
    const width = look.lower === "wide" ? 0.245 : 0.18;
    const legColor =
      look.lower === "skirt" && look.skirtLength === "knee" ? look.skin : look.trousers;
    round(leg, width, 0.32, 0.22, legColor, 0, -0.145, 0, 0.035);
    const knee = new T.Group();
    knee.position.y = -0.3;
    leg.add(knee);
    round(knee, width, 0.33, 0.22, legColor, 0, -0.165, 0, 0.035);
    round(knee, 0.19, 0.105, 0.33, look.shoes, 0, -0.36, 0.06, 0.032);
    round(knee, 0.19, 0.023, 0.32, "#93816a", 0, -0.415, 0.06, 0.008);
    knees.push(knee);
    legs.push(leg);
  }
  const skirtHeight = look.skirtLength === "knee" ? 0.43 : 0.7;
  const skirtY = look.skirtLength === "knee" ? 0.565 : 0.43;
  let skirt: T.Mesh | undefined;
  if (look.lower === "skirt") {
    skirt = new T.Mesh(
      new T.CylinderGeometry(
        0.26,
        look.skirtLength === "knee" ? 0.28 : 0.34,
        skirtHeight,
        20,
        1,
        false,
      ),
      material(look.trousers),
    );
    skirt.position.set(0, skirtY, 0);
    skirt.castShadow = true;
    rig.add(skirt);
    for (let i = 0; i < 14; i++) {
      const a = (i * Math.PI * 2) / 14;
      round(
        skirt,
        0.012,
        skirtHeight - 0.06,
        0.012,
        "#72796b",
        Math.sin(a) * (look.skirtLength === "knee" ? 0.272 : 0.302),
        0,
        Math.cos(a) * (look.skirtLength === "knee" ? 0.272 : 0.302),
        0.002,
      );
    }
  }
  if (look.bag) {
    if (look.bag === "backpack") {
      round(torso, 0.36, 0.48, 0.19, "#575b53", 0, 0.06, -0.26, 0.055);
      round(torso, 0.28, 0.19, 0.045, "#777b70", 0, -0.045, -0.37, 0.025);
      for (const side of [-1, 1])
        round(torso, 0.035, 0.5, 0.035, "#575b53", side * 0.21, 0.12, 0.21, 0.01);
    } else if (look.bag === "shoulder") {
      const strap = round(torso, 0.035, 0.72, 0.025, "#4b4539", -0.04, 0.03, 0.215, 0.008);
      strap.rotation.z = -0.7;
      round(rig, 0.16, 0.35, 0.3, "#554e40", -0.38, 0.72, -0.03, 0.04);
    } else {
      const bag = round(arms[1], 0.11, 0.35, 0.32, "#4c4236", 0.045, -0.63, 0.045, 0.025);
      round(bag, 0.04, 0.1, 0.13, "#4c4236", 0, 0.21, 0, 0.018);
      round(bag, 0.014, 0.02, 0.04, "#b49a61", 0.061, 0.06, 0.13, 0.003);
    }
  }
  if (look.accessory === "notebook") {
    const book = round(arms[0], 0.085, 0.28, 0.2, "#667b75", -0.025, -0.48, 0.1, 0.012);
    round(book, 0.09, 0.24, 0.17, "#eee5d2", 0, 0, 0.012, 0.004);
    round(book, 0.09, 0.28, 0.016, "#667b75", 0, 0, 0.105, 0.004);
  }
  const ring = new T.Mesh(
    new T.RingGeometry(0.34, 0.375, 40),
    new T.MeshBasicMaterial({
      color: look.coat,
      transparent: true,
      opacity: 0.3,
      side: T.DoubleSide,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.013;
  root.add(ring);
  detailSurfaces(
    rig,
    [],
    [look.coat, look.shirt, look.trousers].filter(
      (color) => color !== look.skin && color !== look.hair,
    ),
  );
  return {
    id,
    root,
    rig,
    ring,
    phase: "idle" as ActorPhase,
    seated: false,
    update(t: number, walking: boolean, phase: ActorPhase, seated: boolean) {
      const sit = seated && !walking;
      const motion = idleMotion(t, index, walking, phase);
      const pose = statePose(phase);
      head.rotation.y = motion.yaw;
      rig.position.y = sit
        ? -0.12
        : isHeldPose(phase)
          ? 0
          : Math.sin(t * (look.stance === "bright" ? 2.2 : 1.7) + index) * 0.008;
      torso.rotation.z = phase === "thinking" ? Math.sin(t * 1.4) * 0.025 : motion.sway;
      head.rotation.x = (phase === "thinking" ? 0.1 : motion.nod) + pose.headDown;
      head.rotation.z =
        look.stance === "relaxed"
          ? 0.04
          : isHeldPose(phase)
            ? 0
            : Math.sin(t * 1.4 + index) * 0.015;
      arms.forEach((a, i) => {
        a.rotation.x = walking
          ? Math.sin(t * 8 + i * Math.PI) * 0.4
          : pose.raiseArm && i === 0
            ? pose.raiseArm
            : phase === "thinking" && i === 0
              ? -1.8
              : phase === "streaming"
                ? -0.4 + Math.sin(t * 4 + i) * 0.2
                : sit
                  ? -0.6
                  : i === 1
                    ? -motion.hand * 0.75
                    : 0;
        a.rotation.z = walking
          ? 0
          : (i === 0 ? -1 : 1) * (look.stance === "relaxed" ? 0.09 : 0.035);
      });
      legs.forEach((leg, i) => {
        leg.rotation.x = sit ? -Math.PI / 2 : walking ? Math.sin(t * 8 + i * Math.PI) * 0.4 : 0;
      });
      knees.forEach((knee) => {
        knee.rotation.x = sit ? Math.PI / 2 : 0;
      });
      if (skirt) {
        skirt.rotation.x = sit ? -0.45 : 0;
        skirt.scale.y = sit ? 0.65 : 1;
        skirt.position.y = sit ? 0.57 : skirtY;
      }
      ring.material.opacity = phase === "streaming" ? 0.55 + Math.sin(t * 3) * 0.15 : 0.25;
    },
  };
}
