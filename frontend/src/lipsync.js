/**
 * Hybrid text+audio lip sync.
 *
 * WHICH mouth shape comes from the segment TEXT (we know every word before
 * the audio plays): letters map to the five VRM visemes (A-I-U-E-O), with
 * real co-articulation rules — lips close on M/B/P, consonants carry the
 * previous vowel at reduced openness, the mouth relaxes between words and
 * at punctuation. The event track is distributed over the audio's real
 * duration and sampled against the AudioContext clock.
 *
 * HOW OPEN comes from the live audio: RMS with ~40 ms attack / ~110 ms
 * release, so silence closes the mouth and loud syllables open it wider.
 *
 * When no text track is active (rare), falls back to spectral-centroid
 * vowel estimation. Visemes are set every frame, independent of emotions.
 */

const ATTACK = 0.04;   // s, level rising
const RELEASE = 0.11;  // s, level falling
const GAIN = 6;        // RMS → level scale
const MAX_OPEN = 0.62; // viseme weight cap — full open reads as a yell
const SHAPE_TAU = 0.045; // s — mouth glides between letter shapes
const OPEN_TAU = 0.05;   // s — openness multiplier smoothing
const SPEECH_TAIL = 0.94; // assume the last ~6% of audio is trailing silence

// spectral fallback (no text track)
const CENTROID_DARK = 350;    // Hz — reads as U
const CENTROID_BRIGHT = 2800; // Hz — reads as I
const BAND_LO = 100;
const BAND_HI = 5500;
const VOWELS = [
  ["ou", 0.1], ["oh", 0.3], ["aa", 0.5], ["ee", 0.7], ["ih", 0.9],
];
const VOWEL_TAU = 0.08;

const VISEME_NAMES = ["aa", "ih", "ou", "ee", "oh"];
const VOWEL_OF = { a: "aa", e: "ee", i: "ih", o: "oh", u: "ou", y: "ih" };

/**
 * text → ordered viseme events, each with a duration weight and an openness
 * multiplier; spans are normalized 0..1 over the spoken duration.
 */
function buildTrack(text) {
  const events = [];
  let vowel = "aa"; // co-articulation: consonants keep the last vowel shape
  const push = (viseme, openMul, w) => events.push({ viseme, openMul, w });
  for (const ch of text.toLowerCase()) {
    const v = VOWEL_OF[ch];
    if (v) {
      vowel = v;
      push(v, 1.0, 1.0);
    } else if (ch === "m" || ch === "b" || ch === "p") {
      push(vowel, 0.06, 0.55); // bilabial: lips together
    } else if (ch === "w") {
      vowel = "ou";
      push("ou", 0.7, 0.6);
    } else if (ch === "f" || ch === "v") {
      push("ou", 0.4, 0.5);
    } else if (ch >= "a" && ch <= "z") {
      push(vowel, 0.55, 0.45); // other consonants: carried vowel, half open
    } else if (ch >= "0" && ch <= "9") {
      push("aa", 1.0, 1.2);
    } else if (ch === " ") {
      push(vowel, 0.3, 0.6);
    } else if (",;:".includes(ch)) {
      push(vowel, 0.15, 1.4);
    } else if (".!?…".includes(ch)) {
      push(vowel, 0.1, 1.8);
    }
    // apostrophes/quotes/etc. contribute nothing
  }
  if (events.length === 0) return null;
  // merge runs of the same shape so doubled letters don't double-pulse
  const merged = [];
  for (const e of events) {
    const last = merged[merged.length - 1];
    if (last && last.viseme === e.viseme && last.openMul === e.openMul) {
      last.w += e.w * 0.6;
    } else {
      merged.push({ ...e });
    }
  }
  let total = 0;
  for (const e of merged) total += e.w;
  let acc = 0;
  for (const e of merged) {
    e.t0 = acc / total;
    acc += e.w;
    e.t1 = acc / total;
  }
  return merged;
}

export class LipSync {
  constructor(vrm) {
    this.vrm = vrm;
    this._analyser = null;
    this._time = null;
    this._freq = null;
    this._binHz = 0;
    this._level = 0;
    this._axis = 0.5;
    this._track = null;
    this._trackIdx = 0;
    this._segStart = 0;
    this._segDur = 1;
    this._shape = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    this._openMul = 1;
  }

  /** Smoothed speech amplitude 0..1 — motion.js drives sway/hands with it. */
  get level() {
    return this._level;
  }

  setAnalyser(analyser) {
    this._analyser = analyser;
    this._time = new Float32Array(analyser.fftSize);
    this._freq = new Uint8Array(analyser.frequencyBinCount);
    this._binHz = analyser.context.sampleRate / analyser.fftSize;
  }

  /** Call when a segment's audio starts: its text drives the mouth shapes. */
  beginSegment(text, audioDuration) {
    if (!this._analyser || !text) return;
    this._track = buildTrack(text);
    this._trackIdx = 0;
    this._segStart = this._analyser.context.currentTime;
    this._segDur = Math.max(0.05, audioDuration * SPEECH_TAIL);
  }

  /** Call when audio stops (segment end or interrupt). */
  endSegment() {
    this._track = null;
  }

  update(delta) {
    delta = Math.min(delta, 0.05);
    // -- openness level: RMS with attack/release
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

    // -- shape: text track when active, spectral fallback otherwise
    let shapeViseme = null;
    let openMul = 1;
    if (this._track) {
      const p = (this._analyser.context.currentTime - this._segStart) / this._segDur;
      if (p >= 1) {
        this._track = null;
      } else if (p >= 0) {
        while (
          this._trackIdx < this._track.length - 1 &&
          p >= this._track[this._trackIdx].t1
        ) {
          this._trackIdx++;
        }
        const e = this._track[this._trackIdx];
        shapeViseme = e.viseme;
        openMul = e.openMul;
      }
    }
    if (!shapeViseme) {
      shapeViseme = this._spectralViseme(delta);
      openMul = 1;
    }

    // -- smooth shape (one-hot target) and openness multiplier
    const ks = 1 - Math.exp(-delta / SHAPE_TAU);
    for (const name of VISEME_NAMES) {
      const t = name === shapeViseme ? 1 : 0;
      this._shape[name] += (t - this._shape[name]) * ks;
    }
    this._openMul += (openMul - this._openMul) * (1 - Math.exp(-delta / OPEN_TAU));

    const open = this._level * MAX_OPEN * this._openMul;
    for (const name of VISEME_NAMES) {
      em.setValue(name, this._shape[name] * open);
    }
  }

  /** Spectral-centroid vowel estimate (fallback when no text track). */
  _spectralViseme(delta) {
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
        const axisTarget = Math.min(1, Math.max(0,
          (Math.log(centroid) - Math.log(CENTROID_DARK)) /
            (Math.log(CENTROID_BRIGHT) - Math.log(CENTROID_DARK))));
        this._axis += (axisTarget - this._axis) * (1 - Math.exp(-delta / VOWEL_TAU));
      }
    }
    // nearest viseme along the brightness axis
    let best = "aa";
    let bestD = Infinity;
    for (const [name, pos] of VOWELS) {
      const d = Math.abs(this._axis - pos);
      if (d < bestD) {
        bestD = d;
        best = name;
      }
    }
    return best;
  }
}
