/**
 * Animation layer 3: procedural, additive, code-driven — where the
 * personality lives.
 *
 *  Always on:    breathing (emotion-paced), idle weight shift, random idle
 *                head tilts, auto-blink (+squint on happy), saccades, gaze
 *  While talking: head/spine sway, hands+arms micro-gestures, shoulder
 *                movement and emphasis micro-nods riding the audio level
 *  Per emotion:  whole-body posture offsets (asymmetric ease in/out),
 *                activation impulses (excited hop, surprised recoil)
 *  One-shots:    impulse system — anticipation dip before gestures,
 *                release overshoot after them, procedural idle fidgets
 *
 * Before/after impressions (amplification pass): the previous tuning was
 * "subtle-but-everywhere"; on screen it read as stiff and robotic — the
 * motion was THERE but below the threshold where the eye groups it into
 * "a person shifting her weight". Tripling breathing/sway and giving every
 * emotion a whole-body posture crossed that threshold. The impulse layer
 * (anticipation, overshoot, hop, micro-nods) is what finally killed the
 * "robotic" feel: real bodies lead and settle, they don't just lerp.
 *
 * Call order each frame matters: mixer.update() writes the base pose, then
 * MotionController.update() adds offsets on top, then vrm.update() runs
 * look-at, expressions and spring bones (and bakes the normalized pose onto
 * the real skeleton) — then revert() undoes this frame's offsets.
 *
 * The revert step is what keeps the offsets truly additive: animation clips
 * don't necessarily have tracks for every bone we touch, and a `+=` on a
 * bone nobody resets integrates over frames (the "slowly bowing over" bug).
 */
import * as THREE from "three";

// -- breathing ----------------------------------------------------------------
const BREATH_HZ = 0.3;          // base breaths/s (~18/min)
const BREATH_HZ_SAD = 0.2;      // sad breathes slower
const BREATH_HZ_EXCITED = 0.36; // excited breathes faster
const BREATH_SPINE = 0.03;      // rad — visibly noticeable, per overhaul spec
const BREATH_CHEST = 0.02;      // rad
const BREATH_SHOULDER = 0.012;  // rad, mirrored z

// -- idle weight shift ----------------------------------------------------------
// NOT a sine: a continuous oscillation reads as mechanical rocking. Real
// weight shift = lean onto one hip, hold for seconds, occasionally switch.
const SHIFT_HOLD_MIN = 5;       // s resting on one side
const SHIFT_HOLD_MAX = 11;
const SHIFT_TAU = 0.6;          // s — unhurried ease when switching sides
const SHIFT_SPINE_Z = 0.025;    // rad lean at full shift
const SHIFT_HIPS_Z = 0.018;    // rad

// -- idle head tilts --------------------------------------------------------------
const TILT_INTERVAL_MIN = 4;    // s between new tilt targets
const TILT_INTERVAL_MAX = 8;
const TILT_MAX = 0.1;           // rad on neck z
const TILT_TAU = 0.22;          // s — eases in/out over ~0.5 s

// -- talking sway / hands ---------------------------------------------------------
const TALK_TAU = 0.35;          // s — speech envelope smoothing
// Subtle head/torso sway layered on top of the explain.vrma talking clip.
// The clip owns the arms/hands now, so there is no procedural hand motion.
const SWAY_HEAD = 0.1;          // rad — head bob/tilt range while speaking
const SWAY_SPINE = 0.06;        // rad — gentle torso sway while speaking

// -- audio emphasis ----------------------------------------------------------------
const EMPHASIS_LEVEL = 0.7;     // level above this = emphasis (nod + brow pulse)
const SPIKE_JUMP = 0.22;        // sudden level jump above slow average = spike (nod)
const SPIKE_COOLDOWN = 0.35;    // s between emphasis events
const NOD_AMP = 0.03;           // rad head pitch
const NOD_ATTACK = 0.08;        // s
const NOD_RELEASE = 0.15;       // s

// -- posture (emotion + state) -----------------------------------------------------
// Springs, not exponential lerps: an exp lerp has its maximum velocity at
// t=0 (the pose JERKS into motion, then crawls) — that reads as stiff.
// A near-critically-damped spring starts at zero velocity, accelerates,
// settles with a hint of organic overshoot.
const POSE_SETTLE_IN = 0.25;    // s — settle time into a pose
const POSE_SETTLE_OUT = 0.5;    // s — settle time releasing a pose
const SURPRISE_SETTLE_IN = 0.15; // s — surprised still snaps in fast
const POSE_DAMPING = 0.9;       // damping ratio; <1 = slight overshoot (life)
const HOP_AMP = 0.035;          // m  — excited hip hop height (spec's "0.15" in
                                //      meters would be a 15 cm rocket jump)
