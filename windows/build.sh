#!/usr/bin/env bash
# Builds windows/build/MapleAtlasCompanion-windows-x64.zip: one MapleAtlasCompanion.exe
# (pairing helper + companion window + matcher, all embedded) and a short README.
# Cross-compiles from macOS or Linux; needs Go 1.22+.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINK="$REPO/macos/link"
WEBUI="$LINK/webui"
OUT="$REPO/windows/build"

echo "==> Collecting the window and engine files"
rm -rf "$WEBUI" && mkdir -p "$WEBUI/vendor/vision" "$WEBUI/data" "$OUT"
cp "$REPO/windows/ui/index.html" "$REPO/windows/ui/desktop.js" "$WEBUI/"
cp "$REPO/src/favicon.svg" "$REPO/docs/vendor/companion/qr.js" "$WEBUI/"
cp "$REPO/macos/engine/engine.js" "$REPO/src/visual-client.js" "$REPO/src/visual-tracker.js" "$REPO/src/minimap-position.js" "$WEBUI/"
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

echo "==> Compiling MapleAtlasCompanion.exe (windows/amd64)"
(cd "$LINK" && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -tags desktopui -trimpath \
  -ldflags "-s -w -H=windowsgui" -o "$OUT/MapleAtlasCompanion.exe" .)

cat > "$OUT/README.txt" <<'TXT'
Maple Atlas Companion for Windows
=================================

Follow your MapleStory Classic World game on your phone. Everything stays on your
Wi-Fi: no account, no server, nothing sent to the internet.

1. Double-click MapleAtlasCompanion.exe. Windows may warn that the app is from an
   unknown publisher (it is not code-signed yet): choose "More info" > "Run anyway".
2. When Windows Defender Firewall asks, allow it on PRIVATE networks. Your phone
   connects to this PC over your Wi-Fi.
3. A Maple Atlas Companion window opens (in Microsoft Edge). Scan its QR code with
   your phone's camera. After the first scan the phone stays paired.
4. Click "Choose game window...", pick MapleStory, drag the box over the minimap if
   needed, then "Start tracking".

Close the companion window to quit. Settings and the pairing are kept in
%APPDATA%\Maple Atlas Companion. Source: https://github.com/tal412/maple-atlas
TXT

rm -f "$OUT/MapleAtlasCompanion-windows-x64.zip"
(cd "$OUT" && zip -q -9 MapleAtlasCompanion-windows-x64.zip MapleAtlasCompanion.exe README.txt)
ls -la "$OUT"
