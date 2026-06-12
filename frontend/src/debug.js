/**
 * Temporary diagnostic overlay (Step 2 of the animation overhaul).
 *
 * Shows, live per frame:
 *  - spring bone joint count + proof they're ticking (per-frame joint motion)
 *  - current audio amplitude (lip-sync level)
 *  - every non-zero VRM expression weight
 * Logs once at attach:
 *  - all humanoid bone names (raw + normalized node names) as console.table
 *  - the Step-5 spring bone count line
 *
 * Toggle visibility with F8. Remove this module when diagnosis is done.
 */
import * as THREE from "three";

const BONES = [
  "hips", "spine", "chest", "upperChest", "neck", "head",
  "leftShoulder", "rightShoulder", "leftUpperArm", "rightUpperArm",
  "leftLowerArm", "rightLowerArm", "leftHand", "rightHand",
  "leftUpperLeg", "rightUpperLeg", "leftEye", "rightEye",
];

export class DebugOverlay {
  constructor() {
    this._el = document.createElement("pre");
    Object.assign(this._el.style, {
      position: "fixed",
      left: "0.75rem",
      bottom: "4.5rem",
      zIndex: 20,
      margin: 0,
      padding: "0.5rem 0.7rem",
      font: "11px/1.45 Consolas, monospace",
      background: "rgba(10,10,16,0.82)",
      color: "#8f8",
      border: "1px solid #353",
      borderRadius: "6px",
      pointerEvents: "none",
      whiteSpace: "pre",
    });
    this._el.textContent = "debug: waiting for avatar…";
    document.body.appendChild(this._el);
    document.addEventListener("keydown", (e) => {
      if (e.code === "F8") this._el.hidden = !this._el.hidden;
    });

    this._vrm = null;
    this._getLevel = () => 0;
    this._joint = null;
    this._jointPrev = new THREE.Vector3();
    this._jointPos = new THREE.Vector3();
    this._springDelta = 0;
    this._acc = 0;
  }

  attach(vrm, getLevel) {
    this._vrm = vrm;
    this._getLevel = getLevel;

    // -- one-time logs ------------------------------------------------------
    const rows = [];
    for (const name of BONES) {
      const raw = vrm.humanoid?.getRawBoneNode(name);
      const normalized = vrm.humanoid?.getNormalizedBoneNode(name);
      rows.push({
        bone: name,
        rawNode: raw ? raw.name : "— MISSING —",
        normalizedNode: normalized ? normalized.name : "— MISSING —",
      });
    }
    console.table(rows);

    const joints = vrm.springBoneManager?.joints;
    const jointCount = joints?.size ?? joints?.length ?? 0;
    // Step 5 verification line (exact shape requested):
    console.log("Spring bones:", jointCount);

    if (jointCount > 0) {
      this._joint = joints.values().next().value; // watch one joint for motion
      this._joint.bone.getWorldPosition(this._jointPrev);
    }

    const exprs = vrm.expressionManager?.expressions?.map((e) => e.expressionName);
    console.log("Expressions:", exprs);
  }

  /** Call every frame from the render loop (display throttled to 10 Hz). */
  update(delta) {
    if (!this._vrm) return;

    if (this._joint) {
      this._joint.bone.getWorldPosition(this._jointPos);
      this._springDelta = this._jointPos.distanceTo(this._jointPrev);
      this._jointPrev.copy(this._jointPos);
    }

    this._acc += delta;
    if (this._acc < 0.1) return;
    this._acc = 0;

    const em = this._vrm.expressionManager;
    const weights = [];
    if (em) {
      for (const expr of em.expressions) {
        const v = em.getValue(expr.expressionName);
        if (v > 0.005) weights.push(`${expr.expressionName}=${v.toFixed(2)}`);
      }
    }
    const joints = this._vrm.springBoneManager?.joints;
    const jointCount = joints?.size ?? joints?.length ?? 0;

    this._el.textContent = [
      `spring joints : ${jointCount}  (motion ${(this._springDelta * 1000).toFixed(2)} mm/frame ${this._springDelta > 1e-5 ? "— TICKING" : "— STATIC"})`,
      `audio level   : ${this._getLevel().toFixed(3)}  ${bar(this._getLevel())}`,
      `expressions   : ${weights.length ? weights.join("  ") : "(all zero)"}`,
      `toggle: F8`,
    ].join("\n");
  }
}

function bar(v) {
  const n = Math.round(Math.min(1, Math.max(0, v)) * 20);
  return "█".repeat(n) + "░".repeat(20 - n);
}