const HOP_ATTACK = 0.12;        // s
const HOP_RELEASE = 0.28;       // s
const RECOIL_AMP = -0.05;       // rad — surprised extra backward snap
const ANTICIPATION_AMP = 0.02;  // rad — pre-gesture counter-dip
const ANTICIPATION_TIME = 0.1;  // s
const OVERSHOOT_AMP = -0.015;   // rad — post-gesture spring-back overshoot
const OVERSHOOT_RELEASE = 0.35; // s

// -- blink / squint -----------------------------------------------------------------
const BLINK_MIN = 2;            // s
const BLINK_MAX = 6;
const BLINK_CLOSE = 0.06;       // s — lids drop fast...
const BLINK_OPEN = 0.18;        // s — ...and reopen slower (eased: organic, not metronome)
const DOUBLE_BLINK_CHANCE = 0.2;
// This model's happy/excited MORPH already narrows the eyes (smiling eyes), so
// an extra blink-channel squint here just stacks and over-closes them during
// speech (the "stuck eyes" bug). Kept at 0; raise only for models whose
// emotion morphs leave the eyes wide.
const SQUINT = 0;
const LID_FOLLOW = 1.2;         // lids lower a touch when the gaze drops (subtle pro touch)
const LID_FOLLOW_MAX = 0.18;

// -- gaze ---------------------------------------------------------------------------
const GAZE_LAG = 5;             // 1/s — eyes chase the camera
const SACCADE_SNAP = 22;        // 1/s — saccades are near-instant
const HEAD_FOLLOW_TAU = 0.22;   // s — ease the head/body toward the camera angle
// idle eye wander: deliberate held side-glances while idle (vs. saccade jitter)
const WANDER_INTERVAL_MIN = 3;  // s of eye contact between glances
const WANDER_INTERVAL_MAX = 7;
const WANDER_HOLD_MIN = 0.8;    // s a side-glance is held
const WANDER_HOLD_MAX = 2.0;
const WANDER_MAG_X = 0.55;      // sideways reach (world units at ~1.4 m ≈ ~20°)
const WANDER_MAG_Y = 0.2;       // vertical variation

/** emotion → additive posture offsets, "bone.axis": radians */
const EMOTION_POSE = {
  neutral: {},
  happy: {
    "leftShoulder.z": 0.05, "rightShoulder.z": -0.05,
    "spine.x": 0.03, "head.z": 0.04,
  },
  excited: {
    "leftShoulder.z": 0.08, "rightShoulder.z": -0.08,
    "spine.x": 0.04, "head.x": -0.03,
    "leftUpperArm.z": 0.12, "rightUpperArm.z": -0.12, // arms slightly raised
  },
  sad: {
    "leftShoulder.z": -0.06, "rightShoulder.z": 0.06,
    "neck.x": 0.05, "head.x": 0.08, "spine.x": 0.05,
  },
  angry: {
    "leftShoulder.z": 0.04, "rightShoulder.z": -0.04,
    "head.x": 0.05, "spine.x": 0.06, // chin down + forward = aggressive
  },
  surprised: {
    "spine.x": -0.08, "head.x": -0.04,
    "leftShoulder.z": 0.06, "rightShoulder.z": -0.06,
  },
  shy: {
    "head.y": 0.26, "head.x": 0.06,
    "leftShoulder.y": 0.04, "rightShoulder.y": -0.04, // shoulders inward
  },
  pout: {
    "head.y": -0.15, "head.x": -0.04, // turned away, chin UP — defiant
    "leftUpperArm.z": 0.08, "rightUpperArm.z": -0.08, // crossed-arm hint
  },
  curious: { "head.z": 0.1, "spine.x": 0.05 },
  smug: { "head.z": 0.07, "head.x": -0.05 },
};

/** UI state → additive posture offsets */
const STATE_POSE = {
  idle: {},
  listening: { "spine.x": 0.06, "head.x": -0.04 },
  thinking: { "head.z": 0.1, "head.y": 0.14 },
  speaking: {},
};

