/**
 * Holographic answer screen — a DOM panel styled as a floating hologram that
 * appears next to the character's right hand (after she finishes speaking the
 * math answer). The anchor is captured from the hand's position at the moment
 * it's shown and held fixed in world space — so it sits by the hand but does
 * NOT chase it frame-by-frame as the animation moves.
 */
import * as THREE from "three";

// Offset from the right hand (m). HAND_SIDE is the horizontal placement:
// negative = screen-left, positive = screen-right (the hand is usually near
// center, so a large magnitude pushes the panel clearly to one side).
const HAND_SIDE = -0.04;
const HAND_UP = 0.08;
const HAND_FWD = 0.12;

export class Hologram {
  constructor(viewport) {
    this._viewport = viewport;
    this._el = document.createElement("div");
    this._el.className = "hologram";
    this._el.innerHTML = `<div class="holo-expr"></div><div class="holo-answer"></div>`;
    this._exprEl = this._el.querySelector(".holo-expr");
    this._ansEl = this._el.querySelector(".holo-answer");
    this._el.hidden = true;
    viewport.appendChild(this._el);

    this._anchor = new THREE.Vector3(); // fixed world point for the current showing
    this._hand = new THREE.Vector3();
    this._proj = new THREE.Vector3();
    this.visible = false;
  }

  /** Show the answer next to the right hand; anchor is captured now and held. */
  show(expr, answer, vrm) {
    this._exprEl.textContent = expr;
    this._ansEl.textContent = `= ${answer}`;

    const hand = vrm?.humanoid?.getRawBoneNode("rightHand");
    if (hand) hand.getWorldPosition(this._hand);
    else this._hand.set(0.25, 1.0, 0); // fallback if the bone is missing
    this._anchor.set(
      this._hand.x + HAND_SIDE,
      this._hand.y + HAND_UP,
      this._hand.z + HAND_FWD,
    );

    this._el.hidden = false;
    this._el.classList.remove("holo-in");
    void this._el.offsetWidth; // reflow so the entrance animation replays
    this._el.classList.add("holo-in");
    this.visible = true;
  }

  hide() {
    this.visible = false;
    this._el.hidden = true;
  }

  /** Re-project the fixed anchor to screen space each frame (camera may orbit). */
  update(camera) {
    if (!this.visible) return;
    this._proj.copy(this._anchor).project(camera);
    if (this._proj.z > 1) {
      this._el.style.opacity = "0"; // behind the camera
      return;
    }
    this._el.style.opacity = "1";
    const w = this._viewport.clientWidth;
    const h = this._viewport.clientHeight;
    this._el.style.left = `${(this._proj.x * 0.5 + 0.5) * w}px`;
    this._el.style.top = `${(-this._proj.y * 0.5 + 0.5) * h}px`;
  }
}
