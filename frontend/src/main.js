/**
 * Entry point: 3D scene + VRM avatar, WebSocket, inputs, UI, segment queue.
 *
 * Milestone 5: the segment queue drives everything — audio plays through an
 * AnalyserNode for lip sync, and the segment's emotion is applied (with a
 * crossfade) at the exact moment its audio starts. Interrupt flushes the
 * queue, stops audio, and eases the face back to neutral within ~0.3 s.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

import { WSClient } from "./ws.js";
import { UI } from "./ui.js";
import { initInput } from "./input.js";
import { AnimationController } from "./animations.js";
import { MotionController } from "./motion.js";
import { ExpressionController } from "./expressions.js";
import { LipSync } from "./lipsync.js";
import { GlitchIntro } from "./intro.js";
import { CameraDirector } from "./camera.js";
import { VirtualWorld } from "./world.js";
import { Hologram } from "./hologram.js";
import { Sidebar } from "./sidebar.js";
import { DebugOverlay } from "./debug.js"; // temporary — Step 2 diagnosis

// Outfits = whole VRM swaps. "Default" is always shown; the rest appear only
// if their file exists under assets/outfits/. Add entries here for more.
const OUTFITS = [
  { name: "Default", url: "/character.vrm" },
  { name: "Casual", url: "/Kanee_casual_outfit.vrm" },
  // Add more here; files live under assets/ (served at the web root). Entries
  // whose file is missing are probed out and hidden from the sidebar.
  { name: "Uniform", url: "/kanee_uniform_outfit.vrm" },
  { name: "Dress", url: "/kanee_dress_outfit.vrm" },
];

// Emotes = one-shot expression clips under assets/emotes/. Registered as
// gestures and offered in the sidebar; missing files are skipped gracefully.
const EMOTES = [
  { key: "emote_kawaii", label: "Kawaii", url: "/emotes/Kawaii%20Kaiwai.vrma" },
];

/** HEAD-probe a static URL so the sidebar only lists outfits that exist. */
async function urlExists(url) {
  try {
    const r = await fetch(url, { method: "HEAD" });
    return r.ok;
  } catch {
    return false;
  }
}

async function probeOutfits() {
  const available = [];
  for (const o of OUTFITS) {
    if (o.url === "/character.vrm" || (await urlExists(o.url))) available.push(o);
  }
  return available;
}

// Avatar modules appear here once the VRM finishes loading; everything that
// uses them must tolerate null (VRM missing → chat-only mode still works).
const avatar = {
  vrm: null,
  animations: null,
  motion: null,
  expressions: null,
  lipsync: null,
  cameraDirector: null,
  hologram: null,
  controls: null,
};

// ---------------------------------------------------------------------------
// segment queue — strictly ordered playback through Web Audio
// ---------------------------------------------------------------------------

class SegmentPlayer {
  /**
   * @param onChange       playing-state changed (drives the state pill)
   * @param onSegmentStart a segment's audio (or text-only hold) just started
   * @param onSegmentAudio (seg, duration) — audio decoded, about to play
   * @param onAudioEnd     a segment's audio stopped (ended or flushed)
   * @param onAnalyser     the shared AnalyserNode exists now (lazy)
   */
  constructor({ onChange, onSegmentStart, onSegmentAudio, onAudioEnd, onAnalyser }) {
    this._onChange = onChange;
    this._onSegmentStart = onSegmentStart;
    this._onSegmentAudio = onSegmentAudio;
    this._onAudioEnd = onAudioEnd;
    this._onAnalyser = onAnalyser;
    this._queue = [];
    this._busy = false;
    this._source = null;
    this._holdTimer = null;
    this._gen = 0; // bumped on flush; orphans async work from before the flush
    this._ctx = null;
    this.analyser = null;
  }

  get playing() {
    return this._busy || this._queue.length > 0;
  }

  /** seg: {text, emotion, gesture, audio: base64|null} */
  enqueue(seg) {
    this._queue.push(seg);
    this._next();
  }

  /** Interrupt: drop the queue and stop the current segment immediately. */
  flush() {
    this._gen++;
    this._queue.length = 0;
    if (this._holdTimer !== null) {
      clearTimeout(this._holdTimer);
      this._holdTimer = null;
    }
    if (this._source) {
      try {
        this._source.stop();
      } catch {
        /* already stopped */
      }
      this._source = null;
      this._onAudioEnd?.();
    }
    this._busy = false;
    this._onChange();
  }

  _ensureCtx() {
    if (!this._ctx) {
      this._ctx = new AudioContext();
      this.analyser = this._ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0; // lipsync does its own smoothing
      this.analyser.connect(this._ctx.destination);
      this._onAnalyser(this.analyser);
    }
    if (this._ctx.state === "suspended") this._ctx.resume();
    return this._ctx;
  }

