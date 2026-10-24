#!/usr/bin/env python3
"""Import the final reviewed concept sources, then build the standalone site."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]


def export(visual_root: Path, project: Path = PROJECT) -> None:
    required = {
        "fragment": "maple-atlas-navigation.html",
        "runtime": "maple-navigation-runtime.js",
        "world": "victoria-vector-art.svg",
        "data": "maple-map-data.json",
        "fullscreen": "fullscreen-preview.css",
    }
    source = {}
    for key, name in required.items():
        path = visual_root / name
        if not path.is_file():
            raise ValueError(f"Missing reviewed source: {path}")
        source[key] = path.read_text(encoding="utf-8")

    fragment = source["fragment"]
    styles = re.findall(r"<style>(.*?)</style>", fragment, flags=re.S)
    if len(styles) != 1:
        raise ValueError("Expected one application style block.")
    fragment = re.sub(r"<style>.*?</style>", "", fragment, count=1, flags=re.S)
    fragment, scripts_removed = re.subn(r"<script>.*?</script>", "", fragment, flags=re.S)
    if scripts_removed != 1:
        raise ValueError("Expected one generated runtime block.")

    world_start_marker = '<g id="mc-world">'
    start = fragment.index(world_start_marker) + len(world_start_marker)
    end = fragment.index('<path id="mc-routehalo"', start)
    world_region = fragment[start:end]
    network = re.search(r'<path\b[^>]*\bid="mc-network"[^>]*/>', world_region)
    if not network:
        raise ValueError("Missing recorded-connection overlay.")
    fragment = fragment[:start] + "\n<!-- MAPLE_WORLD -->\n" + network.group(0) + "\n" + fragment[end:]
    if "__INLINE_MAP_DATA__" not in source["runtime"]:
        raise ValueError("Runtime must retain its data injection placeholder.")

    data = json.loads(source["data"])
    if not all(key in data for key in ("maps", "spots", "quests", "artRoutes", "sprites")):
        raise ValueError("World data is missing required collections.")

    src = project / "src"
    data_dir = project / "data"
    src.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)
    outputs = {
        src / "template.html": fragment.strip() + "\n",
        src / "app.css": styles[0].strip() + "\n",
        src / "fullscreen.css": source["fullscreen"],
        src / "runtime.js": source["runtime"],
        src / "world.svg": source["world"],
        data_dir / "world.json": json.dumps(data, ensure_ascii=False, indent=2) + "\n",
    }
    manifest_path = visual_root / "sprite-manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        provenance = {key: manifest[key] for key in (
            "retrievedAt", "repo", "commit", "sourceMetadata", "verification", "rights", "notes"
        ) if key in manifest}
        provenance["worldSource"] = data.get("source")
        provenance["worldSnapshot"] = data.get("snapshot")
        outputs[data_dir / "provenance.json"] = json.dumps(provenance, ensure_ascii=False, indent=2) + "\n"
    for path, content in outputs.items():
        path.write_text(content, encoding="utf-8")
    subprocess.run([sys.executable, str(project / "scripts" / "build.py")], check=True)
    print(f"Imported {len(data['maps'])} maps and {len(data['spots'])} reviewed atlas positions.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("visual_root", type=Path, help="Directory containing the final reviewed concept sources")
    args = parser.parse_args()
    export(args.visual_root.expanduser().resolve())


if __name__ == "__main__":
    main()
