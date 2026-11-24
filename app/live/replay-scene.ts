import {
  BufferAttribute,
  BufferGeometry,
  Color,
  LineSegments,
  NormalBlending,
  PerspectiveCamera,
  Points,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
} from "three";
import { LINK_GROW_SECONDS, PULSE_SECONDS, advanceReplayClock, parseCssColor, type ReplayScene } from "@/lib/replay-scene";

/**
 * The Replay, drawn (docs/spec.md "Live Brain page", Replay). This file is loaded only when
 * someone presses Replay, so the drawing library costs the Live page nothing until then.
 *
 * It stays fast with a long history because nothing is worked out per frame in script: every
 * memory, thread and spark is put on the graphics card once, with the second it appears. A frame
 * sends one number, the replay's clock, and the shaders decide what shows. Five draw calls draw
 * the whole brain, and dragging the time bar costs the same as playing.
 *
 * The ground is light, like every page: the brain is drawn in ink, not in light. So colours lie
 * over each other and never add up to white.
 */

export interface ReplayView {
  play(): void;
  pause(): void;
  /** Jumps to a second of the replay. */
  seek(seconds: number): void;
  /** Turns the brain by this much, in radians: to the side, and up or down. */
  turn(side: number, up: number): void;
  /** Moves closer (a factor under 1) or further away (over 1). */
  zoom(factor: number): void;
  dispose(): void;
}

export interface ReplayViewOptions {
  /** No turning, no breathing, and the finished brain from the start. */
  still: boolean;
  /** Called a few times a second with the replay's clock and whether it is playing. */
  onTick(seconds: number, playing: boolean): void;
  /** Called when the browser takes the drawing away (the graphics card was lost). */
  onLost(): void;
}

const NEURON_VERTEX = /* glsl */ `
  attribute vec3 aColor;
  attribute float aBorn;
  attribute float aGone;
  attribute float aHot;
  attribute float aSize;
  attribute float aSeed;
  uniform float uTime;
  uniform float uWall;
  uniform float uScale;
  uniform float uBreath;
  uniform float uWave;
  uniform float uFar;
  uniform vec3 uInk;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float age = uTime - aBorn;
    if (age < 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    float flash = exp(-age * 2.6);
    float hot = step(aHot, uTime);
    float gone = step(aGone, uTime);
    float breath = 1.0 + uBreath * 0.22 * sin(uWall * 1.6 + aSeed * 6.2832);
    // A wave of ink that runs out from the middle of the brain.
    float wave = exp(-pow((length(position) - uWave) * 7.0, 2.0));
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float size = aSize * (1.0 + hot * 0.35) * (1.0 + flash * 3.4 + wave * 1.4) * breath;
    gl_PointSize = max(1.5, size * uScale / -mv.z);
    // A new memory lands as a drop of its own colour. A reused one is a shade deeper, the wave
    // deeper still, and one that is no longer live fades to grey.
    vec3 tone = mix(aColor, uInk, clamp(hot * 0.16 + wave * 0.55, 0.0, 1.0));
    vColor = mix(tone, vec3(0.62, 0.65, 0.7), gone * 0.85);
    // The far side of the brain is fainter than the near side, so its depth reads.
    float far = clamp((-mv.z - uFar + 1.1) / 2.2, 0.0, 1.0);
    vAlpha = min(1.0, mix(0.78, 0.3, gone) * (1.0 - 0.66 * far) * (1.0 + flash * 0.5 + wave * 0.4));
  }
`;

const DOT_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    // A full middle with a soft edge around it, like a drop of ink on paper.
    float drop = min(1.0, 1.15 * exp(-d * d * 4.5) + 0.2 * exp(-d * d * 1.3));
    gl_FragColor = vec4(vColor, drop * vAlpha);
  }
