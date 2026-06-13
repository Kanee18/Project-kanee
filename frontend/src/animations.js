/**
 * Animation layers 1+2: base loops (idle / state loops) + one-shot gestures.
 *
 * Base layer: idle variations rotated on a random 20-40 s timer, PLUS
 * optional state loops (talk_01 / listening_01 / thinking_01.vrma) that
 * crossfade in as the conversation state changes — supply the files and
 * they're used automatically; absent, the idle stays (graceful fallback).
 * With no idle clips at all, a generated rest-pose clip keeps the mixer
 * driving the pose every frame (no T-pose, motion.js offsets stay additive).
 *
 * Gestures: one-shot clips blended over the base with a normalization-
 * corrected envelope (the mixer's visible blend is w/(w+1), so we ramp the
 * blend FRACTION smoothly and invert it for the weight — ramping w directly
 * front-loads the motion and reads as a lunge). Context-sync policy:
 * `playGesture(name, {replace:true})` fades the current gesture out and
 * starts the new one immediately, so gestures follow the sentence being
 * SPOKEN. Back-to-back gestures crossfade through the fade-out window
 * instead of dipping to idle. Only rotation tracks are kept (no hips
 * translation, no facial tracks). Missing files log once and are skipped —
 * never a crash, never a T-pose.
 *
 * Auto talk-gestures are emotion-gated: a small per-emotion clip pool fires
 * occasionally while she speaks, only when no other gesture is active, and
 * never for emotions where a cheery clip would clash (sad, angry...).
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from "@pixiv/three-vrm-animation";

const IDLE_CROSSFADE = 0.8;      // s — between idle variations
const IDLE_ROTATE_MIN = 20;      // s
const IDLE_ROTATE_MAX = 40;      // s
const STATE_FADE = 0.6;          // s — crossfade between state base loops
const GESTURE_FADE_IN = 0.25;    // s
const GESTURE_FADE_OUT = 0.5;    // s — soft release back into the base
const GESTURE_CANCEL_FADE = 0.3; // s — replace/interrupt fade
const GESTURE_MAX_BLEND = 0.8;   // peak share of the pose the gesture takes
const TALK_GESTURE_MIN = 5;      // s between auto conversational gestures
const TALK_GESTURE_MAX = 9;

/** Auto talk-gesture pools per emotion (filtered to loaded clips at runtime).
 *  Emotions absent here get none — a cheery clip during [sad] reads wrong. */
const TALK_POOLS = {
  neutral: ["nod", "think"],
  happy: ["nod", "thankful"],
  excited: ["thankful", "peace"],
  curious: ["think", "tilt"],
  smug: ["peace"],
};

export class AnimationController {
  constructor(vrm) {
    this.vrm = vrm;
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this._idles = [];
    this._currentIdle = null;     // active idle variation (or rest pose)
    this._idleClock = 0;
    this._nextSwitch = randRange(IDLE_ROTATE_MIN, IDLE_ROTATE_MAX);
    this._stateLoops = {};        // state -> looping AnimationAction
    this._baseKind = "idle";      // which base layer is active
    this._gestures = new Map();   // name -> AnimationAction
    this._activeGesture = null;
    this._pendingGesture = null;
    this._fidgetPool = [];
    this._talking = false;
    this._talkTimer = 0;
    this._emotion = "neutral";
    // Hooks for the procedural layer (anticipation dip / release overshoot).
    this.onGestureStart = null;
    this.onGestureEnd = null;
    this._loader = new GLTFLoader();
    this._loader.register((p) => new VRMAnimationLoaderPlugin(p));
  }

  // -- base layer: idles + state loops -----------------------------------------

  /** Try to load each idle URL; missing/broken files are skipped. */
  async loadIdles(urls) {
    for (const url of urls) {
      const clip = await this._loadClip(url);
      if (clip) this._idles.push(this.mixer.clipAction(clip));
    }
  }

  /**
   * Optional state base loops, e.g. { speaking: "/animations/talk_01.vrma",
   * listening: "...", thinking: "..." }. Missing files are skipped; states
   * without a loop simply keep the idle (procedural poses still apply).
   */
  async loadStateLoops(urlByState) {
    for (const [state, url] of Object.entries(urlByState)) {
      const clip = await this._loadClip(url);
      if (clip) this._stateLoops[state] = this.mixer.clipAction(clip);
    }
    const have = Object.keys(this._stateLoops);
    if (have.length) console.info(`animations: state loops loaded: [${have.join(", ")}]`);
  }

