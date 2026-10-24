# Maple Atlas Companion for Mac

A native macOS app that replaces the browser on the computer side of the live companion. It captures the game window, recognizes the current map with the same matcher as the website, and sends the map ID to your phone. Pairing takes **one scan**: point the phone's camera at the QR in the app. No camera is needed on the Mac, and nothing is sent to the internet.

## Build and run

Requires macOS 14 or newer, Xcode (or the Command Line Tools with Swift 6) and Go 1.22+ (`brew install go`).

```sh
bash macos/build.sh
open "macos/build/Maple Atlas Companion.app"
```

First launch asks for:

- **Local Network** — to accept the phone's connection on your Wi-Fi.
- **Screen & System Audio Recording** — to read the game window. Grant it in System Settings › Privacy & Security, then reopen the app. Ad-hoc builds are re-signed on every build, so macOS may ask again after rebuilding.

The phone uses the website (`/dev/` by default; switch to Main in Settings). The site must include the single-scan pairing code, so deploy the web changes before using a new protocol.

## How it works

```
Phone (website)  ──WebRTC data channel, same Wi-Fi──>  maple-link (Go, Pion)
                                                          │ stdin/stdout JSON
Game window ──ScreenCaptureKit──> Swift app ──frames──> hidden WKWebView
                                                          (engine.html: OpenCV ORB matcher, local index)
```

- **`App/`** — SwiftUI app: pairing QR and status, game-window picker, 1.5 s capture loop, and the hidden web view that runs `engine.html`. Frames stay in memory on the Mac; only map IDs are sent.
- **`link/`** — `maple-link` helper. Runs a WebRTC peer in ICE-lite mode on one UDP port, serves the engine files on `127.0.0.1`, and speaks the same data-channel protocol as the browser computer role in `src/companion-link.js`.
- **`engine/engine.html`** — wraps the website's `visual-client.js`, `vision-worker.js`, `visual-matcher.js` and `visual-tracker.js` unchanged. `build.sh` copies them and the visual index into the app.

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
