"""Static VRM inspector (Milestone-independent diagnostic tool).

Reads the glTF JSON chunk of assets/character.vrm and reports what the model
actually contains: VRM version, humanoid bone map, expressions/blendshapes,
and spring bone configuration — without needing a browser.

    py tests/inspect_vrm.py
"""

import json
import struct
import sys
from pathlib import Path

VRM_PATH = Path(__file__).resolve().parents[2] / "assets" / "character.vrm"

# Bones the frontend's procedural layer (motion.js) touches:
USED_BONES = [
    "hips", "spine", "chest", "upperChest", "neck", "head",
    "leftShoulder", "rightShoulder",
    "leftUpperArm", "rightUpperArm", "leftLowerArm", "rightLowerArm",
    "leftHand", "rightHand",
]
# Expressions the frontend uses (VRM1 names):
USED_EXPRESSIONS = [
    "happy", "sad", "angry", "surprised", "relaxed", "blink",
    "aa", "ih", "ou", "ee", "oh",
]


def read_glb_json(path: Path) -> dict:
    data = path.read_bytes()
    magic, _version, _length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        sys.exit(f"{path} is not a GLB file")
    offset = 12
    while offset < len(data):
        chunk_len, chunk_type = struct.unpack_from("<I4s", data, offset)
        offset += 8
        if chunk_type == b"JSON":
            return json.loads(data[offset : offset + chunk_len])
        offset += chunk_len
    sys.exit("no JSON chunk found")


def main() -> None:
    if not VRM_PATH.exists():
        sys.exit(f"not found: {VRM_PATH}")
    gltf = read_glb_json(VRM_PATH)
    exts = gltf.get("extensions", {})

    if "VRMC_vrm" in exts:
        vrm = exts["VRMC_vrm"]
        print(f"VRM version: 1.x (specVersion {vrm.get('specVersion')})")
        bones = vrm.get("humanoid", {}).get("humanBones", {})
        bone_names = sorted(bones.keys())
        presets = sorted((vrm.get("expressions", {}).get("preset") or {}).keys())
        customs = sorted((vrm.get("expressions", {}).get("custom") or {}).keys())
        # expression override flags (the conflict mechanism)
        overrides = {}
        for name, e in (vrm.get("expressions", {}).get("preset") or {}).items():
            o = {k: e[k] for k in ("overrideBlink", "overrideLookAt", "overrideMouth") if e.get(k, "none") != "none"}
            if o:
                overrides[name] = o
        springs = exts.get("VRMC_springBone", {}).get("springs", [])
        n_joints = sum(len(s.get("joints", [])) for s in springs)
        spring_names = [s.get("name", "?") for s in springs]
    elif "VRM" in exts:
        vrm = exts["VRM"]
        print(f"VRM version: 0.x (exporterVersion {vrm.get('exporterVersion')})")
        bones = vrm.get("humanoid", {}).get("humanBones", [])
        bone_names = sorted(b["bone"] for b in bones)
        groups = vrm.get("blendShapeMaster", {}).get("blendShapeGroups", [])
        presets = sorted(g.get("presetName", "") for g in groups if g.get("presetName") and g.get("presetName") != "unknown")
        customs = sorted(g.get("name", "") for g in groups if g.get("presetName") in (None, "", "unknown"))
        overrides = {}  # VRM0 has no override flags (isBinary only)
        sa = vrm.get("secondaryAnimation", {})
        bone_groups = sa.get("boneGroups", [])
        n_joints = sum(len(g.get("bones", [])) for g in bone_groups)
        spring_names = [g.get("comment", "?") for g in bone_groups]
    else:
        sys.exit("no VRM extension found in this file")

    print(f"\nHumanoid bones present ({len(bone_names)}):")
    print("  " + ", ".join(bone_names))
    missing = [b for b in USED_BONES if b not in bone_names]
    print(f"\nBones our motion layer uses but the model LACKS: {missing or 'none — all present'}")

    print(f"\nExpressions/blendshapes — presets ({len(presets)}): {', '.join(presets) or 'NONE'}")
    print(f"Custom expressions ({len(customs)}): {', '.join(customs) or 'none'}")
    # VRM0 preset names map: joy->happy, sorrow->sad, angry->angry, fun->relaxed, a/i/u/e/o->aa/ih/ou/ee/oh, blink->blink
    vrm0_map = {"joy": "happy", "sorrow": "sad", "fun": "relaxed", "angry": "angry",
                "surprised": "surprised", "a": "aa", "i": "ih", "u": "ou", "e": "ee", "o": "oh",
                "blink": "blink"}
    normalized = {vrm0_map.get(p, p) for p in presets}
    missing_expr = [e for e in USED_EXPRESSIONS if e not in normalized]
    print(f"Expressions we use but the model LACKS (after VRM0->VRM1 mapping): {missing_expr or 'none — all present'}")
    if overrides:
        print(f"\nOverride flags (conflict mechanism!): {json.dumps(overrides, indent=2)}")
    else:
        print("\nOverride flags: none declared")

    print(f"\nSpring bones: {len(spring_names)} group(s), {n_joints} joint(s) total")
    if spring_names:
        print("  groups: " + ", ".join(str(s) for s in spring_names[:20]))
    if n_joints == 0:
        print("  !! NO spring bones — hair/skirt will never move regardless of body motion")


if __name__ == "__main__":
    main()