export class MotionController {
  /**
   * @param opts.speechLevel () => 0..1 — lip-sync amplitude
   * @param opts.onEmphasis  () => void — loud syllable (brow pulse hook)
   */
  constructor(vrm, camera, scene, opts = {}) {
    this.vrm = vrm;
    this.camera = camera;
    this._speechLevel = opts.speechLevel ?? (() => 0);
    this._onEmphasis = opts.onEmphasis ?? (() => {});
    this._t = Math.random() * 10; // desync phases across reloads
    this._talk = 0;
    this._slowLevel = 0;
    this._spikeCooldown = 0;
    this._emotion = "neutral";
    this._state = "idle";
    this._camPos = new THREE.Vector3();
    this._applied = [];      // [node, prop, axis, value] offsets this frame
    this._pose = new Map();  // "bone.axis" -> current smoothed offset
    this._impulses = [];     // one-shot envelopes (nods, hops, fidgets...)

    // idle head tilt state
    this._tilt = 0;
    this._tiltTarget = 0;
    this._tiltTimer = randRange(TILT_INTERVAL_MIN, TILT_INTERVAL_MAX);

    // idle weight shift state
    this._shiftSide = Math.random() < 0.5 ? -1 : 1;
    this._shiftCur = 0;
    this._shiftTimer = randRange(SHIFT_HOLD_MIN, SHIFT_HOLD_MAX);

    // Eyes follow a proxy that smoothly chases the camera → slight lag.
    this._gazeBase = new THREE.Vector3();
    camera.getWorldPosition(this._gazeBase);
    this._gazeOffset = new THREE.Vector3();
    this._gazeWant = new THREE.Vector3();
    this._gazeTarget = new THREE.Object3D();
    this._gazeTarget.position.copy(this._gazeBase);
    scene.add(this._gazeTarget);
    if (vrm.lookAt) vrm.lookAt.target = this._gazeTarget;
    this._dartOn = false;
    this._dartTimer = 0;
    this._dartDir = new THREE.Vector3();
    this._wanderOn = false;
    this._wanderTimer = randRange(WANDER_INTERVAL_MIN, WANDER_INTERVAL_MAX);
    this._wanderDir = new THREE.Vector3();
    this._sacOn = false;
    this._sacTimer = 1 + Math.random() * 2;
    this._sacWant = new THREE.Vector3();
    this._sacOffset = new THREE.Vector3();

    this._blinkWait = randRange(BLINK_MIN, BLINK_MAX);
    this._blinkT = null;
    this._blinkAgain = false;
    this.suppressBlink = false; // expressions.js sets this during [surprised]
    // 0..1, set by expressions.js: how much the active emotion already closes
    // the eyes (e.g. a happy ^_^ smile). Scales the auto-blink down so she
    // doesn't "blink" eyes the expression has already shut.
    this.blinkSuppress = 0;

    // head-follow: main.js sets the target yaw (rad) toward the orbit camera.
    this.headFollowTarget = 0;
    this._headFollow = 0;
  }

  // -- public API -------------------------------------------------------------

  /** Current segment's emotion — posture, impulses, breathing pace, gaze. */
  setEmotion(name) {
    const next = name in EMOTION_POSE ? name : "neutral";
    if (next !== this._emotion) {
      if (next === "excited") this.impulsePos("hips", "y", HOP_AMP, HOP_ATTACK, HOP_RELEASE);
      if (next === "surprised") this.impulseRot("spine", "x", RECOIL_AMP, 0.06, 0.5);
    }
    this._emotion = next;
  }

  /** UI state (idle/listening/thinking/speaking) — drives state poses. */
  setState(state) {
    this._state = state in STATE_POSE ? state : "idle";
  }

  /** One-shot rotation envelope: smooth attack, smooth release, then gone.
   *  Optional `delay` (s) lets multi-part motions sequence (e.g. a sigh's
   *  shoulder drop after the chest swell). */
  impulseRot(bone, axis, amp, attack, release, delay = 0) {
    this._impulses.push({ bone, axis, amp, attack, release, t: -delay, kind: "rot" });
  }

  /** One-shot position envelope (e.g. the excited hip hop). */
  impulsePos(bone, axis, amp, attack, release, delay = 0) {
    this._impulses.push({ bone, axis, amp, attack, release, t: -delay, kind: "pos" });
  }

