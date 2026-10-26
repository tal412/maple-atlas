#!/usr/bin/env bash
# Builds macos/build/Maple Atlas Companion.app (Swift app + maple-link helper + engine assets).
set -euo pipefail

MACOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$MACOS_DIR/.." && pwd)"
APP_NAME="Maple Atlas Companion"
BUNDLE_ID="io.github.tal412.maple-atlas-companion"
APP="$MACOS_DIR/build/$APP_NAME.app"
CONTENTS="$APP/Contents"
ENGINE="$CONTENTS/Resources/engine"

warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
step() { printf '\033[1m==>\033[0m %s\n' "$*"; }

step "Building Swift app"
# Universal (Apple silicon and Intel) unless ARCHS says otherwise.
ARCHS="${ARCHS:-arm64 x86_64}"
VERSION="${VERSION:-0.3.3}"
SWIFT_ARCHS=(); for a in $ARCHS; do SWIFT_ARCHS+=(--arch "$a"); done
(cd "$MACOS_DIR/App" && swift build -c release "${SWIFT_ARCHS[@]}")
BIN_DIR="$(cd "$MACOS_DIR/App" && swift build -c release "${SWIFT_ARCHS[@]}" --show-bin-path)"

step "Assembling $APP"
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$ENGINE/vendor/vision" "$ENGINE/data"
cp "$BIN_DIR/MapleAtlasCompanion" "$CONTENTS/MacOS/$APP_NAME"

if [[ -n "${MAPLE_LINK_BIN:-}" ]]; then
  # Testing hook: bundle a prebuilt (or stand-in) helper instead of building macos/link.
  step "Using prebuilt helper $MAPLE_LINK_BIN"
  cp "$MAPLE_LINK_BIN" "$CONTENTS/MacOS/maple-link"
  chmod +x "$CONTENTS/MacOS/maple-link"
elif command -v go >/dev/null 2>&1 && [[ -f "$MACOS_DIR/link/go.mod" ]]; then
  step "Building maple-link helper"
  LINK_PARTS=()
  for a in $ARCHS; do
    goarch="$a"; [[ "$a" == x86_64 ]] && goarch=amd64
    (cd "$MACOS_DIR/link" && GOOS=darwin GOARCH="$goarch" CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$MACOS_DIR/build/maple-link-$a" .)
    LINK_PARTS+=("$MACOS_DIR/build/maple-link-$a")
  done
  lipo -create "${LINK_PARTS[@]}" -output "$CONTENTS/MacOS/maple-link"
  rm -f "${LINK_PARTS[@]}"
else
  warn "maple-link not built (needs 'go' on PATH and macos/link/go.mod); the app can't pair with a phone without it."
fi

step "App icon"
ICONSET="$MACOS_DIR/build/AppIcon.iconset"
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size "$REPO/src/icons/icon-512.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2)); [[ $double -le 512 ]] && sips -z $double $double "$REPO/src/icons/icon-512.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
cp "$REPO/src/icons/icon-512.png" "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns"
rm -rf "$ICONSET"

step "Copying engine assets"
copy() { # copy <source relative to repo> <destination relative to engine dir>
  local src="$REPO/$1" dest="$ENGINE/$2"
  [[ -f "$src" ]] || { echo "error: missing $1" >&2; exit 1; }
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
}
if [[ -f "$MACOS_DIR/engine/engine.html" ]]; then
  copy macos/engine/engine.html engine.html
else
  warn "macos/engine/engine.html not found; the engine page is missing from the bundle."
fi
copy src/visual-client.js visual-client.js
copy src/visual-tracker.js visual-tracker.js
copy docs/vision-worker.js vision-worker.js
copy docs/visual-matcher.js visual-matcher.js
copy docs/vendor/vision/opencv.js vendor/vision/opencv.js
copy docs/vendor/vision/LICENSE vendor/vision/LICENSE
copy docs/data/visual-index.json data/visual-index.json
INDEX_JSON="$REPO/docs/data/visual-index.json"
INDEX_BIN="$(/usr/bin/plutil -extract data raw -o - "$INDEX_JSON" 2>/dev/null \
  || sed -n 's/^{[^{]*"data"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INDEX_JSON")"
INDEX_BIN="${INDEX_BIN#./}"
[[ "$INDEX_BIN" == data/*.bin ]] || { echo "error: unexpected data field in visual-index.json: $INDEX_BIN" >&2; exit 1; }
copy "docs/$INDEX_BIN" "$INDEX_BIN"
copy src/minimap-position.js minimap-position.js
copy macos/engine/engine.js engine.js
copy src/quest-helper.js quest-helper.js
# On-device text recognition for the Quest Helper panel (Apache-2.0).
for f in tesseract.min.js worker.min.js tesseract-core-simd-lstm.wasm.js LICENSE lang/eng.traineddata.gz; do copy "macos/engine/ocr/$f" "ocr/$f"; done
# Visible portal positions per map, for placing the player dot (see src/minimap-position.js).
/usr/bin/python3 - "$REPO/data/world.json" "$ENGINE/data/portal-marks.json" <<'PY'
import json, sys
world = json.load(open(sys.argv[1]))
marks = {}
for m in world["maps"]:
    points = [[float(p["x"]), float(p["y"])] for p in m.get("portals", [])
              if int(p.get("type", 0)) == 2 and p.get("x") is not None and p.get("y") is not None]
    if points:
        marks[str(m["id"])] = points
json.dump(marks, open(sys.argv[2], "w"), separators=(",", ":"))
PY

step "Writing Info.plist"
cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.games</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSLocalNetworkUsageDescription</key>
  <string>Maple Atlas connects directly to your phone on this Wi-Fi network. Nothing is sent to the internet.</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
/usr/bin/plutil -lint "$CONTENTS/Info.plist" >/dev/null

step "Signing (ad hoc)"
# An ad-hoc signature's default requirement is its cdhash, so every rebuild would lose the
# Screen Recording grant. Pinning the requirement to the identifier keeps the grant.
if [[ -f "$CONTENTS/MacOS/maple-link" ]]; then
  codesign --force --sign - --identifier "$BUNDLE_ID.link" \
    -r="designated => identifier \"$BUNDLE_ID.link\"" "$CONTENTS/MacOS/maple-link"
fi
codesign --force --sign - -r="designated => identifier \"$BUNDLE_ID\"" "$APP"
codesign --verify --deep --strict "$APP"

step "Built $APP"
