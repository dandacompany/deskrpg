import * as T from "three";
import type { ActorGait } from "./gait";
import { miniatureDistancePose } from "./commute-walk";
import { sphere, round } from "./primitives";
import { idleMotion, isHeldPose, statePose } from "./idle-motion";
import type { OfficeLook } from "./office-looks";
import type { ActorPhase } from "./characters";

/** Sculpted miniature pilot. The rig interface is shared with the standard office actors. */
/** The angle (radians) the whole body leans forward when running. */
const RUN_LEAN = 0.22;

export function createMiniatureActor(id: string, look: OfficeLook, index: number) {
  const root = new T.Group(),
    rig = new T.Group();
  root.add(rig);
  root.userData.actorId = id;
  root.userData.officeLookId = look.id;
  root.userData.modelStyle = "miniature";
  const skin = new T.MeshStandardMaterial({ color: look.skin, roughness: 0.64 });
  const cloth = new T.MeshStandardMaterial({ color: look.shirt, roughness: 0.94 });
  const hair = new T.MeshStandardMaterial({ color: look.hair, roughness: 0.6 });
  const skirtMat = new T.MeshStandardMaterial({
    color: look.trousers,
    roughness: 0.91,
    side: T.DoubleSide,
  });
  const mesh = (parent: T.Object3D, geometry: T.BufferGeometry, material: T.Material) => {
    const m = new T.Mesh(geometry, material);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  // Profiles replace rectangular body blocks. Elliptical cross-sections give a tailored waist.
  const profile = (parent: T.Object3D, points: number[][], material: T.Material, depth = 0.64) => {
    const m = mesh(
      parent,
      new T.LatheGeometry(
        points.map(([r, y]) => new T.Vector2(r, y)),
        40,
      ),
      material,
    );
    m.scale.z = depth;
    return m;
  };
  const torso = new T.Group();
  rig.add(torso);
  profile(
    torso,
    [
      [0, 0.91],
      [0.19, 0.91],
      [0.2, 0.98],
      [0.16, 1.1],
      [0.18, 1.24],
      [0.225, 1.37],
      [0.205, 1.43],
      [0.12, 1.47],
      [0.065, 1.48],
      [0, 1.48],
    ],
    cloth,
  );
  profile(
    torso,
    [
      [0.055, 1.43],
      [0.058, 1.57],
    ],
    skin,
    0.85,
  );
  for (const s of [-1, 1]) {
    const collar = round(torso, 0.09, 0.115, 0.012, cloth, s * 0.056, 1.421, 0.115, 0.006);
    collar.rotation.z = s * 0.36;
  }
  for (let y = 1.04; y < 1.4; y += 0.085) sphere(torso, 0.008, "#c3b29a", 0, y, 0.122, 1, 1, 0.5);
  // Oval cranium, tapering jaw, subdued eyelids and nose bridge rather than bead eyes.
  const head = new T.Group();
  head.position.y = 1.715;
  rig.add(head);
  sphere(head, 0.16, skin, 0, 0, 0, 0.84, 1.19, 0.83);
  sphere(head, 0.115, skin, 0, -0.079, 0.01, 0.87, 0.94, 0.85);
  for (const s of [-1, 1]) {
    sphere(head, 0.028, skin, s * 0.132, -0.015, 0, 0.58, 1.2, 0.6);
    sphere(head, 0.025, "#e8d9ce", s * 0.052, 0.01, 0.122, 1, 0.38, 0.23);
    sphere(head, 0.011, "#44352c", s * 0.052, 0.009, 0.128, 0.72, 0.84, 0.3);
    sphere(head, 0.004, "#efe7dc", s * 0.05, 0.013, 0.132, 0.6, 0.7, 0.3);
    const brow = round(head, 0.045, 0.006, 0.004, hair, s * 0.052, 0.045, 0.119, 0.002);
    brow.rotation.z = -s * 0.1;
    sphere(head, 0.022, "#cda08a", s * 0.078, -0.04, 0.114, 1, 0.42, 0.12);
    sphere(head, 0.009, "#baa16f", s * 0.136, -0.052, 0.012, 0.65, 1.3, 0.65);
  }
  sphere(head, 0.018, skin, 0, -0.018, 0.126, 0.55, 1.8, 0.7);
  sphere(head, 0.015, skin, 0, -0.046, 0.137, 0.9, 0.6, 0.85);
  sphere(head, 0.023, "#9a665c", 0, -0.079, 0.12, 1, 0.18, 0.24);
  sphere(head, 0.02, "#b87e70", 0, -0.086, 0.121, 1, 0.2, 0.18);
  // Sculpted bob shell: the front opens around the face; back and sides extend to jaw.
  const hp: number[] = [],
    hi: number[] = [];
  const segments = 56,
    rows = 18;
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const front = (Math.cos(a) + 1) / 2;
      const end = 2.65 - 1.42 * Math.pow(front, 6);
      const theta = 0.015 + (j / rows) * end;
      const r = 1 + 0.018 * Math.cos(a * 18);
      hp.push(
        Math.sin(a) * Math.sin(theta) * 0.151 * r,
        Math.cos(theta) * 0.205 + 0.018,
        Math.cos(a) * Math.sin(theta) * 0.145 * r - 0.014,
      );
      if (j < rows && i < segments) {
        const k = j * (segments + 1) + i;
        hi.push(k, k + segments + 1, k + 1, k + 1, k + segments + 1, k + segments + 2);
      }
    }
  const hg = new T.BufferGeometry();
  hg.setAttribute("position", new T.Float32BufferAttribute(hp, 3));
  hg.setIndex(hi);
  hg.computeVertexNormals();
  mesh(head, hg, hair);
  const arms: T.Group[] = [],
    elbows: T.Group[] = [],
    legs: T.Group[] = [],
    knees: T.Group[] = [];
  for (const s of [-1, 1]) {
    const arm = new T.Group();
    arm.position.set(s * 0.224, 1.399, 0);
    rig.add(arm);
    arms.push(arm);
    profile(
      arm,
      [
        [0.04, -0.32],
        [0.052, -0.23],
        [0.066, -0.08],
        [0.066, -0.02],
        [0, 0.025],
      ],
      cloth,
      0.88,
    );
    const elbow = new T.Group();
    elbow.position.y = -0.3;
    arm.add(elbow);
    elbows.push(elbow);
    profile(
      elbow,
      [
        [0.032, -0.28],
        [0.04, -0.23],
        [0.051, -0.04],
        [0.046, 0.02],
      ],
      cloth,
      0.8,
    );
    sphere(elbow, 0.045, skin, 0, -0.32, 0, 0.72, 1.28, 0.45);
    for (let f = 0; f < 4; f++)
      sphere(
        elbow,
        0.009,
        skin,
        -0.022 + f * 0.014,
        -0.365 + (f === 0 || f === 3 ? 0.008 : 0),
        0,
        0.6,
        2.2,
        0.65,
      );
    sphere(elbow, 0.011, skin, s * 0.037, -0.322, 0.006, 0.7, 1.7, 0.75);
    const leg = new T.Group();
    leg.position.set(s * 0.105, 0.89, 0);
    rig.add(leg);
    legs.push(leg);
    profile(
      leg,
      [
        [0.042, -0.42],
        [0.065, -0.3],
        [0.087, -0.09],
        [0.075, 0.025],
      ],
      skin,
      0.92,
    );
    const knee = new T.Group();
    knee.position.y = -0.405;
    leg.add(knee);
    knees.push(knee);
    profile(
      knee,
      [
        [0.032, -0.39],
        [0.033, -0.31],
        [0.056, -0.16],
        [0.046, 0.015],
      ],
      skin,
      0.9,
    );
    sphere(knee, 0.07, look.shoes, 0, -0.405, 0.045, 0.72, 0.52, 1.6);
    round(knee, 0.096, 0.017, 0.185, "#756654", 0, -0.441, 0.042, 0.008);
  }
  const sg = new T.CylinderGeometry(0.18, 0.28, 0.73, 56, 16, true);
  const pos = sg.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i),
      a = Math.atan2(pos.getX(i), pos.getZ(i));
    const pleat = 1 + 0.024 * Math.cos(a * 20);
    pos.setXYZ(i, pos.getX(i) * pleat, y + 0.57, pos.getZ(i) * 0.76 * pleat);
  }
  const standing = new Float32Array(pos.array);
  sg.computeVertexNormals();
  mesh(rig, sg, skirtMat);
  // Fine leather strap and compact bag maintain Eunchae's established outfit.
  const strap = round(torso, 0.018, 0.63, 0.012, "#594d3d", -0.018, 1.19, 0.148, 0.004);
  strap.rotation.z = -0.58;
  round(torso, 0.105, 0.21, 0.18, "#655743", -0.255, 0.96, -0.025, 0.025);
  round(torso, 0.012, 0.025, 0.04, "#b49b6e", -0.313, 0.97, 0.035, 0.003);
  const ring = new T.Mesh(
    new T.RingGeometry(0.31, 0.34, 40),
    new T.MeshBasicMaterial({
      color: look.coat,
      transparent: true,
      opacity: 0.25,
      side: T.DoubleSide,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.013;
  root.add(ring);
  let lastSit: boolean | undefined;
  return {
    id,
    root,
    rig,
    ring,
    phase: "idle" as ActorPhase,
    seated: false,
    update(
      t: number,
      walking: boolean,
      phase: ActorPhase,
      seated: boolean,
      walkPhase?: number,
      pace?: ActorGait,
    ) {
      // Running: speed up the step cycle to match the speed, lean forward, and swing the bent arms widely.
      const run = walking && !!pace?.running;
      const gait = walkPhase ?? t * 7 * (run ? pace!.cadence : 1);
      const sit = seated && !walking,
        motion = idleMotion(t, index, walking, phase),
        pose = statePose(phase);
      rig.position.y = sit
        ? -0.21
        : walking
          ? Math.abs(Math.sin(gait)) * (run ? 0.03 : 0.009)
          : isHeldPose(phase)
            ? 0
            : Math.sin(t * 1.6 + index) * 0.003;
      // Raise the head by as much as the lean so the gaze points forward.
      head.rotation.set(motion.nod * 0.6 - (run ? 0.12 : 0) + pose.headDown, motion.yaw * 0.7, 0);
      torso.rotation.z = motion.sway * 0.4;
      // When running, the whole body leans from the ankles. Head, arms and legs are siblings of the torso, not children, so leaning
      // only the torso tilts just the torso mesh while the head stands straight (the first implementation did that).
      rig.rotation.x = run ? RUN_LEAN : 0;
      arms.forEach((a, i) => {
        a.rotation.x = walking
          ? Math.sin(gait + i * Math.PI) * (run ? 0.62 : 0.28)
          : pose.raiseArm && i === 0
            ? pose.raiseArm
            : sit
              ? -0.34
              : phase === "thinking" && i === 0
                ? -0.8
                : phase === "streaming"
                  ? -0.2 + Math.sin(t * 3 + i) * 0.1
                  : 0;
        a.rotation.z = (i === 0 ? -1 : 1) * 0.045;
      });
      elbows.forEach((a) => (a.rotation.x = sit ? -0.85 : run ? -1.05 : -0.12));
      legs.forEach(
        (leg, i) =>
          (leg.rotation.x = sit
            ? -Math.PI / 2
            : walking
              ? walkPhase === undefined
                ? Math.sin(gait + i * Math.PI) * (run ? 0.55 : 0.32)
                : miniatureDistancePose(gait + i * Math.PI).leg
              : 0),
      );
      knees.forEach(
        (k, i) =>
          (k.rotation.x = sit
            ? Math.PI / 2
            : walking
              ? walkPhase === undefined
                ? Math.max(0, -Math.sin(gait + i * Math.PI)) * (run ? 0.9 : 0.4)
                : miniatureDistancePose(gait + i * Math.PI).knee
              : 0),
      );
      if (sit !== lastSit) {
        for (let i = 0; i < pos.count; i++) {
          const x = standing[i * 3],
            y = standing[i * 3 + 1],
            z = standing[i * 3 + 2];
          const u = Math.max(0, Math.min(1, (0.935 - y) / 0.73));
          pos.setXYZ(
            i,
            x,
            sit ? 0.93 - 0.42 * u * u : y,
            sit ? z + 0.48 * Math.sin((u * Math.PI) / 2) : z,
          );
        }
        pos.needsUpdate = true;
        sg.computeVertexNormals();
        lastSit = sit;
      }
      ring.material.opacity = phase === "streaming" ? 0.45 : 0.22;
    },
  };
}