  /** Begin idling (call once after loadIdles). */
  start() {
    if (this._idles.length === 0) {
      console.warn("animations: no idle .vrma found — using generated rest pose");
      this._currentIdle = this.mixer.clipAction(this._restPoseClip());
      this._currentIdle.play();
      return;
    }
    this._currentIdle = this._idles[0];
    this._currentIdle.play();
    console.info(`animations: ${this._idles.length} idle variation(s) loaded`);
  }

  /** Crossfade the base layer to the state's loop (idle if none provided). */
  setState(state) {
    const kind = this._stateLoops[state] ? state : "idle";
    if (kind === this._baseKind) return;
    const from = this._baseAction();
    this._baseKind = kind;
    const to = this._baseAction();
    if (!to || from === to) return;
    to.reset().fadeIn(STATE_FADE).play();
    if (from) from.fadeOut(STATE_FADE);
  }

  _baseAction() {
    return this._baseKind === "idle" ? this._currentIdle : this._stateLoops[this._baseKind];
  }

  // -- gestures ----------------------------------------------------------------

  /** @param urlByName e.g. { wave: "/animations/wave.vrma", ... } */
  async loadGestures(urlByName) {
    for (const [name, url] of Object.entries(urlByName)) {
      const clip = await this._loadClip(url);
      if (!clip) {
        console.warn(`animations: gesture '${name}' has no clip — it will be skipped`);
        continue;
      }
      // Rotations only: no hips translation (teleport/slide), no expression
      // tracks (the face belongs to the expression/viseme layers).
      clip.tracks = clip.tracks.filter((t) => t.name.endsWith(".quaternion"));
      const action = this.mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      this._gestures.set(name, action);
    }
    console.info(`animations: ${this._gestures.size} gesture clip(s) loaded`);
  }

  /**
   * Trigger a gesture by tag name. Default: queue at most one, drop extras.
   * With {replace:true} the current gesture fades out and this one starts
   * now — used per-sentence so gestures stay in sync with the spoken text.
   * Returns the clip's duration in seconds (0 if missing/skipped).
   */
  playGesture(name, { replace = false } = {}) {
    if (!name) return 0;
    const action = this._gestures.get(name);
    if (!action) return 0; // missing — already logged at load time
    const duration = action.getClip().duration;
    if (this._activeGesture) {
      if (this._activeGesture === action) return duration;
      if (replace) {
        this._fadeOutAction(this._activeGesture, GESTURE_CANCEL_FADE);
        this._pendingGesture = null;
        this._startGesture(action);
      } else if (!this._pendingGesture) {
        this._pendingGesture = action;
      }
      return duration;
    }
    this._startGesture(action);
    return duration;
  }

  /** Names eligible as idle fidgets (silently filtered to loaded clips). */
  setFidgetPool(names) {
    this._fidgetPool = names.filter((n) => this._gestures.has(n));
    console.info(`animations: fidget pool = [${this._fidgetPool.join(", ")}]`);
  }

  /** Current segment's emotion — picks the auto talk-gesture pool. */
  setEmotion(name) {
    this._emotion = name;
  }

  /** Enable/disable auto conversational gestures (call when speech starts/stops). */
  setTalking(on) {
    if (on && !this._talking) this._talkTimer = randRange(TALK_GESTURE_MIN, TALK_GESTURE_MAX);
    this._talking = on;
  }

  /** Hidden idle animation: play one random fidget if nothing else is going on. */
  playRandomFidget() {
    if (this._fidgetPool.length === 0 || this._activeGesture) return;
    const name = this._fidgetPool[Math.floor(Math.random() * this._fidgetPool.length)];
    this.playGesture(name);
  }

  /** Interrupt: fade any gesture out and forget the pending one. */
  cancelGestures() {
    this._pendingGesture = null;
    if (this._activeGesture) {
      this._fadeOutAction(this._activeGesture, GESTURE_CANCEL_FADE);
      this._activeGesture = null;
    }
  }

  _fadeOutAction(action, duration) {
    action.fadeOut(duration); // THREE fades from the current effective weight
    setTimeout(() => action.stop(), duration * 1000 + 50);
  }

