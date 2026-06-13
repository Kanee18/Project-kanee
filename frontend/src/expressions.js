/**
 * Emotion tag → VRM expression crossfade, one emotion at a time.
 *
 * Anime timing: expressions snap on in ~0.2 s. The active emotion HOLDS
 * between sentences and after the reply ends — it only changes when the
 * next segment's emotion arrives, or on reset() (interrupt).
 *
 * Emphasis pulses: pulseEmphasis() flashes a partial 'surprised' (brow
 * raise) that decays in ~a quarter second — wired to loud syllables.
 *
 * The 10 protocol emotions map onto blends of the VRM presets every VRoid
 * export has (happy / sad / angry / surprised / relaxed). Expressions the
 * model doesn't define are dropped once with a warning. Visemes (aa ih ou
 * ee oh) are owned by lipsync.js and never touched here.
 */

// Expressions move on a critically-damped spring (settle ~0.25 s) instead of
// an exponential lerp: an exp lerp jumps at max velocity on frame one (reads
// as a snap), a spring accelerates from rest — same speed, far smoother.
const FADE_SETTLE = 0.25;    // s — expression crossfade settle time
const EMPHASIS_BROW = 0.2;   // 'surprised' weight at full emphasis
const EMPHASIS_TAU = 0.25;   // s — emphasis pulse decay

// Emote face: a held smile and NO eye animation at all (user call after the
// wink choreography kept misbehaving) — auto-blink is suspended and all blink
// channels are pinned open for the emote's duration. Note: this model's
// `happy` morph inherently narrows the eyes a little as it smiles; 0.65
// keeps that mild. Lower → opener eyes, flatter smile.
const EMOTE_SMILE = 0.65;

/** protocol emotion → { vrmExpression: weight } */
const EMOTION_MAP = {
  neutral: {},
  happy: { happy: 0.85 },
  excited: { happy: 1.0, surprised: 0.2 },
  sad: { sad: 0.9 },
  angry: { angry: 0.85 },
  surprised: { surprised: 1.0 },
  shy: { happy: 0.35, sad: 0.25 },
  pout: { angry: 0.45, sad: 0.35 },
  curious: { surprised: 0.45 }, // brow lift — closest VRM gets to "one eyebrow up"
  smug: { happy: 0.5, relaxed: 0.5 },
};

export class ExpressionController {
  /**
   * @param vrm    the loaded VRM
   * @param motion MotionController (for blink suppression) — may be null
   */
  constructor(vrm, motion) {
    this.vrm = vrm;
    this.motion = motion;
    this._weights = {};
    this._targets = {};
    this._emphasis = 0;
    this._emote = null; // { t, dur } while the idol-wink emote is running

    // Which mapped expressions does this model actually have?
    const em = vrm.expressionManager;
    this._available = new Set();
    // Eye channels the scripted emote drives (independent of the emotion map).
    this._eyes = {};
    for (const n of ["blink", "blinkLeft", "blinkRight"]) {
      this._eyes[n] = !!(em && em.getExpression(n));
    }
    const wanted = new Set(Object.values(EMOTION_MAP).flatMap(Object.keys));
    for (const name of wanted) {
      if (em && em.getExpression(name)) {
        this._available.add(name);
        this._weights[name] = { x: 0, v: 0 }; // spring state per expression
        this._targets[name] = 0;
      } else {
        console.warn(`expressions: model has no '${name}' expression — dropping it from blends`);
      }
    }
  }

  /** Switch the active emotion; applied with a fast crossfade in update(). */
  setEmotion(name) {
    let map = EMOTION_MAP[name];
    if (map === undefined) {
      console.warn(`expressions: unknown emotion '${name}' — using neutral`);
      map = {};
    }
    for (const key of this._available) this._targets[key] = map[key] ?? 0;
    if (this.motion) this.motion.suppressBlink = name === "surprised";
  }

  /** Brief brow raise on a loud syllable; decays on its own. */
  pulseEmphasis() {
    this._emphasis = 1;
  }