  async _next() {
    if (this._busy || this._queue.length === 0) return;
    this._busy = true;
    const gen = this._gen;
    const seg = this._queue.shift();
    this._onChange();
    this._onSegmentStart(seg);

    if (seg.audio || seg.audioUrl) {
      try {
        const ctx = this._ensureCtx();
        let arrayBuf;
        if (seg.audio) {
          arrayBuf = Uint8Array.from(atob(seg.audio), (c) => c.charCodeAt(0)).buffer;
        } else {
          const resp = await fetch(seg.audioUrl); // local greeting file
          if (!resp.ok) throw new Error(`audio ${seg.audioUrl} → ${resp.status}`);
          arrayBuf = await resp.arrayBuffer();
        }
        const buffer = await ctx.decodeAudioData(arrayBuf);
        if (gen !== this._gen) return; // flushed while decoding
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.analyser);
        source.onended = () => {
          if (this._source !== source) return; // flushed
          this._source = null;
          this._onAudioEnd?.();
          this._busy = false;
          this._onChange();
          this._next();
        };
        this._source = source;
        this._onSegmentAudio?.(seg, buffer.duration);
        source.start();
        return;
      } catch (err) {
        console.warn("segment audio failed, showing text only:", err);
        if (gen !== this._gen) return;
      }
    }

    // Text-only segment: hold roughly as long as reading it would take, so
    // the expression doesn't flash by when TTS is down.
    const holdMs = Math.min(5000, Math.max(900, seg.text.length * 55));
    this._holdTimer = setTimeout(() => {
      this._holdTimer = null;
      this._busy = false;
      this._onChange();
      this._next();
    }, holdMs);
  }
}

// ---------------------------------------------------------------------------
// 3D avatar
// ---------------------------------------------------------------------------

