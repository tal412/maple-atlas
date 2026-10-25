#!/usr/bin/env bash
# Builds macos/build/MapleAtlasCompanion-mac.dmg: the universal app in a disk image with
# an Applications shortcut, so installing is drag and drop.
set -euo pipefail
MACOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$MACOS_DIR/build.sh"
APP="$MACOS_DIR/build/Maple Atlas Companion.app"
DMG="$MACOS_DIR/build/MapleAtlasCompanion-mac.dmg"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Maple Atlas Companion" -srcfolder "$STAGE" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$DMG" >/dev/null
echo "Built $DMG ($(du -h "$DMG" | cut -f1))"