  /** Tiny preparatory counter-dip right as a gesture clip starts. */
  anticipate() {
    this.impulseRot("spine", "x", ANTICIPATION_AMP, ANTICIPATION_TIME, 0.12);
  }

  /** Post-gesture overshoot: spring past the idle pose, settle back. */
  gestureRelease() {
    this.impulseRot("spine", "x", OVERSHOOT_AMP, 0.05, OVERSHOOT_RELEASE);
  }

  /** Drop any in-flight one-shot impulses (procedural fidgets, beats, hops)
   *  so a new deliberate motion like an emote starts from a clean pose. */
  clearImpulses() {
    this._impulses.length = 0;
  }

  /** Procedural idle fidget — no animation file needed. */
  proceduralFidget() {
    const pick = Math.floor(Math.random() * 6);
    if (pick === 0) {
      // hand clasp shift
      this.impulseRot("leftHand", "z", 0.18, 0.3, 0.9);
      this.impulseRot("rightHand", "z", -0.15, 0.35, 0.9);
      this.impulseRot("leftLowerArm", "z", 0.08, 0.3, 0.9);
      this.impulseRot("rightLowerArm", "z", -0.08, 0.3, 0.9);
    } else if (pick === 1) {
      // little shrug
      this.impulseRot("leftShoulder", "z", 0.05, 0.25, 0.7);
      this.impulseRot("rightShoulder", "z", -0.05, 0.25, 0.7);
    } else if (pick === 2) {
      // slow pondering head tilt
      this.impulseRot("neck", "z", (Math.random() < 0.5 ? 1 : -1) * 0.09, 0.45, 1.3);
    } else if (pick === 3) {
      // sigh: chest swell + shoulders rise, then everything settles down
      this.impulseRot("chest", "x", 0.05, 0.7, 0.9);
      this.impulseRot("leftShoulder", "z", 0.05, 0.7, 0.5);
      this.impulseRot("rightShoulder", "z", -0.05, 0.7, 0.5);
      this.impulseRot("leftShoulder", "z", -0.04, 0.3, 1.0, 0.9);
      this.impulseRot("rightShoulder", "z", 0.04, 0.3, 1.0, 0.9);
      this.impulseRot("head", "x", 0.05, 0.5, 1.2, 0.9);
    } else if (pick === 4) {
      // stretch: arms swing slightly up/out, back arches
      this.impulseRot("leftUpperArm", "z", 0.3, 0.6, 1.1);
      this.impulseRot("rightUpperArm", "z", -0.3, 0.6, 1.1);
      this.impulseRot("spine", "x", -0.06, 0.6, 1.1);
      this.impulseRot("head", "x", -0.05, 0.6, 1.1);
    } else {
      // glance around: head turns aside, eyes lead the way
      const side = Math.random() < 0.5 ? -1 : 1;
      this.impulseRot("head", "y", side * 0.22, 0.5, 1.6);
      this.impulseRot("neck", "y", side * 0.08, 0.5, 1.6);
      this._wanderOn = true;
      this._wanderDir.set(side * 0.6, 0.05, 0);
      this._wanderTimer = 1.4;
    }
  }

  update(delta) {
    // Clamp dt: after a tab-away, a multi-second delta would make the
    // springs explode and the timers fast-forward.
    delta = Math.min(delta, 0.05);
    this._t += delta;
    this._talk += (this._speechLevel() - this._talk) * (1 - Math.exp(-delta / TALK_TAU));
    this._breathe();
    this._weightShift(delta);
    this._idleTilt(delta);
    this._headTurn(delta);
    this._sway();
    this._emphasis(delta);
    this._posture(delta);
    this._impulseUpdate(delta);
    this._blink(delta);
    this._gaze(delta);
  }

  /**
   * Undo this frame's bone offsets. Call AFTER vrm.update() — by then the
   * pose has been baked onto the raw skeleton, so reverting the normalized
   * bones is invisible this frame and guarantees zero accumulation on bones
   * the active animation clip doesn't track.
   */
  revert() {
    for (const [node, prop, axis, value] of this._applied) {
      node[prop][axis] -= value;
    }
    this._applied.length = 0;
  }

  // -- always-on layers ---------------------------------------------------------