async function initAvatar(ui) {
  const viewport = document.getElementById("viewport");
  const msgEl = document.getElementById("viewport-msg");
  const hologram = new Hologram(viewport);
  avatar.hologram = hologram;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  viewport.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05050a);
  const world = new VirtualWorld(scene); // sky, grid floor, pad, particles

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  camera.position.set(0, 1.32, 1.4); // provisional — reframed from the model after load

  // Nudging the camera doubles as the manual test for look-at + spring bones.
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.28, 0);
  controls.enableDamping = true;
  controls.minDistance = 0.5;
  controls.maxDistance = 4;
  controls.maxPolarAngle = Math.PI * 0.6;
  controls.enablePan = false;
  avatar.controls = controls; // exposed so zoom can be locked during hidden animations

  const intro = new GlitchIntro(renderer, scene, camera);
  let frontAzimuth = controls.getAzimuthalAngle(); // camera angle where she faces front

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(0.6, 1.8, 1.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x8899cc, 0.5);
  fill.position.set(-1.2, 0.8, -0.8);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = viewport;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(viewport);
  resize();

  // Camera director persists across outfit swaps; framing is captured once.
  const director = new CameraDirector(camera, controls);
  avatar.cameraDirector = director;

  const loader = new GLTFLoader();
  loader.register((p) => new VRMLoaderPlugin(p));

  // Full gesture spec (protocol + idle fidgets + math + emotes). Rebuilt per
  // model load because clips retarget to the specific VRM humanoid.
  function gestureSpec() {
    const spec = {
      // protocol gestures (LLM-triggered)
      wave: "/animations/wave.vrma",
      nod: "/animations/nod.vrma",
      shake: "/animations/shake.vrma",
      think: "/animations/think.vrma",
      clap: "/animations/clap.vrma",
      bounce: "/animations/bounce.vrma",
      tilt: "/animations/tilt.vrma",
      lean_in: "/animations/lean_in.vrma",
      fidget: "/animations/fidget.vrma",
      peace: "/animations/peace.vrma",
      // cheering-on / "don't give up!" gesture
      encourage: "/animations/don't_give_up.vrma",
      // extra clips, used only as idle fidgets (never sent by the LLM)
      thankful: "/animations/thankful.vrma",
      thoughtful_nod: "/animations/thoughtful_nod.vrma",
      // full 360° turn to show the outfit: solo so the half-turned pose never
      // blends against the idle (that's antipodal and stutters around 180°).
      show_full_body: { url: "/animations/Show_full_body.vrma", solo: true },
      // full-body, precise: near-full weight so the body lean reads and the
      // hand reaches the head; keepRoot replays the baked forward step as a
      // smooth avatar translation (no pop), then glides home when done.
      tidy_up_hair: { url: "/animations/tidy_up_hair.vrma", blend: 0.97, keepRoot: true },
      // math-answer presenting gesture (paired with the hologram)
      answare_math: "/animations/answare_math.vrma",
    };
    for (const e of EMOTES) spec[e.key] = e.url; // emotes play through the gesture path
    return spec;
  }

  /** Build a fresh controller set bound to `vrm` (not yet swapped into avatar). */
  async function buildControllers(vrm) {
    const animations = new AnimationController(vrm);
    await animations.loadIdles([
      "/animations/idle_01.vrma",
      // idle_02 removed from rotation: clip motion wasn't smooth (user call).
      "/animations/idle_03.vrma",
    ]);
    animations.start();
    await animations.loadGestures(gestureSpec());
    // Hidden idle animations: occasionally play one when she's been still.
    animations.setFidgetPool(["peace", "think", "thankful", "thoughtful_nod", "show_full_body", "tidy_up_hair"]);
    await animations.loadStateLoops({
      speaking: "/animations/explain.vrma", // the talking/explaining body animation
      listening: "/animations/listening_01.vrma",
      thinking: "/animations/thinking_01.vrma",
    });
    const lipsync = new LipSync(vrm);
    const motion = new MotionController(vrm, camera, scene, {
      speechLevel: () => avatar.lipsync?.level ?? 0,
      onEmphasis: () => avatar.expressions?.pulseEmphasis(),
    });
    const expressions = new ExpressionController(vrm, motion);
    // Gesture clips get anticipation + release overshoot from the procedural layer.
    animations.onGestureStart = () => avatar.motion?.anticipate();
    animations.onGestureEnd = () => avatar.motion?.gestureRelease();
    return { animations, motion, expressions, lipsync };
  }

  /**
   * Make `vrm` (with its freshly built controllers) the active avatar. Atomic
   * and synchronous — the render loop never sees a half-built state — and the
   * previous model's GPU resources are freed.
   */
  function swapIn(vrm, built) {
    const old = avatar.vrm;
    if (!vrm.scene.parent) scene.add(vrm.scene);
    vrm.scene.visible = true;
    avatar.vrm = vrm;
    avatar.animations = built.animations;
    avatar.motion = built.motion;
    avatar.expressions = built.expressions;
    avatar.lipsync = built.lipsync;
    avatar.expressions.speaking = backendState === "speaking";
    if (player.analyser) avatar.lipsync.setAnalyser(player.analyser);
    debug.attach(vrm, () => avatar.lipsync?.level ?? 0);
    if (old && old !== vrm) {
      scene.remove(old.scene);
      VRMUtils.deepDispose(old.scene); // free the previous outfit's GPU resources
    }
    refreshState(); // resync the fresh controllers to the current chat state
  }

  /**
   * Load a VRM and bring it in. firstLoad frames the camera and plays the spawn
   * intro; outfit swaps instead keep the camera and present an RPG-style
   * transformation flash (no full intro, so it doesn't feel like a reload).
   * The new model + controllers are built BEFORE the swap, so the render loop
   * keeps driving the current model until the new one is fully ready.
   */
  async function loadOutfit(url, firstLoad) {
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm); // VRM 0.x faces -Z; make every model face the camera
    vrm.scene.traverse((obj) => (obj.frustumCulled = false)); // avoids mesh pop-out

    const built = await buildControllers(vrm);

    if (firstLoad) {
      // Auto-frame from the model's actual proportions: eye-level camera at
      // portrait distance, face in the upper third.
      vrm.scene.updateMatrixWorld(true);
      const headNode =
        vrm.humanoid?.getNormalizedBoneNode("head") ?? vrm.humanoid?.getRawBoneNode("head");
      if (headNode) {
        const headPos = new THREE.Vector3();
        headNode.getWorldPosition(headPos);
        const eyeY = headPos.y + 0.06;            // head bone sits at the neck end
        camera.position.set(0, eyeY, 1.05);       // eye-level, bust-up distance
        controls.target.set(0, eyeY - 0.15, 0);   // aim at upper chest → face upper third
        controls.update();
      }
      director.frameFromModel(vrm.scene);
      director.setHome(); // the bust-up framing is the default view to snap back to
      frontAzimuth = controls.getAzimuthalAngle();
      swapIn(vrm, built);
      // First spawn only: glitch-materialize, then wave hello with a smile.
      intro.onWelcome = playWelcome;
      intro.begin(vrm.scene);
      console.info("avatar ready");
      return;
    }

    // Outfit change: swap straight in — no intro, no transition effect.
    swapIn(vrm, built);
    console.info(`outfit changed: ${url}`);
  }

  setOutfit = (url) => loadOutfit(url, false);

  try {
    await loadOutfit("/character.vrm", true);
    // Populate the sidebar now that the model + its clips are known.
    sidebar.setEmotes(EMOTES.filter((e) => avatar.animations?.hasGesture(e.key)));
    sidebar.setOutfits(await probeOutfits(), "/character.vrm");
  } catch (err) {
    console.warn("could not load /character.vrm:", err);
    msgEl.hidden = false;
    msgEl.textContent =
      "No avatar loaded.\nPut your model at assets/character.vrm and reload — chat works either way.";
    ui.toast("character.vrm not found in assets/ — running chat-only.");
  }

  // Foot-driven ground scroll during emotes: the world slides following the
  // horizontal movement of the feet, so an emote dance reads as motion.
  const FOOT_SCROLL_GAIN = 3.5;
  const _footNow = new THREE.Vector3();
  const _lf = new THREE.Vector3();
  let _prevFoot = null;
  function scrollWorldFromFeet() {
    if (!emoteActive || !avatar.vrm) {
      _prevFoot = null;
      return;
    }
    // Raw bones live in vrm.scene, so the renderer keeps their world matrices
    // fresh (the normalized rig is a separate hierarchy and would be stale).
    const h = avatar.vrm.humanoid;
    const left = h?.getRawBoneNode("leftFoot");
    const right = h?.getRawBoneNode("rightFoot");
    if (!left || !right) return;
    left.getWorldPosition(_footNow);
    right.getWorldPosition(_lf);
    _footNow.add(_lf).multiplyScalar(0.5); // midpoint of the two feet
    if (_prevFoot) {
      world.addScroll(
        (_footNow.x - _prevFoot.x) * FOOT_SCROLL_GAIN,
        (_footNow.z - _prevFoot.z) * FOOT_SCROLL_GAIN,
      );
    } else {
      _prevFoot = new THREE.Vector3();
    }
    _prevFoot.copy(_footNow);
  }

  // Head-follow: she turns toward the orbit camera up to a comfortable limit,
  // then eases back to front as the camera passes around behind her.
  const HEAD_FOLLOW_MAX = 68;    // deg — most she'll turn her head
  const HEAD_RETURN_START = 95;  // deg — camera angle where she starts facing front again
  const HEAD_RETURN_END = 150;   // deg — fully front again past here
  const HEAD_FOLLOW_SIGN = 1;    // flip to -1 if she turns AWAY from the camera
  function updateHeadFollow() {
    if (!avatar.motion) return;
    let theta = controls.getAzimuthalAngle() - frontAzimuth;
    theta = Math.atan2(Math.sin(theta), Math.cos(theta)); // wrap to [-π, π]
    const aDeg = (Math.abs(theta) * 180) / Math.PI;
    let magDeg;
    if (aDeg <= HEAD_RETURN_START) {
      magDeg = Math.min(aDeg, HEAD_FOLLOW_MAX);
    } else if (aDeg < HEAD_RETURN_END) {
      const base = Math.min(HEAD_RETURN_START, HEAD_FOLLOW_MAX);
      const t = (aDeg - HEAD_RETURN_START) / (HEAD_RETURN_END - HEAD_RETURN_START);
      magDeg = base * (1 - t * t * (3 - 2 * t)); // smoothstep back to 0
    } else {
      magDeg = 0; // behind her — face front
    }
    avatar.motion.headFollowTarget =
      Math.sign(theta) * ((magDeg * Math.PI) / 180) * HEAD_FOLLOW_SIGN;
  }

  // -- click / tap to pat the character ---------------------------------------
  // Screen-space picking (NOT mesh raycasting): projecting a handful of bones
  // each move is cheap, whereas raycasting the skinned mesh recomputes every
  // skinned vertex on the CPU and lags hard on hover.
  const proj = new THREE.Vector3();
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  // Hover-box span: head TOP (the head bone sits down at face level, so raise
  // it to the crown) + extremities, so the box covers her hair down to her feet.
  const SPAN = [
    ["head", 0.18], ["hips", 0],
    ["leftHand", 0], ["rightHand", 0],
    ["leftFoot", 0], ["rightFoot", 0],
  ];
  // Tap regions [name, bone, raise]. The head bone is at face height, so the
  // pat ("head") is anchored ABOVE it (the crown) and the face is its own
  // region just below — patting the top vs poking the face now differ.
  const REGIONS = [
    ["head", "head", 0.16],
    ["face", "head", 0.02],
    ["chest", "chest", 0],
    ["hand", "leftHand", 0],
    ["hand", "rightHand", 0],
    ["lower", "hips", 0],
  ];
  let downX = 0;
  let downY = 0;
  let downT = 0;
  let lastHover = 0;

  /** Project a humanoid bone (optionally raised `up` metres) to screen pixels. */
  function projectBone(boneName, up, domRect) {
    const node = avatar.vrm?.humanoid?.getRawBoneNode(boneName);
    if (!node) return null;
    node.getWorldPosition(proj);
    if (up) proj.addScaledVector(WORLD_UP, up);
    proj.project(camera);
    if (proj.z > 1) return null; // behind the camera
    return {
      x: domRect.left + (proj.x * 0.5 + 0.5) * domRect.width,
      y: domRect.top + (-proj.y * 0.5 + 0.5) * domRect.height,
    };
  }

  /** The tapped body region, or null if the pointer isn't on the character. */
  function regionAt(clientX, clientY) {
    if (!avatar.vrm) return null;
    const domRect = renderer.domElement.getBoundingClientRect();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let any = false;
    for (const [bone, up] of SPAN) {
      const p = projectBone(bone, up, domRect);
      if (!p) continue;
      any = true;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if (!any) return null;
    const padX = 45;
    const padY = 30;
    if (clientX < minX - padX || clientX > maxX + padX) return null;
    if (clientY < minY - padY || clientY > maxY + padY) return null;
    let best = "chest";
    let bestD = Infinity;
    for (const [region, bone, up] of REGIONS) {
      const p = projectBone(bone, up, domRect);
      if (!p) continue;
      const d = Math.hypot(p.x - clientX, p.y - clientY);
      if (d < bestD) {
        bestD = d;
        best = region;
      }
    }
    return best;
  }

  renderer.domElement.addEventListener("pointerdown", (e) => {
    downX = e.clientX;
    downY = e.clientY;
    downT = performance.now();
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    // A tap, not an orbit-drag: little movement and quick.
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
    if (performance.now() - downT > 400) return;
    const region = regionAt(e.clientX, e.clientY);
    if (region) triggerReaction(region);
  });
  // Hover cue so it's discoverable that she's pokeable (throttled).
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (e.buttons !== 0) return; // not while dragging the camera
    const now = performance.now();
    if (now - lastHover < 60) return;
    lastHover = now;
    renderer.domElement.style.cursor = regionAt(e.clientX, e.clientY) ? "pointer" : "";
  });

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    // When the tab is minimized/backgrounded the render loop pauses, so the
    // first frame back reports a huge raw delta (minutes). Clamp it so the
    // mixer/motion damping don't lurch — and on such a resume, RESET the spring
    // bones so the sim snaps to the current pose with zero velocity instead of
    // integrating the giant gap (which flings the hair/skirt up).
    const rawDelta = clock.getDelta();
    const delta = Math.min(rawDelta, 0.05);
    const resumed = rawDelta > 0.5;
    // The cinematic director owns the camera while moving; otherwise OrbitControls.
    const cinematic = avatar.cameraDirector ? avatar.cameraDirector.update(delta) : false;
    if (!cinematic) controls.update();
    updateHeadFollow();                                    // head tracks the orbit camera
    scrollWorldFromFeet();                                 // reads last frame's foot matrices
    world.update(delta);                                    // backdrop motes/pad/scroll
    if (avatar.animations) avatar.animations.update(delta); // layer 1+2: mixer
    if (avatar.motion) avatar.motion.update(delta);         // layer 3: procedural additive
    if (avatar.expressions) avatar.expressions.update(delta);
    if (avatar.lipsync) avatar.lipsync.update(delta);
    if (avatar.vrm) {
      if (resumed) avatar.vrm.springBoneManager?.reset();   // skip the catch-up explosion
      avatar.vrm.update(delta);                             // look-at, expressions, spring bones
    }
    if (avatar.motion) avatar.motion.revert();              // offsets must never accumulate
    hologram.update(camera);                                // re-project the fixed math hologram
    debug.update(delta);
    if (intro.active) {
      intro.update(delta);
      intro.render(); // post-processed glitch frame during the spawn
    } else {
      renderer.render(scene, camera);
    }
  });
}

