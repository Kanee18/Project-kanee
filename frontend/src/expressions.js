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

const FADE_TAU = 0.07;       // s — ~95% of the way in 0.2 s (anime-snappy)
const EMPHASIS_BROW = 0.2;   // 'surprised' weight at full emphasis
const EMPHASIS_TAU = 0.25;   // s — emphasis pulse decay

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

    // Which mapped expressions does this model actually have?
    const em = vrm.expressionManager;
    this._available = new Set();
    const wanted = new Set(Object.values(EMOTION_MAP).flatMap(Object.keys));
    for (const name of wanted) {
      if (em && em.getExpression(name)) {
        this._available.add(name);
        this._weights[name] = 0;
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

  /** Back to neutral — used on interrupt only; normal replies hold. */
  reset() {
    this.setEmotion("neutral");
    this._emphasis = 0;
  }

  update(delta) {
    const em = this.vrm.expressionManager;
    if (!em) return;
    this._emphasis *= Math.exp(-delta / EMPHASIS_TAU);
    const k = 1 - Math.exp(-delta / FADE_TAU);
    for (const name of this._available) {
      this._weights[name] += (this._targets[name] - this._weights[name]) * k;
      let value = this._weights[name];
      if (name === "surprised") {
        value = Math.max(value, EMPHASIS_BROW * this._emphasis);
      }
      em.setValue(name, value);
    }
  }
}