  _breathe() {
    const hz =
      this._emotion === "sad" ? BREATH_HZ_SAD
      : this._emotion === "excited" ? BREATH_HZ_EXCITED
      : BREATH_HZ;
    const k = Math.sin(this._t * 2 * Math.PI * hz);
    this._addRot("spine", "x", k * BREATH_SPINE * 0.5);
    this._addRot("chest", "x", k * BREATH_CHEST);
    this._addRot("upperChest", "x", k * BREATH_CHEST * 0.6);
    this._addRot("leftShoulder", "z", k * BREATH_SHOULDER);
    this._addRot("rightShoulder", "z", -k * BREATH_SHOULDER);
  }

  _weightShift(delta) {
    this._shiftTimer -= delta;
    if (this._shiftTimer <= 0) {
      // Usually alternate hips; sometimes settle centered for a while.
      this._shiftSide = Math.random() < 0.2 ? 0 : this._shiftSide <= 0 ? 1 : -1;
      this._shiftTimer = randRange(SHIFT_HOLD_MIN, SHIFT_HOLD_MAX);
    }
    this._shiftCur += (this._shiftSide - this._shiftCur) * (1 - Math.exp(-delta / SHIFT_TAU));
    this._addRot("spine", "z", this._shiftCur * SHIFT_SPINE_Z);
    this._addRot("hips", "z", this._shiftCur * SHIFT_HIPS_Z);
  }

  /**
   * Turn the head (and a little neck/spine) toward the orbit camera so she
   * appears to track the viewer. The target yaw is computed in main.js from
   * the camera angle (it knows OrbitControls); here we just ease and split it
   * down the chain so the turn looks like a body movement, not a snap.
   */
  _headTurn(delta) {
    this._headFollow +=
      (this.headFollowTarget - this._headFollow) * (1 - Math.exp(-delta / HEAD_FOLLOW_TAU));
    const y = this._headFollow;
    if (Math.abs(y) < 1e-4) return;
    this._addRot("spine", "y", y * 0.1);
    this._addRot("chest", "y", y * 0.1);
    this._addRot("neck", "y", y * 0.35);
    this._addRot("head", "y", y * 0.45);
  }

  _idleTilt(delta) {
    this._tiltTimer -= delta;
    if (this._tiltTimer <= 0) {
      this._tiltTimer = randRange(TILT_INTERVAL_MIN, TILT_INTERVAL_MAX);
      // 30% of the time return to level, otherwise pick a new gentle tilt
      this._tiltTarget =
        Math.random() < 0.3 ? 0 : (Math.random() < 0.5 ? -1 : 1) * randRange(0.05, TILT_MAX);
    }
    const want = this._talk > 0.15 ? 0 : this._tiltTarget; // sway owns the head while talking
    this._tilt += (want - this._tilt) * (1 - Math.exp(-delta / TILT_TAU));
    this._addRot("neck", "z", this._tilt);
  }

  // -- speech-driven layers -------------------------------------------------------

  _sway() {
    const a = this._talk;
    if (a < 0.02) return;
    const t = this._t;
    const n1 = Math.sin(t * 1.9) * 0.6 + Math.sin(t * 3.1 + 1.3) * 0.4;
    const n2 = Math.sin(t * 2.6 + 0.7) * 0.5 + Math.sin(t * 4.3 + 2.1) * 0.5;
    // Head + a little torso only — the explain.vrma clip drives the arms/hands.
    this._addRot("spine", "y", n1 * SWAY_SPINE * 0.5 * a);
    this._addRot("head", "z", n2 * SWAY_HEAD * 0.6 * a);
    this._addRot("head", "x", n2 * SWAY_HEAD * 0.45 * a);
    this._addRot("head", "y", n1 * SWAY_HEAD * 0.3 * a);
  }

  _emphasis(delta) {
    this._slowLevel += (this._speechLevel() - this._slowLevel) * (1 - Math.exp(-delta / 0.6));
    this._spikeCooldown -= delta;
    if (this._spikeCooldown > 0) return;
    const lvl = this._speechLevel();
    if (lvl > EMPHASIS_LEVEL) {
      // loud emphasis: micro-nod + eyebrow pulse (head/face accent over the clip)
      this.impulseRot("head", "x", NOD_AMP, NOD_ATTACK, NOD_RELEASE);
      this._onEmphasis();
      this._spikeCooldown = SPIKE_COOLDOWN;
    } else if (lvl - this._slowLevel > SPIKE_JUMP && lvl > 0.4) {
      // sudden syllable spike: micro-nod only
      this.impulseRot("head", "x", NOD_AMP, NOD_ATTACK, NOD_RELEASE);
      this._spikeCooldown = SPIKE_COOLDOWN;
    }
  }

