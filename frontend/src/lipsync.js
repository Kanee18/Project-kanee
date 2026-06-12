/**
 * Spectral lip sync: amplitude drives how far the mouth opens; the spectrum
 * decides its SHAPE. The energy-weighted spectral centroid ("brightness")
 * of the voice maps onto a dark→bright vowel axis — rounded back vowels
 * (U, O) are dark, open A sits mid, spread-lip E and I are bright — and the
 * two nearest visemes blend smoothly. All five VRM visemes (aa ih ou ee oh
 * = A I U E O) are driven, so spoken vowels produce visibly different
 * mouth shapes instead of a generic flap.
 *
 * Openness keeps the ~50 ms attack / ~120 ms release envelope; between
 * segments the analyser reads silence and the mouth closes on its own.
 * Visemes are set every frame, independently of the emotion expression layer.
 */

const ATTACK = 0.05;   // s, rising
const RELEASE = 0.12;  // s, falling
const GAIN = 6;        // RMS → level scale; too high pins the level at 1 on every word
const MAX_OPEN = 0.6;  // cap on viseme weight — a fully-open `aa` reads as a yell, not speech
const VOWEL_TAU = 0.08;       // s — how fast the mouth glides between vowel shapes
const CENTROID_DARK = 350;    // Hz — centroid this low reads as U
const CENTROID_BRIGHT = 2800; // Hz — centroid this high reads as I
const BAND_LO = 100;          // Hz — analyzed speech band
const BAND_HI = 5500;

/** viseme → position on the normalized dark→bright axis */
const VOWELS = [
  ["ou", 0.1], // U — rounded, darkest
  ["oh", 0.3], // O
  ["aa", 0.5], // A — open, mid
  ["ee", 0.7], // E
  ["ih", 0.9], // I — spread lips, brightest
];
const VOWEL_RADIUS = 0.25; // blend reach along the axis

export class LipSync {
  constructor(vrm) {
    this.vrm = vrm;
    this._analyser = null;
    this._time = null;  // time-domain samples (level)
    this._freq = null;  // frequency-domain magnitudes (vowel)
    this._binHz = 0;
    this._level = 0;
    this._axis = 0.5;   // smoothed vowel axis; starts on A
  }

  /** Smoothed speech amplitude 0..1 — motion.js drives sway/hands with it. */
  get level() {
    return this._level;
  }

  /** Hook up the player's pass-through analyser (created lazily with audio). */
  setAnalyser(analyser) {
    this._analyser = analyser;
    this._time = new Float32Array(analyser.fftSize);
    this._freq = new Uint8Array(analyser.frequencyBinCount);
    this._binHz = analyser.context.sampleRate / analyser.fftSize;
  }

  update(delta) {
    // -- openness: RMS with attack/release smoothing
    let target = 0;
    if (this._analyser) {
      this._analyser.getFloatTimeDomainData(this._time);
      let sum = 0;
      for (let i = 0; i < this._time.length; i++) sum += this._time[i] * this._time[i];
      target = Math.min(1, Math.sqrt(sum / this._time.length) * GAIN);
    }
    const tau = target > this._level ? ATTACK : RELEASE;
    this._level += (target - this._level) * (1 - Math.exp(-delta / tau));

    const em = this.vrm.expressionManager;
    if (!em) return;

    // -- shape: spectral centroid → vowel axis (only while actually audible)
    if (this._analyser && this._level > 0.05) {
      this._analyser.getByteFrequencyData(this._freq);
      const lo = Math.max(1, Math.floor(BAND_LO / this._binHz));
      const hi = Math.min(this._freq.length - 1, Math.ceil(BAND_HI / this._binHz));
      let energy = 0;
      let weighted = 0;
      for (let i = lo; i <= hi; i++) {
        const e = (this._freq[i] / 255) ** 2;
        energy += e;
        weighted += e * i * this._binHz;
      }
      if (energy > 1e-6) {
        const centroid = weighted / energy;
        const axisTarget = clamp01(
          (Math.log(centroid) - Math.log(CENTROID_DARK)) /
            (Math.log(CENTROID_BRIGHT) - Math.log(CENTROID_DARK)),
        );
        this._axis += (axisTarget - this._axis) * (1 - Math.exp(-delta / VOWEL_TAU));
      }
    }

    // -- blend the nearest visemes around the axis, scaled by openness
    const open = this._level * MAX_OPEN;
    let total = 0;
    const weights = [];
    for (const [name, pos] of VOWELS) {
      const w = Math.max(0, 1 - Math.abs(this._axis - pos) / VOWEL_RADIUS);
      weights.push([name, w]);
      total += w;
    }
    for (const [name, w] of weights) {
      em.setValue(name, total > 0 ? (w / total) * open : 0);
    }
  }
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}