// ---------------------------------------------------------------------------
// chat wiring
// ---------------------------------------------------------------------------

const ui = new UI();
const ws = new WSClient();
const debug = new DebugOverlay();

// Customization sidebar: outfit swap + emote picker (wired to the avatar below).
let setOutfit = async () => {}; // assigned once the avatar pipeline initializes
const sidebar = new Sidebar({
  onOutfit: (url) => setOutfit(url),
  onEmote: (key) => triggerEmote(key),
});

let backendState = "idle";
let micHeld = false;
let emoteActive = false; // true while an emote clip plays — drives the foot→ground scroll
const HOLOGRAM_DELAY = 8160;  // ms into answare_math when the hand reaches the display pose
const HOLOGRAM_LINGER = 5000; // ms the answer screen stays up after it appears
let pendingMath = null;  // {expr, answer} from a "math" event, until the reply's first segment
let mathAnswer = null;   // {expr, answer} held until the hologram appears (8.16 s into the clip)
let mathActive = false;  // presenting a math answer (hold pose/expression, no per-sentence gestures)
let mathHoldTimer = null; // delay-to-show, then reused as the linger-to-hide timer

/** The hologram appears partway through answare_math (hand in display pose), then lingers. */
function showMathHologram() {
  if (!mathActive || !mathAnswer) return;
  avatar.hologram?.show(mathAnswer.expr, mathAnswer.answer, avatar.vrm);
  mathAnswer = null;
  clearTimeout(mathHoldTimer);
  mathHoldTimer = setTimeout(() => {
    mathHoldTimer = null;
    mathActive = false;
    avatar.hologram?.hide();
    if (!player.playing) {
      avatar.expressions?.reset();
      avatar.motion?.setEmotion("neutral");
    }
  }, HOLOGRAM_LINGER);
}

