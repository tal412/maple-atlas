# Browser dependencies

These pinned dependencies are served from the same origin as Maple Atlas.
Visual recognition runs locally. No hosted inference, signaling, STUN or TURN service is used.

| Component | Version | Upstream | License |
| --- | --- | --- | --- |
| OpenCV.js | @techstark/opencv-js 4.12.0-release.1 (OpenCV 4.12.0) | https://github.com/TechStark/opencv-js, built from https://docs.opencv.org/4.12.0/opencv.js | Apache-2.0, vision/LICENSE |
| node-qrcode | 1.5.4 | https://github.com/soldair/node-qrcode | MIT, companion/qrcode.LICENSE |
| jsQR | 1.4.0 | https://github.com/cozmo/jsQR | Apache-2.0, companion/jsqr.LICENSE |
| Lucide | 1.17.0 | https://github.com/lucide-icons/lucide | ISC, lucide.LICENSE |
| Roboto variable, Latin | @fontsource-variable/roboto 5.2.8 | https://github.com/fontsource/fontsource | SIL OFL, roboto.LICENSE |

To reproduce: `npm ci --ignore-scripts && npm run vendor`. The lockfile pins
transitive dependencies. `scripts/vendor-companion.cjs` bundles the QR utilities
and copies the upstream OpenCV browser/WebAssembly build, icons, font and licenses.
`companion/versions.json` records versions and file hashes. Regular Python site
builds require no npm install. There are no neural-model weights or OCR runtime.

Map and minimap artwork belongs to Nexon. Its source revision and each Git blob
hash are recorded in `data/visual-sources.json`. The visual index contains ORB
binary landmark descriptors and coordinates derived from those pinned images.
The public regression fixtures are derived from those same game references;
user-provided photographs are not included in the repository or deployment.
