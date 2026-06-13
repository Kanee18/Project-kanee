/**
 * Glitch materialization intro — the character doesn't just pop in, she
 * glitches into existence like a game spawn effect.
 *
 * Timeline:
 *   0.00 – 0.25 s  empty stage, heavy digital glitch builds (anticipation)
 *   0.25 – 1.00 s  character flickers in: visibility strobes, horizontal
 *                  jitter, vertical scale pops — still under heavy glitch
 *   1.00 – 1.60 s  character solid, glitch calms down
 *   1.60 s         post-processing removed, normal rendering resumes
 *
 * The GlitchPass (RGB shift + block displacement) runs through an
 * EffectComposer that only exists during the intro — zero cost afterwards.
 * It distorts the WebGL canvas only; the DOM chat panel stays clean.
 */
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GlitchPass } from "three/addons/postprocessing/GlitchPass.js";

const DURATION = 1.6;        // s, total intro length
const MATERIALIZE_AT = 0.25; // s, character starts flickering in
const WILD_UNTIL = 1.0;      // s, heavy glitch + flicker end here
const FLICKER_MIN = 0.03;    // s, visibility strobe interval
const FLICKER_MAX = 0.09;
const JITTER_X = 0.05;       // m, horizontal displacement while flickering
const SCALE_POP = 0.12;      // vertical scale wobble (±12%)

export class GlitchIntro {
  constructor(renderer, scene, camera) {
    this._renderer = renderer;
    this._scene = scene;
    this._camera = camera;
    this._composer = null;
    this._glitch = null;
    this._target = null;
    this._t = 0;
    this._flickerT = 0;
    this.active = false;
    this._welcomed = false;
    // Fired once the moment she becomes solid (overlaps the glitch settling),
    // so the welcome wave reads as "she arrives and greets you".
    this.onWelcome = null;
  }

  /** Start the intro; `target` is the VRM root (hidden until materialize). */
  begin(target) {
    this._target = target;
    target.visible = false;
    this._t = 0;
    this._flickerT = 0;
    this._welcomed = false;

    this._composer = new EffectComposer(this._renderer);
    const size = this._renderer.getSize(new THREE.Vector2());
    this._composer.setPixelRatio(this._renderer.getPixelRatio());
    this._composer.setSize(size.x, size.y);
    this._composer.addPass(new RenderPass(this._scene, this._camera));
    this._glitch = new GlitchPass();
    this._glitch.goWild = true; // continuous heavy glitch during spawn
    this._composer.addPass(this._glitch);

    this.active = true;
  }

  update(delta) {
    if (!this.active) return;
    this._t += delta;
    const t = this._t;
    const m = this._target;

    if (t < MATERIALIZE_AT) {
      m.visible = false;
    } else if (t < WILD_UNTIL) {
      this._flickerT -= delta;
      if (this._flickerT <= 0) {
        this._flickerT = FLICKER_MIN + Math.random() * (FLICKER_MAX - FLICKER_MIN);
        m.visible = !m.visible;
        m.position.x = m.visible ? (Math.random() * 2 - 1) * JITTER_X : 0;
        m.scale.y = 1 + (Math.random() * 2 - 1) * SCALE_POP;
      }
    } else {
      // solid — let the residual glitch calm down before handing back
      m.visible = true;
      m.position.x = 0;
      m.scale.y = 1;
      this._glitch.goWild = false;
      if (!this._welcomed) {
        this._welcomed = true;
        this.onWelcome?.(); // wave hello while the last glitches clear
      }
    }

    if (t >= DURATION) this._finish();
  }

  /** Render through the composer while active. */
  render() {
    this._composer?.render();
  }

  _finish() {
    const m = this._target;
    m.visible = true;
    m.position.x = 0;
    m.scale.y = 1;
    this.active = false;
    this._composer?.dispose();
    this._composer = null;
    this._glitch = null;
  }
}
