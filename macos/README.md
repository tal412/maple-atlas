# Maple Atlas Companion for Mac

**Download:** [MapleAtlasCompanion-mac.dmg](https://github.com/tal412/maple-atlas/releases/latest/download/MapleAtlasCompanion-mac.dmg) (Apple silicon and Intel, macOS 14+). Open it and drag the app to Applications. Windows: [MapleAtlasCompanion-Setup.exe](https://github.com/tal412/maple-atlas/releases/latest/download/MapleAtlasCompanion-Setup.exe). To build the installers yourself: `macos/package.sh` and `windows/build.sh`.

A native macOS app that replaces the browser on the computer side of the live companion. It captures the game window, reads the map name shown at the top of the in-game minimap, and sends the map ID to your phone. Press **+** on the in-game minimap until its name shows (for example "Victoria Road · Henesys") and keep it inside the app's box. Pairing takes **one scan**: point the phone's camera at the QR in the app. No camera is needed on the Mac, and nothing is sent to the internet.

## Build and run

Requires macOS 14 or newer, Xcode (or the Command Line Tools with Swift 6) and Go 1.22+ (`brew install go`).

```sh
bash macos/build.sh
open "macos/build/Maple Atlas Companion.app"
```

First launch asks for **Local Network** access, so the phone can connect on your Wi-Fi.

**Pair once.** After the first scan the app saves the pairing in `~/Library/Application Support/Maple Atlas Companion/<dev|main>/pairing.json` (mode 600) and the phone saves the code in `localStorage`. From then on the app shows *Paired · waiting for your phone* instead of a QR, and the phone reconnects by itself, or with one tap on **Reconnect**, after switching apps, screen lock, reloads or restarts. The session keeps the same UDP port, ICE username/password and DTLS certificate, so the code the phone holds stays valid; each return opens a new peer connection that again proves the QR secret. **Pair a new phone** replaces the pairing. If the Mac's network address changes, the app shows a new QR.

Click **Choose game window…** and pick the game in macOS's own window picker. Picker capture needs no Screen Recording permission, so there's no prompt to grant. The app never lists windows itself. Pick the window again after each launch. Then drag the box over the in-game minimap (top-left by default). Only that area is matched.

The phone uses the website (Main by default; switch to Dev in Settings). The site must include the single-scan pairing code, so deploy the web changes before using a new protocol.

## Your position and portal guidance

The map name is read every 1.5 s. Between those reads the app locates only your dot, about **5 times a second**, on the confirmed map (a few milliseconds per read), so the phone follows smoothly. On every confirmed map, the engine also finds **your gold dot** and the **teal portal rings** on the minimap. Because Classic World's minimap scrolls with you, it fits the rings to the map's known visible portals (scale and offset), which puts your dot in the same coordinates as the portal data. A learned scale lets one ring suffice once two have been seen. The phone then shows a gold **You** dot on the local game map and, during a route, a live hint toward the next portal, for example "Head right, about one screen, then drop down".

Dot, ring and title colors, the fit and the guidance wording are adapted from [Maple Route](https://github.com/maplerouteadmin-dev/maple-route) (MIT; its notice is in `src/minimap-position.js`). Map identity comes from reading the map name in the minimap's title strip (`src/map-name.js`, on-device text recognition).

## How it works

```
Phone (website)  ──WebRTC data channel, same Wi-Fi──>  maple-link (Go, Pion)
                                                          │ stdin/stdout JSON
Game window ──ScreenCaptureKit──> Swift app ──frames──> hidden WKWebView
                                                          (engine.html: map-name reader, dot finder, Quest Helper reader)
```

- **`App/`** — SwiftUI app: pairing QR and status, the system window picker with a 2 fps ScreenCaptureKit stream, the minimap box, a 1.5 s matching loop, and the hidden web view that runs `engine.html`. Frames stay in memory on the Mac; only map IDs are sent.
- **`link/`** — `maple-link` helper. Runs a WebRTC peer in ICE-lite mode on one UDP port, serves the engine files on `127.0.0.1`, and speaks the same data-channel protocol as the browser computer role in `src/companion-link.js`.
- **`engine/engine.html`** — loads `map-name.js`, `minimap-position.js`, `quest-helper.js`, the on-device text reader (`ocr/`) and `engine.js`. `build.sh` copies them and writes the map list (`data/map-names.json`) into the app.

### Why one scan is enough

Browser-to-browser WebRTC needs each side to receive the other's description, which is why the browser flow needs a second scan back to the computer. A native peer avoids that:

1. The QR is a link: `https://…/maple-atlas/dev/#link=MA2…`. The `MA2` code carries the Mac's ICE username and password, DTLS fingerprint, LAN address and port, a session ID, expiry and a 16-byte secret. It is in the URL fragment, which browsers never send to the web server. The page removes it from the address bar on open.
2. The phone connects to the Mac's address. Every ICE check carries the phone's ICE username. The helper reads it from the first check whose MESSAGE-INTEGRITY verifies with the Mac's password, which only the QR contains, and completes the session. As an ICE-lite agent it only answers checks, so it never needs the phone's password.
3. The phone's DTLS certificate cannot be known in advance, so fingerprint checking is turned off on the Mac. Instead, the phone's first message is `auth`: `HMAC-SHA256(secret, "maple-atlas-link|" + session + "|" + phone fingerprint)`. The helper recomputes it with the certificate actually used in the handshake. A device without the QR cannot produce it, and a relay cannot reuse it.
4. After that, both sides run the usual hello/acknowledgement, heartbeat, location and tracking messages. `bye` ends a session cleanly.

Each code works once and expires after 10 minutes. Both devices must be on the same reachable network; guest Wi-Fi, client isolation, VPNs and firewalls can still block the link.

## Tests

```sh
(cd macos/link && go test ./...)
node tests/companion-link.test.cjs
```

The Go and JavaScript tests share a golden pairing code so the two encoders stay byte-compatible.
