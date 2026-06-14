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
import { DebugOverlay } from "./debug.js"; // temporary — Step 2 diagnosis

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

    if (seg.audio) {
      try {
        const ctx = this._ensureCtx();
        const bytes = Uint8Array.from(atob(seg.audio), (c) => c.charCodeAt(0));
        const buffer = await ctx.decodeAudioData(bytes.buffer);
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

  try {
    const loader = new GLTFLoader();
    loader.register((p) => new VRMLoaderPlugin(p));
    const gltf = await loader.loadAsync("/character.vrm");
    const vrm = gltf.userData.vrm;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm); // VRM 0.x faces -Z; make every model face the camera
    vrm.scene.traverse((obj) => (obj.frustumCulled = false)); // avoids mesh pop-out
    scene.add(vrm.scene);

    // Auto-frame from the model's actual proportions: eye-level camera at
    // portrait distance, face in the upper third. Works for any model height
    // (hardcoded values framed short models too small / too low).
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

    // Full-body framing for emotes is computed from the model's bounds.
    const director = new CameraDirector(camera, controls);
    director.frameFromModel(vrm.scene);
    avatar.cameraDirector = director;
    frontAzimuth = controls.getAzimuthalAngle(); // re-capture after framing

    const animations = new AnimationController(vrm);
    await animations.loadIdles([
      "/animations/idle_01.vrma",
      // idle_02 removed from rotation: clip motion wasn't smooth (user call).
      // Re-add the line when a better clip is available.
      "/animations/idle_03.vrma",
    ]);
    animations.start();
    await animations.loadGestures({
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
      // extra clips, used only as idle fidgets (never sent by the LLM)
      thankful: "/animations/thankful.vrma",
      thoughtful_nod: "/animations/thoughtful_nod.vrma",
      spin: "/animations/spin.vrma",
      // full-body, precise: play at near-full weight so the body lean reads
      // fully and the hand reaches the head. keepRoot replays the clip's baked
      // forward step as a smooth avatar translation (delta-driven, no pop), so
      // she walks up toward the mirror and glides back when she's done.
      tidy_up_hair: { url: "/animations/tidy_up_hair.vrma", blend: 0.97, keepRoot: true },
      // emote clip for the emote button (assets/emotes/, space URL-encoded)
      kawaii: "/emotes/Kawaii%20Kaiwai.vrma",
      // math-answer presenting gesture (paired with the hologram)
      answare_math: "/animations/answare_math.vrma",
    });
    // Hidden idle animations: occasionally play one of these when she has
    // been still for a while, so she never reads as frozen.
    animations.setFidgetPool(["peace", "think", "thankful", "thoughtful_nod", "spin", "tidy_up_hair"]);
    // Optional state base loops — supply these files and they're used
    // automatically (graceful fallback to idle while absent).
    await animations.loadStateLoops({
      speaking: "/animations/explain.vrma", // the talking/explaining body animation
      listening: "/animations/listening_01.vrma",
      thinking: "/animations/thinking_01.vrma",
    });

    avatar.vrm = vrm;
    avatar.animations = animations;
    avatar.lipsync = new LipSync(vrm);
    avatar.motion = new MotionController(vrm, camera, scene, {
      speechLevel: () => avatar.lipsync?.level ?? 0,
      onEmphasis: () => avatar.expressions?.pulseEmphasis(),
    });
    avatar.expressions = new ExpressionController(vrm, avatar.motion);
    // Gesture clips get anticipation + release overshoot from the procedural layer.
    animations.onGestureStart = () => avatar.motion?.anticipate();
    animations.onGestureEnd = () => avatar.motion?.gestureRelease();
    if (player.analyser) avatar.lipsync.setAnalyser(player.analyser);
    debug.attach(vrm, () => avatar.lipsync?.level ?? 0);
    // Welcome: as she finishes materializing, wave hello with a smile.
    intro.onWelcome = playWelcome;
    intro.begin(vrm.scene); // glitch-materialize instead of popping in
    console.info("avatar ready");
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

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const delta = clock.getDelta();
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
    if (avatar.vrm) avatar.vrm.update(delta);               // look-at, expressions, spring bones
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
    // replace:true keeps gestures in sync with the sentence being SPOKEN —
    // a leftover gesture from the previous sentence fades out instead of
    // delaying this one out of context.
    if (seg.gesture) avatar.animations?.playGesture(seg.gesture, { replace: true });
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
// emote button (left of the message bar) — plays the Kawaii emote + a brief
// happy expression
// ---------------------------------------------------------------------------

let emoteCalmTimer = null;
let emoteActiveTimer = null;

/** Welcome greeting on first materialize: wave hello with a smile. */
function playWelcome() {
  const dur = avatar.animations?.playGesture("wave", { replace: true }) || 2.5;
  avatar.expressions?.setEmotion("happy");
  avatar.motion?.setEmotion("happy");
  clearTimeout(emoteCalmTimer);
  emoteCalmTimer = setTimeout(() => {
    if (!player.playing) {
      avatar.expressions?.reset();
      avatar.motion?.setEmotion("neutral");
    }
  }, (dur + 0.8) * 1000);
}

document.getElementById("emote").addEventListener("click", () => {
  // Clear any hidden animation in progress so the emote doesn't collide with
  // it: a procedural fidget's impulses are dropped, and an active clip fidget
  // is replaced (faded out) rather than queued behind.
  avatar.motion?.clearImpulses();
  const dur = avatar.animations?.playGesture("kawaii", { replace: true }) || 3;
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
});

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
      // Clip fidget (the hidden animations) — lock zoom for its duration.
      const dur = avatar.animations?.playRandomFidget() || 0;
      if (dur > 0) lockZoom(dur + 0.6);
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