  // -- posture + impulses ------------------------------------------------------------

  _posture(delta) {
    const target = { ...STATE_POSE[this._state] };
    for (const [key, value] of Object.entries(EMOTION_POSE[this._emotion])) {
      target[key] = (target[key] ?? 0) + value;
    }
    for (const key of new Set([...this._pose.keys(), ...Object.keys(target)])) {
      const want = target[key] ?? 0;
      let s = this._pose.get(key);
      if (!s) {
        s = { x: 0, v: 0 };
        this._pose.set(key, s);
      }
      const easingIn = Math.abs(want) > Math.abs(s.x);
      const settle =
        easingIn && this._emotion === "surprised" ? SURPRISE_SETTLE_IN
        : easingIn ? POSE_SETTLE_IN
        : POSE_SETTLE_OUT;
      springTo(s, want, settle, POSE_DAMPING, delta);
      if (Math.abs(s.x) < 1e-4 && Math.abs(s.v) < 1e-3 && !(key in target)) {
        this._pose.delete(key);
        continue;
      }
      const [bone, axis] = key.split(".");
      this._addRot(bone, axis, s.x);
    }
  }

  _impulseUpdate(delta) {
    for (let i = this._impulses.length - 1; i >= 0; i--) {
      const p = this._impulses[i];
      p.t += delta;
      if (p.t <= 0) continue; // still in its delay
      let w;
      if (p.t < p.attack) {
        w = smooth01(p.t / p.attack);
      } else {
        w = 1 - smooth01((p.t - p.attack) / p.release);
        if (w <= 0) {
          this._impulses.splice(i, 1);
          continue;
        }
      }
      if (p.kind === "pos") this._addPos(p.bone, p.axis, p.amp * w);
      else this._addRot(p.bone, p.axis, p.amp * w);
    }
  }

  _addRot(bone, axis, value) {
    const node = this.vrm.humanoid?.getNormalizedBoneNode(bone);
    if (!node) return;
    node.rotation[axis] += value;
    this._applied.push([node, "rotation", axis, value]);
  }

  _addPos(bone, axis, value) {
    const node = this.vrm.humanoid?.getNormalizedBoneNode(bone);
    if (!node) return;
    node.position[axis] += value;
    this._applied.push([node, "position", axis, value]);
  }

  // -- auto-blink + squint -------------------------------------------------------------

  _blink(delta) {
    const em = this.vrm.expressionManager;
    if (!em) return;
    if (this.suppressBlink) {
      em.setValue("blink", 0);
      this._blinkT = null;
      this._blinkWait = randRange(BLINK_MIN, BLINK_MAX);
      return;
    }
    // smiling eyes: hold a partial lid close while happy/excited
    const squint = this._emotion === "happy" || this._emotion === "excited" ? SQUINT : 0;
    // lid follow: eyes looking down lower the lids a touch
    const gazeDown = -(this._gazeOffset.y + this._sacOffset.y);
    const lidFollow = Math.min(LID_FOLLOW_MAX, Math.max(0, gazeDown * LID_FOLLOW));
    let lid = 0;
    if (this._blinkT === null) {
      this._blinkWait -= delta;
      if (this._blinkWait <= 0) {
        this._blinkT = 0;
        this._blinkAgain = Math.random() < DOUBLE_BLINK_CHANCE;
      }
    } else {
      this._blinkT += delta;
      const w = blinkEnvelope(this._blinkT);
      if (w === null) {
        if (this._blinkAgain) {
          this._blinkAgain = false;
          this._blinkT = -0.08;
        } else {
          this._blinkT = null;
          this._blinkWait = randRange(BLINK_MIN, BLINK_MAX);
        }
      } else {
        lid = w;
      }
    }
    // Scale the blink down when the emotion already closes the eyes — no
    // blinking on an already-shut ^_^ smile.
    em.setValue("blink", Math.max(lid, squint, lidFollow) * (1 - this.blinkSuppress));
  }

  // -- look-at ---------------------------------------------------------------------------

