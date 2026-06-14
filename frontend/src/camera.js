/**
 * Cinematic camera moves on top of OrbitControls.
 *
 * showFull() eases the camera out to a framed full-body shot, holds for the
 * emote's duration, then glides back to wherever the user was looking. While
 * a move runs, OrbitControls is suspended (the director owns the camera);
 * control is handed back cleanly when it finishes.
 */
import * as THREE from "three";

const MOVE_DURATION = 0.9; // s each way

export class CameraDirector {
  constructor(camera, controls) {
    this.camera = camera;
    this.controls = controls;
    this._full = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
    this._home = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
    this._from = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
    this._to = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
    this._return = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
    this._tmp = new THREE.Vector3();
    this._t = 0;
    this._phase = "idle"; // idle | toFull | hold | toHome
    this._holdLeft = 0;
    this._holdFor = 0;
  }

  /** Capture the current camera pose as "home" — the default view to snap back
   *  to (call once after the startup framing is set). */
  setHome() {
    this._home.pos.copy(this.camera.position);
    this._home.target.copy(this.controls.target);
  }

  /**
   * Ease the camera back to the default (home) view and release control there,
   * wherever the user had scrolled/orbited to. Used when a hidden animation
   * fires so it's always seen from the default framing. No-op if already home.
   */
  returnHome() {
    if (this._phase !== "idle") {
      // A move is mid-flight — just retarget its homecoming to the default.
      this._return.pos.copy(this._home.pos);
      this._return.target.copy(this._home.target);
      return;
    }
    if (
      this.camera.position.distanceTo(this._home.pos) < 0.02 &&
      this.controls.target.distanceTo(this._home.target) < 0.02
    ) {
      return; // already at the default view
    }
    this._return.pos.copy(this._home.pos);
    this._return.target.copy(this._home.target);
    this.controls.enabled = false;
    this._begin("toHome", this._home);
  }

  /** Compute the full-body framing from the model's bounding box (call once). */
  frameFromModel(root) {
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const fitDist = (size.y * 0.5) / Math.tan((this.camera.fov * 0.5 * Math.PI) / 180);
    const dist = fitDist * 1.12 + size.z * 0.5; // small margin + depth clearance
    this._full.pos.set(0, center.y, dist);
    this._full.target.set(0, center.y, 0);
  }

  get active() {
    return this._phase !== "idle";
  }

  /** Ease out to the full-body shot, hold `hold` s, ease back. */
  showFull(hold = 3) {
    this._return.pos.copy(this.camera.position);
    this._return.target.copy(this.controls.target);
    this._holdFor = hold;
    this.controls.enabled = false;
    this._begin("toFull", this._full);
  }

  _begin(phase, to) {
    this._phase = phase;
    this._from.pos.copy(this.camera.position);
    this._from.target.copy(this.controls.target);
    this._to.pos.copy(to.pos);
    this._to.target.copy(to.target);
    this._t = 0;
  }

  /** Returns true while the director controls the camera (skip controls.update). */
  update(delta) {
    if (this._phase === "idle") return false;

    if (this._phase === "hold") {
      this._holdLeft -= delta;
      this._apply(this._full.pos, this._full.target);
      if (this._holdLeft <= 0) this._begin("toHome", this._return);
      return true;
    }

    this._t += delta;
    const k = smooth(Math.min(this._t / MOVE_DURATION, 1));
    this._tmp.lerpVectors(this._from.pos, this._to.pos, k);
    const tx = this._from.target.x + (this._to.target.x - this._from.target.x) * k;
    const ty = this._from.target.y + (this._to.target.y - this._from.target.y) * k;
    const tz = this._from.target.z + (this._to.target.z - this._from.target.z) * k;
    this._apply(this._tmp, { x: tx, y: ty, z: tz });

    if (this._t >= MOVE_DURATION) {
      if (this._phase === "toFull") {
        this._phase = "hold";
        this._holdLeft = this._holdFor;
      } else {
        // back home — resync OrbitControls to the current pose and release
        this._phase = "idle";
        this.controls.target.copy(this._return.target);
        this.camera.position.copy(this._return.pos);
        this.controls.enabled = true;
        this.controls.update();
      }
    }
    return true;
  }

  _apply(pos, target) {
    this.camera.position.copy(pos);
    this.controls.target.set(target.x, target.y, target.z);
    this.camera.lookAt(target.x, target.y, target.z);
  }
}

function smooth(x) {
  return x * x * (3 - 2 * x);
}
