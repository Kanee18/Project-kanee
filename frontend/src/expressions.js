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

// Expressions move on a critically-damped spring instead of an exponential lerp
// (an exp lerp jumps at max velocity on frame one — reads as a snap). The
// crossfade is ASYMMETRIC, like the body posture: a reaction appears with a
// little snap, then relaxes / cross-fades OUT gently — so changes never read as
// abrupt, and the settle back to neutral after a line doesn't pop off.
const FADE_IN = 0.3;    // s — settle time as an expression intensifies
const FADE_OUT = 0.55;  // s — settle time as it eases down / crosses out
const EMPHASIS_BROW = 0.2;   // 'surprised' weight at full emphasis
const EMPHASIS_TAU = 0.25;   // s — emphasis pulse decay
// While speaking, the mouth belongs to the visemes. Presets that bundle a
// strong MOUTH shape fight that, so we ease THEM down — but only as much as each
// actually fights. Brow/eye-led emotions stay near full, so she stays expressive
// WHILE talking. (The old flat 0.5 dimmed every emotion to half — that's why so
// many lines read as "no expression".)
const SPEAK_SCALE = { happy: 0.5, surprised: 0.6, relaxed: 0.85, sad: 0.9, angry: 0.92 };
const SPEAK_SCALE_DEFAULT = 0.85;
const SPEAK_TAU = 0.28; // s — ease in/out of "speaking-ness" (smooth, no end-pop)

// Extra held eye-narrowing per emotion (half-lidded looks), applied via the
// blink lid in motion.js — adds detail the 5 face presets can't on their own.
const EMOTION_LID = { smug: 0.3, shy: 0.18, sad: 0.12 };

// Idle micro-life: a soft, slow-breathing smile while neutral & quiet, so the
// face is never a dead mannequin between lines.
const IDLE_SMILE = 0.06;
const IDLE_SMILE_HZ = 0.55;

// Emote face: a held smile and NO eye animation at all (user call after the
// wink choreography kept misbehaving) — auto-blink is suspended and all blink
// channels are pinned open for the emote's duration. Note: this model's
// `happy` morph inherently narrows the eyes a little as it smiles; 0.65
// keeps that mild. Lower → opener eyes, flatter smile.
const EMOTE_SMILE = 0.65;

/** protocol emotion → { vrmExpression: weight }. Richer blends so the weaker
 *  emotions actually read; neutral keeps a faint relaxed base so it's not blank.
 *  Detail also comes from per-emotion lids (EMOTION_LID) + gaze/posture in
 *  motion.js — face + eyes + head + body together sell the expression. */
