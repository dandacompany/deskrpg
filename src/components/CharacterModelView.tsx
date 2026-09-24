"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import * as T from "three";
import { createActor, cylinder } from "@/game/three/characters";
import type { OfficeLook } from "@/game/three/office-looks";
import { disposeTree } from "@/game/three/office-renderer";

/** A small 3D stage that spins one look. Colors are read as-is from the look definition. */
export default function CharacterModelView({
  look,
  size,
  direction,
  active,
  onUnavailable,
  walking = true,
}: {
  look: OfficeLook;
  size: number;
  direction: string;
  active: boolean;
  onUnavailable: () => void;
  walking?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    current = useRef({ direction, active, walking });
  useLayoutEffect(() => {
    current.current = { direction, active, walking };
  }, [direction, active, walking]);
  const failed = useRef(onUnavailable);
  useLayoutEffect(() => {
    failed.current = onUnavailable;
  }, [onUnavailable]);
  useEffect(() => {
    if (!host.current) return;
    let renderer: T.WebGLRenderer;
    try {
      renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      failed.current();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(size, size);
    renderer.outputColorSpace = T.SRGBColorSpace;
    host.current.append(renderer.domElement);
    const scene = new T.Scene(),
      camera = new T.PerspectiveCamera(32, 1, 0.1, 20),
      palette = { skin: look.skin, hair: look.hair, legs: look.trousers };
    camera.position.set(2, 1.8, 4.9);
    camera.lookAt(0, 1, 0);
    scene.add(new T.HemisphereLight("#fff7e4", "#839b78", 2.5));
    const light = new T.DirectionalLight("#fff2d5", 3);
    light.position.set(2, 5, 4);
    scene.add(light);
    cylinder(scene, 0.65, 0.7, 0.1, "#d3bd96", 0, -0.08, 0);
    const actor = createActor("character-preview", look.shirt, 0, palette, look);
    scene.add(actor.root);
    let frame = 0;
    const render = (time: number) => {
      frame = requestAnimationFrame(render);
      if (!current.current.active) return;
      actor.rig.rotation.y =
        { up: Math.PI, down: 0, left: -Math.PI / 2, right: Math.PI / 2 }[
          current.current.direction
        ] ?? 0;
      actor.update(
        time / 1000,
        current.current.walking && !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        "idle",
        false,
      );
      renderer.render(scene, camera);
    };
    render(0);
    return () => {
      cancelAnimationFrame(frame);
      disposeTree(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [size, look]);
  return <div ref={host} style={{ width: size, height: size }} aria-hidden="true" />;
}