`;

const LINK_VERTEX = /* glsl */ `
  attribute vec4 aColor;
  attribute float aBorn;
  attribute float aAlong;
  uniform float uTime;
  varying vec4 vColor;
  varying float vAlong;
  varying float vGrown;
  void main() {
    vColor = aColor;
    vAlong = aAlong;
    vGrown = (uTime - aBorn) / ${LINK_GROW_SECONDS.toFixed(2)};
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const LINK_FRAGMENT = /* glsl */ `
  uniform float uOpacity;
  varying vec4 vColor;
  varying float vAlong;
  varying float vGrown;
  void main() {
    if (vGrown < 0.0 || vAlong > vGrown) discard;
    // The growing end is strong, and the thread settles to a faint line.
    float tip = 1.0 - smoothstep(0.0, 0.25, vGrown - vAlong);
    gl_FragColor = vec4(vColor.rgb, min(1.0, vColor.a * uOpacity * (1.0 + tip * 5.0)));
  }
`;

const PULSE_VERTEX = /* glsl */ `
  attribute vec3 aColor;
  attribute vec3 aTo;
  attribute float aStart;
  uniform float uTime;
  uniform float uScale;
  uniform float uDuration;
  uniform float uLoop;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float since = uTime - aStart;
    if (uLoop > 0.0) since = mod(since, uLoop);
    float phase = since / uDuration;
    if (phase < 0.0 || phase > 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    vec3 at = mix(position, aTo, smoothstep(0.0, 1.0, phase));
    vec4 mv = modelViewMatrix * vec4(at, 1.0);
    gl_Position = projectionMatrix * mv;
    float swell = sin(phase * 3.1416);
    gl_PointSize = max(1.5, (1.0 + swell * 1.5) * uScale / -mv.z);
    vColor = aColor;
    vAlpha = 0.35 + 0.65 * swell;
  }
`;

const GHOST_VERTEX = /* glsl */ `
  uniform float uScale;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(1.2, 0.75 * uScale / -mv.z);
  }
`;

const GHOST_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    gl_FragColor = vec4(uColor, uOpacity * exp(-d * d * 3.0));
  }