  /**
   * Scripted idol-wink emote: smile, wink one eye, settle into a happy
   * closed-eye smile. Suspends the random auto-blink + squint for its
   * duration so the eyes move intentionally instead of shutting at random.
   */
  playEmote(duration) {
    this._emote = { t: 0, dur: Math.max(duration, 1.4) };
    for (const key of this._available) this._targets[key] = 0;
    if (this._available.has("happy")) this._targets["happy"] = EMOTE_WINK_SMILE;
    if (this.motion) this.motion.suppressBlink = true; // we own the eyes now
  }

  /** Back to neutral — used on interrupt only; normal replies hold. */
  reset() {
    this.setEmotion("neutral");
    this._emphasis = 0;
    this._endEmote();
  }

  _endEmote() {
    if (!this._emote) return;
    this._emote = null;
    for (const n of ["blink", "blinkLeft", "blinkRight"]) {
      if (this._eyes[n]) this.vrm.expressionManager?.setValue(n, 0);
    }
    if (this._available.has("happy")) this._targets["happy"] = 0; // fade the grin out
    if (this.motion) this.motion.suppressBlink = false;
  }

  update(delta) {
    const em = this.vrm.expressionManager;
    if (!em) return;
    delta = Math.min(delta, 0.05); // tab-away dt spike would explode the springs
    this._emphasis *= Math.exp(-delta / EMPHASIS_TAU);
    for (const name of this._available) {
      const s = this._weights[name];
      springTo(s, this._targets[name], FADE_SETTLE, 1.0, delta);
      let value = Math.min(1, Math.max(0, s.x));
      if (name === "surprised") {
        value = Math.max(value, EMPHASIS_BROW * this._emphasis);
      }
      em.setValue(name, value);
    }
    // Scripted emote eye timeline (runs after motion.js in the loop, so it
    // owns the blink channels). `m` is the "eyes-closed middle" amount:
    //   m=0 → wink phase   (blink closes the wink eye, happy low)
    //   m=1 → middle       (happy alone closes both eyes; NO blink → no over-drive)
    if (this._emote) {
      this._emote.t += delta;
      const { t, dur } = this._emote;
      const p = t / dur;
      const m = emoteMiddle(p);
      // Two discrete wink pulses (close → hold → reopen), gated by (1 - m)
      // so the wink morph never sums with the happy that closes the eyes
      // in the middle (sum > 1 collapses the eye geometry).
      const wink = Math.max(winkPulse(p, WINK_1), winkPulse(p, WINK_2)) * (1 - m);
      if (this._eyes.blinkRight) em.setValue("blinkRight", wink);
      if (this._eyes.blinkLeft) em.setValue("blinkLeft", 0);
      if (this._eyes.blink) em.setValue("blink", 0);
      if (this._available.has("happy")) {
        this._targets["happy"] = EMOTE_WINK_SMILE + (EMOTE_MID_SMILE - EMOTE_WINK_SMILE) * m;
      }
      if (t >= dur) this._endEmote();
    }
  }
}

/** Eyes-closed "middle" amount over the emote (normalized progress): wink → closed → wink. */
function emoteMiddle(p) {
  if (p < 0.34) return 0;
  if (p < 0.44) return smooth01((p - 0.34) / 0.1);
  if (p < 0.6) return 1;
  if (p < 0.7) return 1 - smooth01((p - 0.6) / 0.1);
  return 0;
}

/** Close-hold-reopen pulse inside the [a, b] progress window. */
function winkPulse(p, [a, b]) {
  if (p <= a || p >= b) return 0;
  const x = (p - a) / (b - a);
  if (x < 0.25) return smooth01(x / 0.25);
  if (x < 0.75) return 1;
  return 1 - smooth01((x - 0.75) / 0.25);
}

function smooth01(x) {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

/** Damped-spring step (same as motion.js): accelerates from rest, settles. */
function springTo(state, target, settle, zeta, dt) {
  const omega = 4.6 / Math.max(settle, 1e-3);
  const accel = -2 * zeta * omega * state.v - omega * omega * (state.x - target);
  state.v += accel * dt;
  state.x += state.v * dt;
}