  _gaze(delta) {
    this.camera.getWorldPosition(this._camPos);
    this._gazeBase.lerp(this._camPos, 1 - Math.exp(-delta * GAZE_LAG));

    this._gazeWant.set(0, 0, 0);
    const mode =
      this._state === "thinking" ? "think"
      : this._emotion === "shy" ? "shy"
      : this._state === "idle" && this._talk < 0.15 ? "wander"
      : "none";

    if (mode === "think") {
      this._gazeWant.set(0.45, 0.4, 0); // up-left from her point of view
    }

    if (mode === "shy") {
      this._dartTimer -= delta;
      if (this._dartTimer <= 0) {
        this._dartOn = !this._dartOn;
        if (this._dartOn) {
          const side = Math.random() < 0.5 ? -1 : 1;
          this._dartDir.set(side * (0.4 + Math.random() * 0.3), -0.15, 0);
          this._dartTimer = 0.35 + Math.random() * 0.3;  // glance away...
        } else {
          this._dartTimer = 0.8 + Math.random() * 1.4;   // ...and back to you
        }
      }
      if (this._dartOn) this._gazeWant.copy(this._dartDir);
    } else {
      this._dartOn = false;
      this._dartTimer = 0;
    }

    if (mode === "wander") {
      // Idle eye wander: hold eye contact, glance off to one side, hold it,
      // come back. Slower and farther than saccades — "looking around".
      this._wanderTimer -= delta;
      if (this._wanderTimer <= 0) {
        this._wanderOn = !this._wanderOn;
        if (this._wanderOn) {
          const side = Math.random() < 0.5 ? -1 : 1;
          this._wanderDir.set(
            side * (0.35 + Math.random() * (WANDER_MAG_X - 0.35)),
            (Math.random() * 2 - 1) * WANDER_MAG_Y,
            0,
          );
          this._wanderTimer = randRange(WANDER_HOLD_MIN, WANDER_HOLD_MAX);
        } else {
          this._wanderTimer = randRange(WANDER_INTERVAL_MIN, WANDER_INTERVAL_MAX);
        }
      }
      if (this._wanderOn) this._gazeWant.copy(this._wanderDir);
    } else {
      // Leaving idle: glance back to the user and restart the contact period.
      this._wanderOn = false;
      this._wanderTimer = randRange(WANDER_INTERVAL_MIN, WANDER_INTERVAL_MAX);
    }

    this._gazeOffset.lerp(this._gazeWant, 1 - Math.exp(-delta * 8));
    this._saccade(delta);
    this._gazeTarget.position
      .copy(this._gazeBase)
      .add(this._gazeOffset)
      .add(this._sacOffset);
  }

  /** Micro-glances: subtle and sparse while idle, quicker while speaking. */
  _saccade(delta) {
    this._sacTimer -= delta;
    if (this._sacTimer <= 0) {
      const speaking = this._talk > 0.15;
      if (this._sacOn) {
        this._sacOn = false;
        this._sacWant.set(0, 0, 0);
        this._sacTimer = speaking ? 0.7 + Math.random() * 1.5 : 1.4 + Math.random() * 2.6;
      } else {
        this._sacOn = true;
        const mag = speaking ? 0.16 : 0.09;
        this._sacWant.set(
          (Math.random() * 2 - 1) * mag,
          (Math.random() * 2 - 1) * mag * 0.5,
          0,
        );
        this._sacTimer = 0.15 + Math.random() * 0.3;
      }
    }
    this._sacOffset.lerp(this._sacWant, 1 - Math.exp(-delta * SACCADE_SNAP));
  }
}

/** 0→1→0 lid weight over the blink; null when the blink has finished.
 *  Smooth-stepped both ways (linear lid ramps read as mechanical). */
function blinkEnvelope(t) {
  if (t < 0) return 0;
  if (t < BLINK_CLOSE) return smooth01(t / BLINK_CLOSE);
  if (t < BLINK_CLOSE + BLINK_OPEN) return 1 - smooth01((t - BLINK_CLOSE) / BLINK_OPEN);
  return null;
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function smooth01(x) {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

/**
 * Damped-spring step (semi-implicit Euler). `settle` is roughly the time to
 * come to rest; `zeta` < 1 gives a touch of overshoot. Starts from the
 * state's current velocity — so motion accelerates from rest instead of
 * jerking at max speed like an exponential lerp.
 */
function springTo(state, target, settle, zeta, dt) {
  const omega = 4.6 / Math.max(settle, 1e-3);
  const accel = -2 * zeta * omega * state.v - omega * omega * (state.x - target);
  state.v += accel * dt;
  state.x += state.v * dt;
}