/** Tear down the math presentation immediately (interrupt / error / new msg). */
function endMath() {
  mathActive = false;
  pendingMath = null;
  mathAnswer = null;
  clearTimeout(mathHoldTimer);
  mathHoldTimer = null;
  avatar.hologram?.hide();
}

// After a reply finishes, the last emotion lingers briefly (a natural
// trailing reaction), then the face settles back to neutral. Without this
// she'd hold e.g. [surprised] — wide-eyed, blink suppressed — forever.
const CALM_DOWN_MS = 1800;
let calmTimer = null;

const player = new SegmentPlayer({
  onChange: () => {
    refreshState();
    // explain.vrma (the speaking base loop) is the talking body language now,
    // so auto conversational gesture clips stay off — they'd interrupt it.
    // LLM per-sentence gestures still play over it via onSegmentStart.
    if (!player.playing) {
      // During a math answer the presentation owns the teardown (synced to the
      // animation length), so don't let the calm timer reset her early.
      if (mathActive) {
        clearTimeout(calmTimer);
        calmTimer = null;
      } else {
        // Queue drained naturally: linger, then ease back to neutral.
        clearTimeout(calmTimer);
        calmTimer = setTimeout(() => {
          calmTimer = null;
          avatar.expressions?.reset();
          avatar.motion?.setEmotion("neutral");
        }, CALM_DOWN_MS);
      }
    } else if (calmTimer !== null) {
      // More audio arrived (still streaming) — keep the current emotion.
      clearTimeout(calmTimer);
      calmTimer = null;
    }
    // Between sentences nothing resets: each segment's emotion holds until
    // the next one arrives (anime-timing spec).
  },
  onSegmentStart: (seg) => {
    // Emotion and gesture apply the moment the segment's audio starts (protocol).
    avatar.expressions?.setEmotion(seg.emotion);
    avatar.motion?.setEmotion(seg.emotion);
    avatar.animations?.setEmotion(seg.emotion);
    // Math answer: on the reply's first segment, present with answare_math
    // + the floating hologram showing the answer.
    if (pendingMath) {
      // Play answare_math now; the hologram pops in 8.16 s later, when her hand
      // reaches the display pose in the clip.
      mathActive = true;
      mathAnswer = pendingMath;
      pendingMath = null;
      avatar.animations?.playGesture("answare_math", { replace: true });
      clearTimeout(mathHoldTimer);
      mathHoldTimer = setTimeout(showMathHologram, HOLOGRAM_DELAY);
      return; // hold the presenting pose; skip the per-sentence gesture
    }
    // While presenting a math answer, keep the hand on the hologram (don't
    // let per-sentence gestures pull it away).
    if (mathActive) return;
    // replace:true keeps gestures in sync with the sentence being SPOKEN;
    // cooldown:true paces them so a run of short sentences plays one clean
    // gesture and lets it breathe instead of churning bounce→wave→lean_in.
    if (seg.gesture) avatar.animations?.playGesture(seg.gesture, { replace: true, cooldown: true });
  },
  onSegmentAudio: (seg, duration) => {
    // The segment's text drives the mouth-shape track for its audio.
    avatar.lipsync?.beginSegment(seg.text, duration);
  },
  onAudioEnd: () => {
    avatar.lipsync?.endSegment();
  },
  onAnalyser: (analyser) => {
    if (avatar.lipsync) avatar.lipsync.setAnalyser(analyser);
  },
});