const EMOTION_MAP = {
  neutral: { relaxed: 0.1 },
  happy: { happy: 1.0 },
  excited: { happy: 1.0, surprised: 0.35 },
  sad: { sad: 0.95 },
  angry: { angry: 0.9 },
  surprised: { surprised: 1.0 },
  shy: { happy: 0.45, relaxed: 0.3, sad: 0.12 }, // soft bashful smile
  pout: { angry: 0.4, sad: 0.5 },                // sulky frown
  curious: { surprised: 0.4, relaxed: 0.3 },     // bright, interested
  smug: { happy: 0.4, relaxed: 0.6 },            // satisfied smirk
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
    this.speaking = false; // set by main.js; scales emotion down so visemes lead
    this._speak = 0;       // 0..1 eased "speaking-ness"
    this._emotionName = "neutral";
    this._idleT = 0;

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
    // Log the full palette so we know what extra blendshapes the model offers
    // (custom VRoid expressions, if any, can be wired into the maps above).
    const all = (em?.expressions || []).map((e) => e.expressionName);
    if (all.length) console.info("[expressions] model palette:", all.join(", "));
  }

  /** Switch the active emotion; applied with a fast crossfade in update(). */
  setEmotion(name) {
    let map = EMOTION_MAP[name];
    if (map === undefined) {
      console.warn(`expressions: unknown emotion '${name}' — using neutral`);
      map = EMOTION_MAP.neutral;
      name = "neutral";
    }
    this._emotionName = name;
    for (const key of this._available) this._targets[key] = map[key] ?? 0;
    if (this.motion) {
      this.motion.suppressBlink = name === "surprised";
      this.motion.emotionLid = EMOTION_LID[name] ?? 0; // half-lidded looks
    }
  }

  /** Brief brow raise on a loud syllable; decays on its own. */
  pulseEmphasis() {
    this._emphasis = 1;
  }

  /**
   * Emote face: hold a smile with NO eye animation. Auto-blink is suspended
   * and the blink channels are pinned open for the whole emote, so the eyes
   * stay natural and open (no winks, no closing).
   */
  playEmote(duration) {
    this._emote = { t: 0, dur: Math.max(duration, 1.4) };
    for (const key of this._available) this._targets[key] = 0;
    if (this._available.has("happy")) this._targets["happy"] = EMOTE_SMILE;
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
    // Ease the emotion scale toward speaking/not (emote holds full emotion).
    const speakTarget = this.speaking && !this._emote ? 1 : 0;
    this._speak += (speakTarget - this._speak) * (1 - Math.exp(-delta / SPEAK_TAU));
    let eyeClose = 0; // how much the active emotion already shuts the eyes
    for (const name of this._available) {
      const s = this._weights[name];
      // Asymmetric: snap in as it intensifies, ease out gently as it relaxes.
      const target = this._targets[name];
      const settle = Math.abs(target) > Math.abs(s.x) ? FADE_IN : FADE_OUT;
      springTo(s, target, settle, 1.0, delta);
      // Ease toward the per-preset speaking scale: mouth-heavy presets duck more
      // so visemes lead; brow/eye-led ones stay strong (expressive while talking).
      const speakScale = 1 - this._speak * (1 - (SPEAK_SCALE[name] ?? SPEAK_SCALE_DEFAULT));
      let value = Math.min(1, Math.max(0, s.x)) * speakScale;
      if (name === "surprised") {
        // emphasis brow pulse stays at full strength (not scaled by speech)
        value = Math.max(value, EMPHASIS_BROW * this._emphasis);
      }
      em.setValue(name, value);
      // happy/excited close the eyes into a smile; relaxed narrows them a little
      if (name === "happy") eyeClose = Math.max(eyeClose, value);
      else if (name === "relaxed") eyeClose = Math.max(eyeClose, value * 0.5);
    }
    // Idle micro-life: a soft, slow-breathing smile while neutral & quiet, so the
    // face is never a dead mannequin between lines.
    if (this._emotionName === "neutral" && !this.speaking && !this._emote && this._available.has("relaxed")) {
      this._idleT += delta;
      const shimmer = IDLE_SMILE * (0.5 + 0.5 * Math.sin(this._idleT * 2 * Math.PI * IDLE_SMILE_HZ));
      em.setValue("relaxed", Math.max(em.getValue("relaxed") || 0, shimmer));
      eyeClose = Math.max(eyeClose, shimmer * 0.5);
    }
    // Tell the auto-blink to back off when the eyes are already shut by emotion.
    if (this.motion) this.motion.blinkSuppress = this._emote ? 0 : eyeClose;
    // Emote: hold the smile, keep the eyes fully open (no blink, no winks).
    // Runs after motion.js in the loop, so pinning the blink channels to 0
    // here overrides the suspended auto-blink for the emote's duration.
    if (this._emote) {
      this._emote.t += delta;
      if (this._eyes.blink) em.setValue("blink", 0);
      if (this._eyes.blinkLeft) em.setValue("blinkLeft", 0);
      if (this._eyes.blinkRight) em.setValue("blinkRight", 0);
      if (this._emote.t >= this._emote.dur) this._endEmote();
    }
  }
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
