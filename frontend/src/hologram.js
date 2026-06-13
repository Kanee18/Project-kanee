/**
 * Holographic answer screen — a small DOM panel styled as a floating hologram
 * that appears to the right of the character (after she finishes speaking the
 * math answer) and stays anchored there in world space as the camera orbits.
 * Position is a fixed point beside her head, captured when shown — it does NOT
 * follow the hand.
 */
import * as THREE from "three";

const RIGHT_OFFSET = 0.45; // m to the viewer's right of the head (flip sign for her other side)
const DOWN_OFFSET = 0.1;   // m below head height (toward the shoulder)
const FWD_OFFSET = 0.15;   // m toward the camera

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
    this._head = new THREE.Vector3();
    this._proj = new THREE.Vector3();
    this.visible = false;
  }

  /** Show the answer beside the character; anchor is captured now and held. */
  show(expr, answer, vrm) {
    this._exprEl.textContent = expr;
    this._ansEl.textContent = `= ${answer}`;

    const head = vrm?.humanoid?.getRawBoneNode("head");
    if (head) head.getWorldPosition(this._head);
    else this._head.set(0, 1.3, 0);
    this._anchor.set(
      this._head.x + RIGHT_OFFSET,
      this._head.y - DOWN_OFFSET,
      this._head.z + FWD_OFFSET,
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