/** listening (mic held) > speaking (audio playing) > whatever backend says. */
function refreshState() {
  let state = backendState;
  if (micHeld) state = "listening";
  else if (player.playing) state = "speaking";
  ui.setState(state);
  avatar.motion?.setState(state);     // attentive lean-in / think pose / etc.
  avatar.animations?.setState(state); // state base loops (talk/listen/think) if provided
  if (avatar.expressions) avatar.expressions.speaking = state === "speaking";
}

ws.onConnection((ok) => {
  ui.setConnected(ok);
  if (!ok) {
    backendState = "idle";
    refreshState();
  }
});

ws.on("state", (msg) => {
  backendState = msg.value;
  refreshState();
});
ws.on("transcript", (msg) => ui.addUserMessage(msg.text, { voice: true }));
ws.on("math", (msg) => {
  // Arithmetic question detected; answare_math + the timed hologram fire when
  // the reply's first segment arrives.
  pendingMath = { expr: msg.expr, answer: msg.answer };
});
ws.on("segment", (msg) => {
  ui.addSegment(msg);
  player.enqueue(msg);
});
ws.on("reply_done", () => {
  // The hologram is on its own 8.16 s timer from when the animation started,
  // so nothing to show here — just drop a math answer that never got a segment.
  if (!mathActive) pendingMath = null;
});
ws.on("error", (msg) => {
  ui.toast(msg.message);
  endMath();
});

/** User is starting a new message — cut off any reply in progress. */
function interruptIfBusy() {
  if (player.playing || backendState === "thinking" || backendState === "speaking") {
    ws.send({ type: "interrupt" });
    player.flush();
    // Interrupt eases everything back to neutral immediately (no linger).
    clearTimeout(calmTimer);
    calmTimer = null;
    avatar.expressions?.reset();
    avatar.motion?.setEmotion("neutral");
    avatar.animations?.cancelGestures();
    endMath(); // drop any math hologram immediately
  }
}

function sendOrToast(msg) {
  if (!ws.send(msg)) {
    ui.toast("Not connected to the backend — is it running? (py -m uvicorn main:app --port 8000)");
  }
}

