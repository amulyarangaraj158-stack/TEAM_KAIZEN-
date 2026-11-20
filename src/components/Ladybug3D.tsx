import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { useAppStore, type LadybugReaction } from '../store/useAppStore';

const SEVERITY_COLORS: Record<string, number> = {
  low: 0x3b82f6,
  medium: 0xffb020,
  high: 0xa855f7,
  critical: 0xff3864,
  success: 0x39ff88,
  patrol: 0x00f5ff,
};

const SEVERITY_HEX: Record<string, string> = {
  low: '#3B82F6',
  medium: '#FFB020',
  high: '#A855F7',
  critical: '#FF3864',
  success: '#39FF88',
  patrol: '#00F5FF',
};

function detectSoftwareGl(): { supported: boolean; isSoftware: boolean } {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return { supported: false, isSoftware: true };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return {
      supported: true,
      isSoftware: /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu),
    };
  } catch {
    return { supported: false, isSoftware: true };
  }
}

export const Ladybug3D: React.FC = () => {
  const ladybugEnabled = useAppStore((s) => s.ladybugEnabled);
  const ladybugReaction = useAppStore((s) => s.ladybugReaction);
  const reactionRef = useRef<LadybugReaction>(ladybugReaction);
  reactionRef.current = ladybugReaction;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [webglFallback, setWebglFallback] = useState(false);

  useEffect(() => {
    if (!ladybugEnabled) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const glInfo = detectSoftwareGl();
    if (!glInfo.supported) {
      setWebglFallback(true);
      return;
    }
    setWebglFallback(false);

    const mountEl = containerRef.current;
    if (!mountEl) return;

    const SIZE = 96;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 30);
    camera.position.set(0, 3.4, 3.5);
    camera.lookAt(0, 0.18, 0);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !glInfo.isSoftware,
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch {
      setWebglFallback(true);
      return;
    }

    renderer.setSize(SIZE, SIZE);
    renderer.setPixelRatio(glInfo.isSoftware ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.setClearColor(0x000000, 0);
    mountEl.innerHTML = '';
    mountEl.appendChild(renderer.domElement);

    // Studio PBR environment reflections
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    pmrem.dispose();

    // Warm/cool studio 3-point lighting
    const hemiLight = new THREE.HemisphereLight(0x88e8ff, 0x0b1220, 0.9);
    scene.add(hemiLight);
    const keyLight = new THREE.DirectionalLight(0xfff1dc, 1.8);
    keyLight.position.set(3, 5, 4);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x00f5ff, 1.3);
    rimLight.position.set(-4, 2, -3);
    scene.add(rimLight);

    // Build 12-part procedural cyberpunk 3D ladybug (THREE.Group)
    const ladybug = new THREE.Group();
    scene.add(ladybug);

    // Materials (varied roughness & metalness)
    const chassisMat = new THREE.MeshStandardMaterial({
      color: 0x0d1526,
      metalness: 0.78,
      roughness: 0.34,
    });
    const wingShellMat = new THREE.MeshPhysicalMaterial({
      color: 0xb91c3a,
      metalness: 0.35,
      roughness: 0.14,
      clearcoat: 1.0,
      clearcoatRoughness: 0.1,
    });
    const spotMat = new THREE.MeshStandardMaterial({
      color: 0x090f1d,
      metalness: 0.5,
      roughness: 0.45,
    });
    const neonMat = new THREE.MeshStandardMaterial({
      color: 0x00f5ff,
      emissive: 0x00f5ff,
      emissiveIntensity: 1.9,
      roughness: 0.2,
      metalness: 0.2,
    });
    const innerWingMat = new THREE.MeshStandardMaterial({
      color: 0x00f5ff,
      emissive: 0x00f5ff,
      emissiveIntensity: 0.65,
      transparent: true,
      opacity: 0.35,
      roughness: 0.1,
      side: THREE.DoubleSide,
    });
    const legMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      metalness: 0.85,
      roughness: 0.28,
    });

    // 1. Primary lower abdomen chassis
    const bodyBaseGeo = new THREE.SphereGeometry(0.72, 24, 16);
    bodyBaseGeo.scale(1.0, 0.48, 1.24);
    const bodyBase = new THREE.Mesh(bodyBaseGeo, chassisMat);
    bodyBase.position.y = 0.26;
    ladybug.add(bodyBase);

    // 2. Glowing neon perimeter outline ring
    const rimRingGeo = new THREE.TorusGeometry(0.76, 0.032, 12, 42);
    rimRingGeo.rotateX(Math.PI / 2);
    rimRingGeo.scale(1.0, 1.0, 1.22);
    const rimRing = new THREE.Mesh(rimRingGeo, neonMat);
    rimRing.position.y = 0.24;
    ladybug.add(rimRing);

    // 3 & 4. Left & Right Hinged Elytra (Carapace Wings) with cyber spots
    const makeElytron = (side: -1 | 1) => {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.03, 0.46, 0.38);

      const shellGeo = new THREE.SphereGeometry(0.74, 24, 16, side === 1 ? 0 : Math.PI, Math.PI, 0, Math.PI * 0.54);
      shellGeo.scale(0.98, 0.72, 1.25);
      const shell = new THREE.Mesh(shellGeo, wingShellMat);
      shell.position.set(0, -0.14, -0.38);
      pivot.add(shell);

      // 3 prominent obsidian carapace spots sitting proud on each curved elytron
      const spotGeo = new THREE.SphereGeometry(0.135, 14, 10);
      spotGeo.scale(1.0, 0.45, 1.0);
      const spotCoords: Array<[number, number, number, number, number]> = [
        [side * 0.34, 0.34, -0.14, 0.16, -side * 0.42],
        [side * 0.45, 0.25, -0.52, -0.12, -side * 0.62],
        [side * 0.24, 0.33, -0.78, -0.35, -side * 0.28],
      ];
      for (const [sx, sy, sz, rx, rz] of spotCoords) {
        const spot = new THREE.Mesh(spotGeo, spotMat);
        spot.position.set(sx, sy, sz);
        spot.rotation.set(rx, 0, rz);
        pivot.add(spot);
      }

      // Dark center dorsal seam accent
      const seamGeo = new THREE.BoxGeometry(0.03, 0.06, 1.38);
      const seam = new THREE.Mesh(seamGeo, spotMat);
      seam.position.set(-side * 0.015, 0.39, -0.44);
      pivot.add(seam);

      return pivot;
    };

    const leftWingPivot = makeElytron(-1);
    const rightWingPivot = makeElytron(1);
    ladybug.add(leftWingPivot, rightWingPivot);

    // 5 & 6. Translucent holographic inner wings
    const innerWingGeo = new THREE.CircleGeometry(0.56, 18);
    innerWingGeo.scale(0.58, 1.2, 1);
    innerWingGeo.rotateX(-Math.PI / 2);
    const leftInnerWing = new THREE.Mesh(innerWingGeo, innerWingMat);
    leftInnerWing.position.set(-0.22, 0.42, -0.12);
    const rightInnerWing = new THREE.Mesh(innerWingGeo, innerWingMat);
    rightInnerWing.position.set(0.22, 0.42, -0.12);
    ladybug.add(leftInnerWing, rightInnerWing);

    // 7. Armored Head & Thorax Pronotum
    const headGeo = new THREE.SphereGeometry(0.36, 18, 14);
    headGeo.scale(1.12, 0.78, 0.92);
    const head = new THREE.Mesh(headGeo, chassisMat);
    head.position.set(0, 0.32, 0.86);
    ladybug.add(head);

    // 8. Dual Glowing Optical Sensors (Eyes)
    const eyeGeo = new THREE.SphereGeometry(0.085, 12, 12);
    const leftEye = new THREE.Mesh(eyeGeo, neonMat);
    leftEye.position.set(-0.2, 0.38, 1.12);
    const rightEye = new THREE.Mesh(eyeGeo, neonMat);
    rightEye.position.set(0.2, 0.38, 1.12);
    ladybug.add(leftEye, rightEye);

    // 9. Curved Cyber Antennae
    const makeAntenna = (side: -1 | 1) => {
      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(side * 0.14, 0.4, 1.1),
        new THREE.Vector3(side * 0.32, 0.62, 1.38),
        new THREE.Vector3(side * 0.46, 0.56, 1.56),
      );
      const geo = new THREE.TubeGeometry(curve, 10, 0.022, 8, false);
      return new THREE.Mesh(geo, neonMat);
    };
    ladybug.add(makeAntenna(-1), makeAntenna(1));

    // 10-12. Six Articulated Legs (3 per side)
    const legPivots: Array<{ pivot: THREE.Group; side: -1 | 1; phase: number }> = [];
    const legGeo = new THREE.CapsuleGeometry(0.036, 0.34, 4, 8);
    const zOffsets = [0.45, 0.0, -0.45];
    for (let i = 0; i < 3; i++) {
      for (const side of [-1, 1] as const) {
        const pivot = new THREE.Group();
        pivot.position.set(side * 0.62, 0.22, zOffsets[i]);
        const legMesh = new THREE.Mesh(legGeo, legMat);
        legMesh.rotation.z = side * 1.05;
        legMesh.position.set(side * 0.16, -0.08, 0);
        pivot.add(legMesh);
        ladybug.add(pivot);
        legPivots.push({ pivot, side, phase: i * 2.1 + (side === 1 ? Math.PI : 0) });
      }
    }

    // Soft contact ground shadow disc
    const shadowGeo = new THREE.CircleGeometry(1.05, 24);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    const shadowDisc = new THREE.Mesh(shadowGeo, shadowMat);
    shadowDisc.position.y = 0.02;
    scene.add(shadowDisc);

    // Pre-allocated animation state (zero GC in loop)
    const targetColor = new THREE.Color(0x00f5ff);
    let posX = Math.max(16, window.innerWidth - 112);
    let posY = Math.max(96, window.innerHeight - 112);
    let velX = 0;
    let velY = 0;
    let heading = -Math.PI * 0.75;
    let cursorX = posX;
    let cursorY = posY;
    let lastTime = performance.now();
    let elapsed = 0;
    let frameId = 0;
    let disposed = false;

    const onPointerMove = (e: PointerEvent) => {
      cursorX = e.clientX;
      cursorY = e.clientY;
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });

    const afterDraw = (cb: () => void) => {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      if (typeof gl.fenceSync === 'function') {
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        const poll = () => {
          if (disposed) return;
          const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
          if (state === gl.UNSIGNALED) {
            frameId = window.setTimeout(poll, 8);
          } else {
            if (sync) gl.deleteSync(sync);
            frameId = window.setTimeout(cb, 85);
          }
        };
        frameId = window.setTimeout(poll, 8);
      } else {
        frameId = window.setTimeout(cb, 90);
      }
    };

    const tick = () => {
      if (disposed) return;
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;
      elapsed += dt;

      const reaction = reactionRef.current;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Keep the ladybug patrolling cleanly along the bottom-right perimeter without covering UI controls,
      // and glide smoothly toward the top-right notification alert zone on real backend bug detections.
      let goalX: number;
      let goalY: number;

      if (reaction.mode === 'alert') {
        goalX = Math.max(24, vw - 220);
        goalY = 74;
        targetColor.setHex(SEVERITY_COLORS[reaction.severity] ?? 0xff3864);
      } else if (reaction.mode === 'repaired') {
        goalX = Math.max(24, vw - 180);
        goalY = Math.max(96, vh - 190);
        targetColor.setHex(SEVERITY_COLORS.success);
      } else {
        // Gentle orbital perimeter drift anchored tightly in the bottom-right margin
        const baseX = Math.max(16, vw - 112);
        const baseY = Math.max(120, vh - 112);
        const orbitX = Math.sin(elapsed * 0.45) * 9;
        const orbitY = Math.cos(elapsed * 0.6) * 7;
        const cursorBiasX = THREE.MathUtils.clamp((cursorX - baseX) * 0.025, -14, 8);
        const cursorBiasY = THREE.MathUtils.clamp((cursorY - baseY) * 0.025, -14, 8);
        goalX = THREE.MathUtils.clamp(baseX + orbitX + cursorBiasX, 16, vw - 102);
        goalY = THREE.MathUtils.clamp(baseY + orbitY + cursorBiasY, 96, vh - 102);
        targetColor.setHex(SEVERITY_COLORS.patrol);
      }

      if (!reducedMotion) {
        const damp = 1 - Math.exp(-3.2 * dt);
        const nextX = posX + (goalX - posX) * damp;
        const nextY = posY + (goalY - posY) * damp;
        velX = (nextX - posX) / Math.max(dt, 0.001);
        velY = (nextY - posY) / Math.max(dt, 0.001);
        posX = nextX;
        posY = nextY;

        const speed = Math.hypot(velX, velY);
        if (speed > 4) {
          const desiredHeading = Math.atan2(velX, velY);
          let diff = desiredHeading - heading;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          heading += diff * (1 - Math.exp(-5.5 * dt));
        } else {
          // Subtly face toward pointer when resting
          const dx = cursorX - (posX + SIZE / 2);
          const dy = cursorY - (posY + SIZE / 2);
          const desiredHeading = Math.atan2(dx, dy);
          let diff = desiredHeading - heading;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          heading += diff * (1 - Math.exp(-2.2 * dt));
        }

        // Apply DOM transform (compositor-only GPU transform)
        if (wrapperRef.current) {
          wrapperRef.current.style.transform = `translate3d(${posX.toFixed(1)}px, ${posY.toFixed(1)}px, 0)`;
        }

        // Update 3D model orientation, leg gait, and wing animation
        ladybug.rotation.y = heading;
        const gaitFreq = reaction.mode === 'alert' ? 16 : 6.5 + Math.min(8, speed * 0.08);
        const gaitAmp = reaction.mode === 'alert' ? 0.34 : 0.16 + Math.min(0.22, speed * 0.004);
        for (const l of legPivots) {
          l.pivot.rotation.y = Math.sin(elapsed * gaitFreq + l.phase) * gaitAmp;
        }

        // Subtle wing flutter (opens slightly on alert or repair verification)
        const wingOpenTarget =
          reaction.mode === 'alert'
            ? 0.28 + Math.sin(elapsed * 18) * 0.08
            : reaction.mode === 'repaired'
              ? 0.42 + Math.sin(elapsed * 8) * 0.05
              : 0.03 + Math.max(0, Math.sin(elapsed * 1.4)) * 0.04;

        leftWingPivot.rotation.y = THREE.MathUtils.lerp(leftWingPivot.rotation.y, -wingOpenTarget, 0.18);
        leftWingPivot.rotation.z = THREE.MathUtils.lerp(leftWingPivot.rotation.z, wingOpenTarget * 0.45, 0.18);
        rightWingPivot.rotation.y = THREE.MathUtils.lerp(rightWingPivot.rotation.y, wingOpenTarget, 0.18);
        rightWingPivot.rotation.z = THREE.MathUtils.lerp(rightWingPivot.rotation.z, -wingOpenTarget * 0.45, 0.18);

        leftInnerWing.visible = wingOpenTarget > 0.08;
        rightInnerWing.visible = wingOpenTarget > 0.08;
        leftInnerWing.rotation.y = -wingOpenTarget * 1.3;
        rightInnerWing.rotation.y = wingOpenTarget * 1.3;

        ladybug.position.y = Math.sin(elapsed * 3.2) * 0.04 + (reaction.mode === 'repaired' ? 0.14 : 0);
      }

      neonMat.color.lerp(targetColor, 0.12);
      neonMat.emissive.lerp(targetColor, 0.12);
      innerWingMat.color.lerp(targetColor, 0.12);
      innerWingMat.emissive.lerp(targetColor, 0.12);

      renderer.render(scene, camera);

      if (glInfo.isSoftware) {
        afterDraw(tick);
      } else {
        frameId = requestAnimationFrame(tick);
      }
    };

    if (wrapperRef.current) {
      wrapperRef.current.style.transform = `translate3d(${posX.toFixed(1)}px, ${posY.toFixed(1)}px, 0)`;
    }
    tick();

    return () => {
      disposed = true;
      window.removeEventListener('pointermove', onPointerMove);
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      envTex.dispose();
      bodyBaseGeo.dispose();
      rimRingGeo.dispose();
      innerWingGeo.dispose();
      headGeo.dispose();
      eyeGeo.dispose();
      legGeo.dispose();
      shadowGeo.dispose();
      chassisMat.dispose();
      wingShellMat.dispose();
      spotMat.dispose();
      neonMat.dispose();
      innerWingMat.dispose();
      legMat.dispose();
      shadowMat.dispose();
      renderer.dispose();
    };
  }, [ladybugEnabled]);

  if (!ladybugEnabled) return null;

  const badgeHex =
    ladybugReaction.mode === 'patrol'
      ? SEVERITY_HEX.patrol
      : SEVERITY_HEX[ladybugReaction.severity] ?? SEVERITY_HEX.patrol;

  return (
    <div
      ref={wrapperRef}
      data-testid="ladybug-3d"
      data-mode={ladybugReaction.mode}
      data-severity={ladybugReaction.severity}
      aria-hidden="true"
      className="fixed left-0 top-0 z-30 pointer-events-none select-none will-change-transform"
    >
      <div className="relative flex flex-col items-center">
        {ladybugReaction.mode !== 'patrol' && ladybugReaction.label && (
          <div
            className="mb-1 max-w-[210px] truncate rounded-md border bg-[#0B1220]/95 px-2.5 py-1 font-mono text-[11px] font-medium shadow-lg"
            style={{ borderColor: badgeHex, color: badgeHex }}
          >
            {ladybugReaction.label}
          </div>
        )}
        {webglFallback ? (
          <div className="flex h-16 w-16 items-center justify-center rounded-full border border-[#00F5FF]/40 bg-[#0B1220]/90">
            <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
              <ellipse cx="18" cy="20" rx="10" ry="12" fill="#B91C3A" stroke={badgeHex} strokeWidth="1.5" />
              <line x1="18" y1="9" x2="18" y2="32" stroke="#070B14" strokeWidth="1.5" />
              <circle cx="18" cy="9" r="5" fill="#0D1526" stroke={badgeHex} strokeWidth="1.2" />
              <circle cx="14" cy="18" r="2" fill="#070B14" />
              <circle cx="22" cy="18" r="2" fill="#070B14" />
              <circle cx="15" cy="25" r="1.8" fill="#070B14" />
              <circle cx="21" cy="25" r="1.8" fill="#070B14" />
            </svg>
          </div>
        ) : (
          <div ref={containerRef} className="h-[124px] w-[124px]" />
        )}
      </div>
    </div>
  );
};