`;

/** Sparks that keep running once the replay has ended. */
const IDLE_PULSES = 700;
const IDLE_LOOP_SECONDS = 9;
/** One wave of ink every this many seconds once the replay has ended. */
const WAVE_EVERY_SECONDS = 7;

/** Ink over ink: no depth test, so a draw costs nothing but its pixels. */
function inked(vertexShader: string, fragmentShader: string, uniforms: ShaderMaterial["uniforms"]): ShaderMaterial {
  return new ShaderMaterial({ vertexShader, fragmentShader, uniforms, transparent: true, depthTest: false, depthWrite: false, blending: NormalBlending });
}

/**
 * The page's navy, for the deepest ink, and its steel, for the faint outline of the brain. Plain
 * numbers, as the colours of the points are: these shaders write a colour to the screen as given.
 */
const INK = new Vector3(26 / 255, 51 / 255, 96 / 255);
const OUTLINE = new Vector3(63 / 255, 81 / 255, 117 / 255);

/**
 * Draws the replay on the canvas and starts it. Throws when the browser cannot draw it (no WebGL),
 * and the page says so in words.
 */
export function mountReplay(canvas: HTMLCanvasElement, scene: ReplayScene, options: ReplayViewOptions): ReplayView {
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
  const ground = parseCssColor(getComputedStyle(canvas).backgroundColor) ?? [1, 1, 1];
  renderer.setClearColor(new Color().setRGB(ground[0], ground[1], ground[2], SRGBColorSpace), 1);

  const world = new Scene();
  const camera = new PerspectiveCamera(38, 2, 0.05, 50);

  const shared = { uTime: { value: 0 }, uWall: { value: 0 }, uScale: { value: 1 } };

  // ---------- memories ----------
  const neuronGeometry = new BufferGeometry();
  neuronGeometry.setAttribute("position", new BufferAttribute(scene.neurons.position, 3));
  neuronGeometry.setAttribute("aColor", new BufferAttribute(scene.neurons.color, 3, true));
  neuronGeometry.setAttribute("aBorn", new BufferAttribute(scene.neurons.born, 1));
  neuronGeometry.setAttribute("aGone", new BufferAttribute(scene.neurons.gone, 1));
  neuronGeometry.setAttribute("aHot", new BufferAttribute(scene.neurons.hot, 1));
  neuronGeometry.setAttribute("aSize", new BufferAttribute(scene.neurons.size, 1));
  neuronGeometry.setAttribute("aSeed", new BufferAttribute(scene.neurons.seed, 1));
  const neuronMaterial = inked(NEURON_VERTEX, DOT_FRAGMENT, { ...shared, uBreath: { value: 0 }, uWave: { value: -1 }, uFar: { value: 3 }, uInk: { value: INK } });
  const neurons = new Points(neuronGeometry, neuronMaterial);

  // ---------- threads ----------
  const linkGeometry = new BufferGeometry();
  linkGeometry.setAttribute("position", new BufferAttribute(scene.links.position, 3));
  linkGeometry.setAttribute("aColor", new BufferAttribute(scene.links.color, 4, true));
  linkGeometry.setAttribute("aBorn", new BufferAttribute(scene.links.born, 1));
  linkGeometry.setAttribute("aAlong", new BufferAttribute(scene.links.along, 1));
  // Many threads cross on one pixel, so each is fainter when there are more of them.
  const linkOpacity = Math.max(0.07, Math.min(0.5, 10 / Math.sqrt(Math.max(1, scene.links.count))));
  const linkMaterial = inked(LINK_VERTEX, LINK_FRAGMENT, { ...shared, uOpacity: { value: linkOpacity } });
  const links = new LineSegments(linkGeometry, linkMaterial);

  // ---------- sparks ----------
  const pulseGeometry = new BufferGeometry();
  pulseGeometry.setAttribute("position", new BufferAttribute(scene.pulses.from, 3));
  pulseGeometry.setAttribute("aTo", new BufferAttribute(scene.pulses.to, 3));
  pulseGeometry.setAttribute("aColor", new BufferAttribute(scene.pulses.color, 3, true));
  pulseGeometry.setAttribute("aStart", new BufferAttribute(scene.pulses.start, 1));
  const pulseMaterial = inked(PULSE_VERTEX, DOT_FRAGMENT, { ...shared, uDuration: { value: PULSE_SECONDS }, uLoop: { value: 0 } });
  const pulses = new Points(pulseGeometry, pulseMaterial);

  // Once the replay has ended, a few sparks keep running along threads that exist, on a loop.
  const idleCount = Math.min(IDLE_PULSES, scene.links.count);
  const idleFrom = new Float32Array(idleCount * 3);
  const idleTo = new Float32Array(idleCount * 3);
  const idleColor = new Uint8Array(idleCount * 3);
  const idleStart = new Float32Array(idleCount);
  for (let k = 0; k < idleCount; k++) {
    const link = Math.floor(((k * 0.6180339887) % 1) * scene.links.count);
    idleFrom.set(scene.links.position.subarray(link * 6 + 3, link * 6 + 6), k * 3);
    idleTo.set(scene.links.position.subarray(link * 6, link * 6 + 3), k * 3);
    idleColor.set([0, 128, 116], k * 3);
    idleStart[k] = ((k * 0.7548776662) % 1) * IDLE_LOOP_SECONDS;
  }
  const idleGeometry = new BufferGeometry();
  idleGeometry.setAttribute("position", new BufferAttribute(idleFrom, 3));
  idleGeometry.setAttribute("aTo", new BufferAttribute(idleTo, 3));
  idleGeometry.setAttribute("aColor", new BufferAttribute(idleColor, 3, true));
  idleGeometry.setAttribute("aStart", new BufferAttribute(idleStart, 1));
  const idleMaterial = inked(PULSE_VERTEX, DOT_FRAGMENT, {
    uTime: shared.uWall,
    uScale: shared.uScale,
    uDuration: { value: PULSE_SECONDS * 1.6 },
    uLoop: { value: IDLE_LOOP_SECONDS },
  });
  const idle = new Points(idleGeometry, idleMaterial);
  idle.visible = false;

  // ---------- the faint surface ----------
  const ghostGeometry = new BufferGeometry();
  ghostGeometry.setAttribute("position", new BufferAttribute(scene.ghosts, 3));
  const ghostMaterial = inked(GHOST_VERTEX, GHOST_FRAGMENT, { uScale: shared.uScale, uColor: { value: OUTLINE }, uOpacity: { value: 0 } });
  const ghosts = new Points(ghostGeometry, ghostMaterial);

  // The shaders move the points, so the library must not hide a part it believes is off screen.
  for (const part of [ghosts, links, neurons, pulses, idle]) {
    part.frustumCulled = false;
    world.add(part);
  }

  // ---------- the camera ----------
  const first = scene.neurons.count > 0 ? new Vector3(scene.neurons.position[0], scene.neurons.position[1], scene.neurons.position[2]) : new Vector3();
  // A little under the middle, so the stem fits in the frame.
  const centre = new Vector3(0, -0.1, 0);
  const lookAt = new Vector3();
  let yaw = 0.9;
  let pitch = 0.18;
  let zoom = 1;
  let turning = !options.still;
  /** Something changed that the clock does not know of: draw the next frame even at rest. */
  let dirty = true;
  let frame = 0;
  let stopped = false;

  function size() {
    const box = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(box.width));
    const height = Math.max(1, Math.round(box.height));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    // A point's size in pixels at distance 1, so the brain looks the same at any canvas size.
    shared.uScale.value = (height * ratio) / 112;
    dirty = true;
  }
  size();
  const resized = new ResizeObserver(size);
  resized.observe(canvas);

  function turn(side: number, up: number) {
    yaw += side;
    pitch = Math.max(-1.2, Math.min(1.2, pitch + up));
    turning = false;
    dirty = true;
  }
  function zoomBy(factor: number) {
    zoom = Math.max(0.45, Math.min(2.2, zoom * factor));
    dirty = true;
  }

  let drag: { x: number; y: number } | null = null;
  const down = (e: PointerEvent) => {
    drag = { x: e.clientX, y: e.clientY };
    turning = false;
    canvas.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (!drag) return;
    turn(-(e.clientX - drag.x) * 0.006, (e.clientY - drag.y) * 0.005);
    drag = { x: e.clientX, y: e.clientY };
  };
  const up = () => {
    drag = null;
  };
  const wheel = (e: WheelEvent) => {
    const before = zoom;
    zoomBy(e.deltaY > 0 ? 1.08 : 0.93);
    // At the nearest and the furthest the wheel scrolls the page again.
    if (zoom !== before) e.preventDefault();
  };
  const lost = (e: Event) => {
    e.preventDefault();
    stopped = true;
    cancelAnimationFrame(frame);
    options.onLost();
  };
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", wheel, { passive: false });
  canvas.addEventListener("webglcontextlost", lost);

  // ---------- the clock ----------
  let seconds = options.still ? scene.duration : 0;
  let playing = !options.still;
  let wall = 0;
  let endedAt = options.still ? 0 : -1;
  let last = performance.now();
  let lastTick = 0;

  function draw(now: number) {
    if (stopped) return;
    frame = requestAnimationFrame(draw);
    // A tab that was hidden comes back with one long gap: never jump ahead by it.
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    wall += dt;
    if (playing) {
      // Loops: the last REPLAY_TAIL_SECONDS hold the finished brain, then it starts again.
      // Paused, or a still brain nobody pressed Play on, never gets here and stays where it is.
      seconds = advanceReplayClock(seconds, dt, scene.duration);
    }
    const ended = seconds >= scene.duration;
    const progress = scene.duration > 0 ? seconds / scene.duration : 1;

    shared.uTime.value = seconds;
    shared.uWall.value = wall;
    neuronMaterial.uniforms.uBreath.value = ended && !options.still ? 1 : 0;
    // One wave when the replay ends, then one now and then.
    const sinceEnd = ended && !options.still && endedAt >= 0 ? (wall - endedAt) % WAVE_EVERY_SECONDS : -1;
    neuronMaterial.uniforms.uWave.value = sinceEnd >= 0 ? sinceEnd * 0.9 : -1;
    ghostMaterial.uniforms.uOpacity.value = 0.16 + 0.42 * progress * progress;
    idle.visible = ended && !options.still;

    // The brain turns by itself while the replay plays and once it has ended, never while paused.
    if (turning && (playing || ended)) yaw += dt * 0.12;
    // Close to the first memory at the start, then back until the whole brain shows.
    const back = 1 - (1 - Math.min(1, progress / 0.55)) ** 3;
    const distance = (0.9 + 2.75 * back) * zoom * (camera.aspect < 1 ? 1.5 : 1);
    lookAt.copy(first).lerp(centre, Math.min(1, progress / 0.3));
    camera.position.set(lookAt.x + distance * Math.cos(pitch) * Math.sin(yaw), lookAt.y + distance * Math.sin(pitch), lookAt.z + distance * Math.cos(pitch) * Math.cos(yaw));
    camera.lookAt(lookAt);
    neuronMaterial.uniforms.uFar.value = distance;
    // At rest (paused part way, or the still brain) nothing is drawn again until something changes.
    if (playing || idle.visible || dirty) {
      renderer.render(world, camera);
      dirty = false;
    }

    if (now - lastTick > 120) {
      lastTick = now;
      options.onTick(seconds, playing);
    }
  }
  frame = requestAnimationFrame(draw);

  return {
    play() {
      if (seconds >= scene.duration) seconds = 0;
      endedAt = -1;
      playing = true;
    },
    pause() {
      playing = false;
      dirty = true;
    },
    seek(to: number) {
      seconds = Math.max(0, Math.min(scene.duration, to));
      // Dragging to the very end shows the finished brain and pauses there, so it is not wrapped at once.
      if (seconds >= scene.duration) playing = false;
      endedAt = seconds >= scene.duration ? wall : -1;
      dirty = true;
      options.onTick(seconds, playing);
    },
    turn,
    zoom: zoomBy,
    dispose() {
      stopped = true;
      cancelAnimationFrame(frame);
      resized.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("webglcontextlost", lost);
      for (const geometry of [neuronGeometry, linkGeometry, pulseGeometry, idleGeometry, ghostGeometry]) geometry.dispose();
      for (const material of [neuronMaterial, linkMaterial, pulseMaterial, idleMaterial, ghostMaterial]) material.dispose();
      // Hands the graphics context back at once: a browser allows only a few at a time.
      renderer.forceContextLoss();
      renderer.dispose();
    },
  };
}