// ---------------------------------------------------------------------------
// greetings — time-aware + initiative-aware. She greets you when you arrive
// (on the first interaction, since browsers block audio until then) and again
// when you come back to the tab after being away a while.
//
// VOICE FILES (you record these): assets/greetings/<slot>.wav — served at
// /greetings/<slot>.wav. Slots: morning, afternoon, evening, night,
// welcome_back. Edit the text/emotion/gesture below to match what you record.
// If a file is missing, the line still shows + she gestures (just no voice).
// ---------------------------------------------------------------------------

const GREETINGS = {
  morning: { text: "Good morning! Did you sleep okay?", emotion: "happy", gesture: "wave" },
  afternoon: { text: "Good afternoon! How's your day going?", emotion: "happy", gesture: "wave" },
  evening: { text: "Good evening! Welcome back.", emotion: "happy", gesture: "wave" },
  night: { text: "It's getting late... don't stay up too long, okay?", emotion: "curious", gesture: "tilt" },
  welcome_back: { text: "Oh, you're back! I missed you.", emotion: "excited", gesture: "bounce" },
};

/** Local time → greeting slot. */
function timeSlot() {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return "morning";
  if (h >= 11 && h < 17) return "afternoon";
  if (h >= 17 && h < 22) return "evening";
  return "night";
}

/** Speak a greeting through the normal segment pipeline (voice + lip sync +
 *  expression + gesture + caption). Skipped if she's busy. */
function playGreeting(slot) {
  const g = GREETINGS[slot];
  if (!g) return;
  if (player.playing || micHeld || backendState !== "idle") return;
  const seg = {
    text: g.text,
    emotion: g.emotion,
    gesture: g.gesture,
    audioUrl: `/greetings/${slot}.wav`,
  };
  ui.newReply();
  ui.addSegment(seg);
  player.enqueue(seg);
}

// Arrival greeting: deferred to the first user interaction because browser
// autoplay policy keeps the AudioContext suspended until then.
let greeted = false;
function fireArrivalGreeting() {
  if (greeted) return;
  greeted = true;
  window.removeEventListener("pointerdown", fireArrivalGreeting);
  window.removeEventListener("keydown", fireArrivalGreeting);
  // Small delay so the just-resumed AudioContext is ready; the greeting itself
  // carries the hello wave (the spawn no longer waves, so there's no double-up).
  setTimeout(() => playGreeting(timeSlot()), 200);
}
window.addEventListener("pointerdown", fireArrivalGreeting);
window.addEventListener("keydown", fireArrivalGreeting);

// Welcome-back: greet again when the tab regains focus after being away a while.
const AWAY_MS = 5 * 60 * 1000;
let hiddenAt = null;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    hiddenAt = Date.now();
  } else {
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = null;
    if (greeted && away > AWAY_MS) playGreeting("welcome_back");
  }
});

// ---------------------------------------------------------------------------
// emotes — chosen from the sidebar; play the clip + a brief happy expression
// and pull the camera out to a full-body shot for its duration
// ---------------------------------------------------------------------------

let emoteCalmTimer = null;
let emoteActiveTimer = null;

/** On first materialize: just a warm smile. The hello WAVE + spoken line come
 *  from the arrival greeting (on first interaction), so we don't wave twice. */
function playWelcome() {
  avatar.expressions?.setEmotion("happy");
  avatar.motion?.setEmotion("happy");
  clearTimeout(emoteCalmTimer);
  emoteCalmTimer = setTimeout(() => {
    if (!player.playing) {
      avatar.expressions?.reset();
      avatar.motion?.setEmotion("neutral");
    }
  }, 3000);
}

/** Play an emote clip by gesture key (called by the sidebar emote picker). */
function triggerEmote(key) {
  // Clear any hidden animation in progress so the emote doesn't collide with
  // it: a procedural fidget's impulses are dropped, and an active clip fidget
  // is replaced (faded out) rather than queued behind.
  avatar.motion?.clearImpulses();
  const dur = avatar.animations?.playGesture(key, { replace: true }) || 3;
  avatar.expressions?.playEmote(dur); // held smile, eyes open (no blink/winks)
  avatar.motion?.setEmotion("happy"); // happy body posture
  // Pull the camera out to a full-body shot for the length of the clip
  // (+ time for the ease-out and ease-back) so the whole emote is visible.
  avatar.cameraDirector?.showFull(dur + 0.3);
  // Ground follows her feet only while the clip itself is playing.
  emoteActive = true;
  clearTimeout(emoteActiveTimer);
  emoteActiveTimer = setTimeout(() => {
    emoteActive = false;
  }, dur * 1000);
  clearTimeout(emoteCalmTimer);
  emoteCalmTimer = setTimeout(() => {
    // Don't stomp a reply that started playing in the meantime.
    if (!player.playing) {
      avatar.expressions?.reset();
      avatar.motion?.setEmotion("neutral");
    }
  }, (dur + 0.6) * 1000);
}

// ---------------------------------------------------------------------------
// poke / pat — click the character's body for a cute reaction (visual only,
// no backend round-trip). Only while idle, so it never fights a spoken reply.
// ---------------------------------------------------------------------------

