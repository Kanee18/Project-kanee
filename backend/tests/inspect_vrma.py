"""Inspect a .vrma (VRM animation) GLB: list its animation channels and the
VRMC_vrm_animation humanoid/expression mappings, to see whether the clip
animates expressions (blink) or eye bones.

    py tests/inspect_vrma.py "../assets/emotes/Kawaii Kaiwai.vrma"
"""

import json
import struct
import sys
from pathlib import Path


def read_glb_json(path: Path) -> dict:
    data = path.read_bytes()
    magic, _v, _l = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        sys.exit(f"{path} is not a GLB")
    off = 12
    while off < len(data):
        clen, ctype = struct.unpack_from("<I4s", data, off)
        off += 8
        if ctype == b"JSON":
            return json.loads(data[off : off + clen])
        off += clen
    sys.exit("no JSON chunk")


def main() -> None:
    p = Path(sys.argv[1] if len(sys.argv) > 1 else "../assets/emotes/Kawaii Kaiwai.vrma")
    p = (Path(__file__).resolve().parent / p).resolve() if not p.is_absolute() else p
    gltf = read_glb_json(p)
    print(f"file: {p.name}")

    nodes = gltf.get("nodes", [])
    ext = gltf.get("extensions", {}).get("VRMC_vrm_animation", {})

    # node index -> humanoid bone name
    node_to_bone = {}
    humanoid = ext.get("humanoid", {}).get("humanBones", {})
    for bone, spec in humanoid.items():
        node_to_bone[spec.get("node")] = bone

    # expression name -> node index (VRMA animates expressions via proxy nodes)
    expr_nodes = {}
    for kind in ("preset", "custom"):
        for name, spec in (ext.get("expressions", {}).get(kind) or {}).items():
            expr_nodes[spec.get("node")] = name

    print(f"\nhumanoid bones animated-capable: {len(humanoid)}")
    print(f"expression channels mapped: {sorted(expr_nodes.values()) or 'NONE'}")

    # Walk animation channels: which nodes/paths are actually keyframed?
    bone_targets, expr_targets, other = set(), set(), set()
    for anim in gltf.get("animations", []):
        for ch in anim.get("channels", []):
            tgt = ch.get("target", {})
            node = tgt.get("node")
            path = tgt.get("path")
            if node in node_to_bone:
                bone_targets.add(f"{node_to_bone[node]}.{path}")
            elif node in expr_nodes:
                expr_targets.add(f"{expr_nodes[node]}.{path}")
            else:
                nm = nodes[node].get("name", f"node{node}") if node is not None and node < len(nodes) else str(node)
                other.add(f"{nm}.{path}")

    print(f"\nANIMATED expression channels: {sorted(expr_targets) or 'none'}")
    eyebones = sorted(b for b in bone_targets if "Eye" in b)
    print(f"ANIMATED eye-bone channels:   {eyebones or 'none'}")
    print(f"ANIMATED humanoid bones: {len(bone_targets)} channels")
    if other:
        print(f"other animated nodes: {sorted(other)[:20]}")

    has_blink = any("blink" in e.lower() for e in expr_targets)
    print("\n--> clip animates BLINK expressions:", has_blink)
    print("--> clip animates EYE bones:", bool(eyebones))


if __name__ == "__main__":
    main()
