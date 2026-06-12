/**
 * Animation layers 1+2: base idle loop(s) + one-shot gesture clips.
 *
 * Idles: 2-3 .vrma variations rotated on a random 20-40 s timer with a 0.5 s
 * crossfade. With no idle clips at all, a generated rest-pose clip keeps the
 * mixer driving the pose every frame (no T-pose, and motion.js offsets stay
 * additive).
 *
 * Gestures: one-shot clips triggered by gesture tags. The idle keeps looping
 * underneath at full weight; the gesture blends in over it with weight > 1
 * (THREE's mixer normalizes by cumulative weight, so 1.6 vs 1.0 ≈ 62%
 * gesture) and a 0.25 s in/out envelope we drive ourselves. Only rotation
 * tracks are kept: stripping the hips position track stops the model
 * teleporting/sliding, and stripping expression tracks keeps the face owned
 * by expressions.js/lipsync.js. At most ONE pending gesture is queued;
 * extras are dropped. Missing files log once at load and are skipped —
 * never a crash, never a T-pose.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from "@pixiv/three-vrm-animation";

const IDLE_CROSSFADE = 0.8;      // s
const IDLE_ROTATE_MIN = 20;      // s
const IDLE_ROTATE_MAX = 40;      // s
const GESTURE_FADE_IN = 0.25;    // s
const GESTURE_FADE_OUT = 0.5;    // s — soft release back into the idle
const GESTURE_CANCEL_FADE = 0.3; // s — interrupt fade
// Peak share of the pose the gesture takes (0.8 ≈ the old weight-4.0 look).
// IMPORTANT: the mixer normalizes weights, so visible blend = w/(w+1) — a
// smooth ramp on w is NOT a smooth ramp on screen (50% of the pose change
// landed in the first quarter of the fade = the "stiff snap"). We therefore
// ramp the BLEND FRACTION smoothly and invert the normalization for w.
const GESTURE_MAX_BLEND = 0.8;

export class AnimationController {
  constructor(vrm) {
    this.vrm = vrm;
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this._idles = [];
    this._currentIdle = null;
    this._idleClock = 0;
    this._nextSwitch = randRange(IDLE_ROTATE_MIN, IDLE_ROTATE_MAX);
    this._gestures = new Map(); // name -> AnimationAction
    this._activeGesture = null;
    this._pendingGesture = null;
    this._fidgetPool = [];
    // Hooks for the procedural layer (anticipation dip / release overshoot).
    this.onGestureStart = null;
    this.onGestureEnd = null;
    this._loader = new GLTFLoader();
    this._loader.register((p) => new VRMAnimationLoaderPlugin(p));
  }

  // -- idles -------------------------------------------------------------------

  /** Try to load each idle URL; missing/broken files are skipped. */
  async loadIdles(urls) {
    for (const url of urls) {
      const clip = await this._loadClip(url);
      if (clip) this._idles.push(this.mixer.clipAction(clip));
    }
  }

  /** Begin idling (call once after loadIdles). */
  start() {
    if (this._idles.length === 0) {
      console.warn("animations: no idle .vrma found — using generated rest pose");
      this.mixer.clipAction(this._restPoseClip()).play();
      return;
    }
    this._currentIdle = this._idles[0];
    this._currentIdle.play();
    console.info(`animations: ${this._idles.length} idle variation(s) loaded`);
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

  /** Trigger a gesture by tag name. Queues at most one; drops extras. */
  playGesture(name) {
    if (!name) return;
    const action = this._gestures.get(name);
    if (!action) return; // missing — already logged at load time
    if (this._activeGesture) {
      if (!this._pendingGesture) this._pendingGesture = action;
      return;
    }
    this._startGesture(action);
  }

  /** Names eligible as idle fidgets (silently filtered to loaded clips). */
  setFidgetPool(names) {
    this._fidgetPool = names.filter((n) => this._gestures.has(n));
    console.info(`animations: fidget pool = [${this._fidgetPool.join(", ")}]`);
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
      const action = this._activeGesture;
      this._activeGesture = null;
      action.fadeOut(GESTURE_CANCEL_FADE);
      setTimeout(() => action.stop(), GESTURE_CANCEL_FADE * 1000 + 50);
    }
  }

  _startGesture(action) {
    this._activeGesture = action;
    action.reset();
    action.setEffectiveWeight(0);
    action.play();
    this.onGestureStart?.(); // anticipation dip overlaps the 0.15 s fade-in
  }

  // -- per-frame ---------------------------------------------------------------

  /** Advance the mixer, the idle-rotation timer, and the gesture envelope. */
  update(delta) {
    this.mixer.update(delta);

    if (this._activeGesture) {
      const action = this._activeGesture;
      const duration = action.getClip().duration;
      const t = action.time;
      if (t >= duration - 1e-3) {
        action.stop();
        this._activeGesture = null;
        this.onGestureEnd?.(); // release overshoot in the procedural layer
        const pending = this._pendingGesture;
        this._pendingGesture = null;
        if (pending) this._startGesture(pending);
      } else {
        // Smooth the on-screen blend fraction, then invert w/(w+1) for the
        // mixer weight, so what the eye sees follows smooth01 exactly.
        const ramp = Math.min(t / GESTURE_FADE_IN, (duration - t) / GESTURE_FADE_OUT, 1);
        const frac = GESTURE_MAX_BLEND * smooth01(Math.max(0, ramp));
        action.setEffectiveWeight(frac / (1 - frac));
      }
    }

    if (this._idles.length > 1) {
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