let reactionCalmTimer = null;

/** React to a tap on a body region: expression + gesture + a little motion. */
function triggerReaction(region) {
  if (!avatar.expressions || player.playing || micHeld || emoteActive) return;
  const m = avatar.motion;
  let emotion = "surprised";
  let gesture = null;
  switch (region) {
    case "head": // pat the crown → happy giggle, duck the head a little
      emotion = "happy";
      m?.impulseRot("head", "x", 0.16, 0.12, 0.6);
      m?.impulseRot("neck", "x", 0.07, 0.12, 0.6);
      break;
    case "face": // poke the face → bashful, turns away with a blush
      emotion = "shy";
      m?.impulseRot("head", "y", 0.18, 0.12, 0.7);
      m?.impulseRot("head", "x", -0.04, 0.12, 0.6);
      break;
    case "chest": // poke the torso → startled little bounce
      emotion = "surprised";
      gesture = "bounce";
      m?.impulseRot("spine", "x", -0.12, 0.07, 0.5);
      break;
    case "hand": // tap a hand → playful
      emotion = "happy";
      gesture = "peace";
      break;
    case "lower": // poke low → pout and turn away
      emotion = "pout";
      m?.impulseRot("head", "y", 0.22, 0.12, 0.7);
      break;
  }
  avatar.expressions.setEmotion(emotion);
  m?.setEmotion(emotion);
  if (gesture) avatar.animations?.playGesture(gesture, { replace: true });
  lastActivityAt = Date.now(); // counts as activity so an idle fidget doesn't fire
  clearTimeout(reactionCalmTimer);
  reactionCalmTimer = setTimeout(() => {
    reactionCalmTimer = null;
    if (!player.playing) {
      avatar.expressions.reset();
      m?.setEmotion("neutral");
    }
  }, 2000);
}

// ---------------------------------------------------------------------------
// idle fidgets — after 15-25 s of true idle, play either a hidden gesture
// clip or a procedural micro-fidget (hand shift / shrug / pondering tilt)
// ---------------------------------------------------------------------------

let lastActivityAt = Date.now();
let nextFidgetMs = randFidgetDelay();

function randFidgetDelay() {
  return 12_000 + Math.random() * 8_000;
}

// Lock mouse-wheel zoom while a hidden animation plays (some travel forward,
// e.g. tidy_up_hair), so the view doesn't fight the motion. Re-enabled after
// the clip plus a buffer for its fade-out + glide-home.
let zoomLockTimer = null;
function lockZoom(seconds) {
  if (!avatar.controls) return;
  avatar.controls.enableZoom = false;
  clearTimeout(zoomLockTimer);
  zoomLockTimer = setTimeout(() => {
    zoomLockTimer = null;
    if (avatar.controls) avatar.controls.enableZoom = true;
  }, seconds * 1000);
}

setInterval(() => {
  // Don't start fidgets while the tab is hidden: the render loop is paused, so
  // the clip would freeze mid-pose and then lurch on resume.
  if (document.hidden) return;
  // An active emote counts as activity: this both blocks a fidget from firing
  // mid-emote and resets the timer so none fires the instant the emote ends.
  const trulyIdle = backendState === "idle" && !player.playing && !micHeld && !emoteActive;
  if (!trulyIdle) {
    lastActivityAt = Date.now();
    // Activity resumed (a reply, mic, etc.) — don't leave zoom locked if a
    // fidget was cut short before its timer fired.
    if (zoomLockTimer !== null) {
      clearTimeout(zoomLockTimer);
      zoomLockTimer = null;
      if (avatar.controls) avatar.controls.enableZoom = true;
    }
    return;
  }
  if (Date.now() - lastActivityAt >= nextFidgetMs) {
    if (Math.random() < 0.5) {
      // Clip fidget (the hidden animations) — snap the camera back to the
      // default view (wherever the user had zoomed/orbited) and lock zoom for
      // its duration, so the animation always plays from the default framing.
      const dur = avatar.animations?.playRandomFidget() || 0;
      if (dur > 0) {
        avatar.cameraDirector?.returnHome();
        lockZoom(dur + 0.6);
      }
    } else {
      avatar.motion?.proceduralFidget(); // subtle, in-place — no zoom lock needed
    }
    lastActivityAt = Date.now();
    nextFidgetMs = randFidgetDelay();
  }
}, 1000);

initInput({
  onText: (text) => {
    interruptIfBusy();
    ui.addUserMessage(text);
    ui.newReply();
    sendOrToast({ type: "user_text", text });
  },
  onHoldStart: () => {
    micHeld = true;
    interruptIfBusy();
    refreshState();
  },
  onHoldEnd: () => {
    micHeld = false;
    refreshState();
  },
  onAudio: (audioB64) => {
    ui.newReply();
    sendOrToast({ type: "user_audio", audio: audioB64 });
  },
  onMicError: (message) => ui.toast(message),
});

initAvatar(ui);