  _startGesture(action) {
    this._activeGesture = action;
    action.reset();
    action.setEffectiveWeight(0);
    action.play();
    this.onGestureStart?.(); // anticipation dip overlaps the fade-in
  }

  // -- per-frame ---------------------------------------------------------------

  /** Advance the mixer, gesture envelope, talk gestures, idle rotation. */
  update(delta) {
    this.mixer.update(delta);

    if (this._activeGesture) {
      const action = this._activeGesture;
      const duration = action.getClip().duration;
      const t = action.time;
      const tail = duration - t;
      if (t >= duration - 1e-3) {
        action.stop();
        this._activeGesture = null;
        this.onGestureEnd?.(); // release overshoot in the procedural layer
        const pending = this._pendingGesture;
        this._pendingGesture = null;
        if (pending) this._startGesture(pending);
      } else if (this._pendingGesture && tail <= GESTURE_FADE_OUT) {
        // Crossfade gesture→gesture through the fade-out window instead of
        // dipping back to the base pose between them.
        this._fadeOutAction(action, tail);
        const pending = this._pendingGesture;
        this._pendingGesture = null;
        this._startGesture(pending);
      } else {
        // Smooth the on-screen blend fraction, then invert w/(w+1) for the
        // mixer weight, so what the eye sees follows smooth01 exactly.
        const ramp = Math.min(t / GESTURE_FADE_IN, tail / GESTURE_FADE_OUT, 1);
        const frac = GESTURE_MAX_BLEND * smooth01(Math.max(0, ramp));
        action.setEffectiveWeight(frac / (1 - frac));
      }
    }

    // Emotion-gated auto conversational gestures while talking.
    if (this._talking && !this._activeGesture) {
      this._talkTimer -= delta;
      if (this._talkTimer <= 0) {
        this._talkTimer = randRange(TALK_GESTURE_MIN, TALK_GESTURE_MAX);
        const pool = (TALK_POOLS[this._emotion] ?? []).filter((n) => this._gestures.has(n));
        if (pool.length > 0) {
          this.playGesture(pool[Math.floor(Math.random() * pool.length)]);
        }
      }
    }

    // Idle variation rotation — only while the idle base layer is active.
    if (this._baseKind === "idle" && this._idles.length > 1) {
      this._idleClock += delta;
      if (this._idleClock >= this._nextSwitch) {
        this._idleClock = 0;
        this._nextSwitch = randRange(IDLE_ROTATE_MIN, IDLE_ROTATE_MAX);
        this._rotateIdle();
      }
    }
  }

  _rotateIdle() {
    const others = this._idles.filter((a) => a !== this._currentIdle);
    const next = others[Math.floor(Math.random() * others.length)];
    next.reset().fadeIn(IDLE_CROSSFADE).play();
    this._currentIdle.fadeOut(IDLE_CROSSFADE);
    this._currentIdle = next;
  }

  async _loadClip(url) {
    try {
      const gltf = await this._loader.loadAsync(url);
      const vrmAnimation = gltf.userData.vrmAnimations?.[0];
      if (!vrmAnimation) {
        console.warn(`animations: ${url} contains no VRM animation — skipping`);
        return null;
      }
      return createVRMAnimationClip(vrmAnimation, this.vrm);
    } catch {
      console.warn(`animations: ${url} not found — skipping`);
      return null;
    }
  }

  /**
   * Constant-keyframe clip that lowers the arms from the bind-time T-pose.
   * Driving it through the mixer (instead of setting rotations once) means
   * bone rotations are rewritten every frame, so motion.js offsets stay
   * additive instead of accumulating.
   */
  _restPoseClip() {
    const tracks = [];
    const add = (boneName, z) => {
      const node = this.vrm.humanoid?.getNormalizedBoneNode(boneName);
      if (!node) return;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, z));
      tracks.push(
        new THREE.QuaternionKeyframeTrack(
          `${node.name}.quaternion`,
          [0, 1],
          [...q.toArray(), ...q.toArray()],
        ),
      );
    };
    add("leftUpperArm", -1.15);
    add("rightUpperArm", 1.15);
    add("leftLowerArm", -0.08);
    add("rightLowerArm", 0.08);
    return new THREE.AnimationClip("rest_pose", 1, tracks);
  }
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function smooth01(x) {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}
