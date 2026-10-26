#!/usr/bin/env bash
# Builds windows/build/MapleAtlasCompanion-Setup.exe: a setup program that installs one
# MapleAtlasCompanion.exe (pairing helper + companion window + matcher, all embedded)
# with Start menu and desktop shortcuts. Cross-compiles from macOS or Linux; needs
# Go 1.22+, makensis (brew install makensis) and go-winres (go install
# github.com/tc-hib/go-winres@latest) for the app icon.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINK="$REPO/macos/link"
WEBUI="$LINK/webui"
OUT="$REPO/windows/build"
VERSION="${VERSION:-0.3.3}"
WINRES="$(command -v go-winres || echo "$HOME/go/bin/go-winres")"

echo "==> Collecting the window and engine files"
rm -rf "$WEBUI" && mkdir -p "$WEBUI/vendor/vision" "$WEBUI/data" "$OUT"
cp "$REPO/windows/ui/index.html" "$REPO/windows/ui/desktop.js" "$WEBUI/"
cp "$REPO/src/favicon.svg" "$REPO/docs/vendor/companion/qr.js" "$WEBUI/"
cp "$REPO/macos/engine/engine.js" "$REPO/src/visual-client.js" "$REPO/src/visual-tracker.js" "$REPO/src/minimap-position.js" "$REPO/src/quest-helper.js" "$WEBUI/"
cp -R "$REPO/macos/engine/ocr" "$WEBUI/ocr"
cp "$REPO/docs/vision-worker.js" "$REPO/docs/visual-matcher.js" "$WEBUI/"
cp "$REPO/docs/vendor/vision/opencv.js" "$REPO/docs/vendor/vision/LICENSE" "$WEBUI/vendor/vision/"
cp "$REPO/docs/data/visual-index.json" "$WEBUI/data/"
BIN="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['data'][2:])" "$REPO/docs/data/visual-index.json")"
cp "$REPO/docs/$BIN" "$WEBUI/$BIN"
python3 - "$REPO/data/world.json" "$WEBUI/data/portal-marks.json" <<'PY'
import json, sys
world = json.load(open(sys.argv[1]))
marks = {str(m["id"]): [[float(p["x"]), float(p["y"])] for p in m.get("portals", [])
         if int(p.get("type", 0)) == 2 and p.get("x") is not None and p.get("y") is not None]
         for m in world["maps"]}
json.dump({k: v for k, v in marks.items() if v}, open(sys.argv[2], "w"), separators=(",", ":"))
PY

echo "==> App icon and version"
mkdir -p "$OUT/installer"
python3 - "$REPO/src/icons/icon-512.png" "$OUT/installer" <<'PY'
import sys
from PIL import Image
icon = Image.open(sys.argv[1]).convert("RGBA")
icon.save(sys.argv[2] + "/icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
icon.resize((256, 256), Image.LANCZOS).save(sys.argv[2] + "/icon-256.png")
PY
(cd "$LINK" && "$WINRES" simply --arch amd64 --icon "$OUT/installer/icon-256.png" --manifest gui \
  --product-name "Maple Atlas Companion" --file-description "Maple Atlas Companion" \
  --product-version "$VERSION" --file-version "$VERSION" --original-filename MapleAtlasCompanion.exe \
  --copyright "Maple Atlas contributors" --out rsrc)

echo "==> Compiling MapleAtlasCompanion.exe (windows/amd64)"
(cd "$LINK" && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -tags desktopui -trimpath \
  -ldflags "-s -w -H=windowsgui -X main.version=$VERSION" -o "$OUT/MapleAtlasCompanion.exe" .)

rm -f "$LINK"/rsrc_windows_*.syso

echo "==> Building the setup program"
(cd "$REPO/windows" && LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 makensis -V2 -DVERSION="$VERSION" installer.nsi)
rm -f "$OUT/MapleAtlasCompanion-windows-x64.zip" "$OUT/README.txt"
ls -la "$OUT"
