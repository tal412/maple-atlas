# Maple Atlas

A map-first Classic World companion with an original illustrated atlas, recorded portal routes, NPC and monster details, real game sprites, and manual quest progress.

## Build and preview

Requires Python 3.10 or newer; no package installation or API keys.

```sh
python3 scripts/build.py
python3 -m http.server 8000 --directory docs
```

Open `http://localhost:8000`. GitHub Actions builds and publishes both branches to GitHub Pages. The application fills the browser directly, with no embedded preview frame. The project plan lives at `docs/plan.html`.

## Source layout

- `src/template.html`: application markup and world insertion point.
- `src/app.css`, `src/fullscreen.css`, `src/mobile.css`: interface and browser sizing.
- `src/storage.js`: IndexedDB persistence, migration and save error handling.
- `src/local-maps.js`: readable directions and zoomable original game-map viewer.
- `src/map-images.js`: first-party map image loading, fallback, timeouts and retry.
- `data/map-assets.json`: pinned source hashes for the 464 hosted map assets.
- `src/map-labels.js`: stable label placement during map motion.
- `src/map-gestures.js`: one-finger pan and anchored pinch zoom.
- `src/search-index.js`, `src/search-data.js`, `src/search-ui.js`: indexed universal search, versioned IndexedDB catalog cache and entity details.
- `data/search-catalog.json`: 9,355 records from hash-checked pinned game exports.
- `scripts/catalog.py`: optional catalog regeneration from `research/osms/`; regular builds use the committed snapshot.
- `data/market-sources.json`: pricing-source investigation and value semantics.
- `src/quest-flow.js`: one next quest per NPC, recorded prerequisites and journal handoffs.
- `data/night-palette.json`: system dark-mode colors for the original illustrated map.
- `src/favicon.svg`: original maple-leaf map pin icon.
- `src/runtime.js`: interactions, routing, map positioning and progress.
- `src/world.svg`: original vector map illustration.
- `data/world.json`: portable map, portal, quest, atlas-position and sprite snapshot.
- `data/provenance.json`: snapshot and external sprite-source provenance.
- `docs/index.html`: generated standalone application; rebuild after source changes.

## Main and dev

- **Main:** https://tal412.github.io/maple-atlas/ — built from `main`.
- **Dev preview:** https://tal412.github.io/maple-atlas/dev/ — built from `dev`.

Work on `dev`, commit source changes, then run `python3 scripts/deploy.py`. This pushes the current branch and explicitly starts GitHub Actions. The Pages workflow validates both branches and publishes them together, keeping the root site on the `main` revision. To release tested work, merge `dev` into `main` and run the same command from `main`. A failed check prevents publishing. Both URLs expose `version.json` with their branch and commit.

The workflow also listens for pushes to `main` and `dev`. During initial setup GitHub did not start runs from pushes, while explicit workflow dispatch succeeded; the deploy helper provides a verified publishing path without depending on that trigger. It requires the authenticated GitHub CLI (`gh`).

To republish the current branches without another commit, run `gh workflow run pages.yml --ref main`, or use **Run workflow** on the repository's Actions page. The deployment never merges development changes into the stable branch.

```sh
git switch dev
python3 scripts/build.py
python3 scripts/validate.py
node tests/map-labels.test.cjs
node tests/local-maps.test.cjs
node tests/storage.test.cjs
node tests/map-gestures.test.cjs
node tests/quest-flow.test.cjs
node tests/map-images.test.cjs
# After committing your changes:
python3 scripts/deploy.py
# Review /dev/ before releasing:
git switch main
git merge --ff-only dev
python3 scripts/deploy.py
git switch dev
```

For a local development-channel build, use `python3 scripts/build.py --channel dev`. Main uses the existing `maple-atlas` IndexedDB database; dev uses `maple-atlas-dev`, so preview testing does not change main progress. Research, local mobile QA pages and backend drafts are ignored and never published.

## Mobile and appearance

On phones, the map opens with a compact search bar, discovery chips and a collapsed bottom sheet. Search for any game entity, tap a map marker, or open Directions to choose a start and destination. The bottom navigation opens Explore, Directions or your quest journal; character level is inside the profile button. Pan with one finger and pinch to zoom. The interface and original atlas artwork automatically follow device light/dark appearance, including changes while the app is open. Original game images retain their source colors.

## Universal search

The desktop search button and mobile search bar share a catalog of 348 locations, 118 monster names, 301 NPCs, 343 quests, 7,786 items, 366 recipes, and 93 unique skills. 246 maps have route coverage. Item coverage is the union of the pinned OSMS names, item and cash-shop exports, plus the complete public MapleStory.io MCW/1 item listing (7,432 entries). The API listing snapshot is committed in `data/mcw-items.json` with its URL, date, region, version and raw-response hash. Historical names remain search aliases; distinct IDs are never merged by name.

Search supports category filters, exact IDs, name prefixes, plurals, small spelling mistakes/transpositions, and aliases such as `wg` for Work Gloves. Examples: `snial`, `where can I find snails`, `hennesys`, `gloves attack 60`, and `work gloves worth`. Names rank above related locations, objective/reward names and description matches. The index uses inverted token postings, prefixes, deletion candidates and trigrams with bounded edit distance, built once per page. Typing queries stays on the device.

The 2.8 MB catalog downloads only when search opens, from a same-origin content-hashed static JSON file. IndexedDB retains the current version for subsequent searches/reloads, with separate main/dev caches. A failed cache or storage quota does not disable search. Network failures offer retry; a cached older edition is never presented as the current catalog. The app remains backend-free. The catalog cache is separate from character progress.

Search results link to entity details, recorded locations, quests, requirements, rewards, and crafting ingredients. NPC details show one next quest; explicit quest searches can inspect any recorded quest without changing the recommended sequence. Quest item lists start collapsed. Maps outside route coverage stay searchable without invented coordinates. Item drops and NPC shop inventories are not inferred from historical MapleStory tables.

Opening an item fetches its exact MCW/1 record from [MapleStory.io](https://maplestory.io/api/MCW/1/item/1067027). Only whitelisted metadata is cached in a separate main/dev IndexedDB store; bulky animation frames are discarded. Results stay fresh for 24 hours, requests are deduplicated, failures preserve the static catalog and allow retry, and cached older details are labeled when used offline. No GMS or other-game fallback is used. API names and statistics describe client records, not proof of current acquisition or live shop stock.

Item worth distinguishes **NPC sell values**, **NX cash-shop snapshot prices** and **player-market prices**. Cash-shop zeroes are never shown as free; missing sell values are never invented. The [MapleStory Classic market page](https://maplestory-classic.com/market) publishes a [developer JSON export](https://maplestory-classic.com/market.json), integrated without an API key. It has name-based market records, not game item IDs. Exact current names are matched; duplicate-name variants carry an explicit warning and are never presented as a verified ID-specific price. Sales, asking prices and per-set units remain separate.

The browser downloads `./data/market.json` in the background on every page entry, when an item opens, and every 60 seconds while that item remains visible. A manual refresh button, tab return, browser-back restoration and reconnect also recheck it. Hidden tabs and closed item views stop polling. IndexedDB provides an immediate saved copy in separate main/dev caches; failed or older downloads never replace newer data. The original source date and last check time are separate, and updates preserve scroll position and expanded details.

GitHub Actions refreshes this same-origin mirror on every deployment and daily at **07:23 UTC** (scheduled runs may be delayed). The provider does not currently permit cross-origin browser reads, so the static site cannot fetch directly on each visit. Browser rechecks find the latest published mirror; they do not force the external provider to update. No runtime backend or private key is needed. `python3 scripts/market.py --refresh` validates the published fallback and upstream export, rejecting malformed data or a backwards timestamp. Failures retain the last valid snapshot, with its date unchanged. The source does not guarantee a daily cadence. Test with `python3 -m unittest discover -s tests -p '*_test.py'` and `node tests/market-data.test.cjs`.

Other market providers remain external links: [MapleStory Market](https://maplestory.market/account) offers administrator-approved API keys; none is provisioned here. NiaMeowDB, MesoWatch and HubCW require permission for automated reuse. Provenance and value semantics are recorded in `data/market-sources.json`.

Run `node tests/search.test.cjs` for ranking, category/relationship/value checks, cache versioning, storage/network failures and a query timing check. Rebuild after catalog changes; `scripts/build.py` writes the matching content-hashed public bundle. `scripts/catalog.py` regenerates the committed catalog only when the pinned raw research exports and repository tree are available; it rejects changed source hashes.

## Data and behavior

The map uses a reviewed Classic World data snapshot. Atlas positions, map contents and recorded portal links are distinct datasets; a map without a reviewed atlas position is not placed at its return town. Routes depend on the recorded graph and do not promise support for every scripted portal, taxi, ship, scroll or eligibility condition.

Location can be entered manually or received from the optional visual companion. Quest progress is entered manually. Progress is stored in this browser's IndexedDB database, with no account or server synchronization. Clearing browser data removes that progress. Quest cards start collapsed; expand one to see requirements, rewards and progress controls. Only one next quest per NPC appears in the journal and place lists. Recorded quest prerequisites must be marked completed before later steps appear; skipping does not satisfy them. Active quests take priority, followed by level-appropriate continuations, with level and ID providing a stable order for independent quests. The journal follows unlocked handoffs to other NPCs. Completed/skipped quests stay in collapsed history so their status can be corrected. Quest associations and level checks do not validate every in-game prerequisite.

Every one of the 246 location records includes a full-resolution game map, with 218 minimaps for lightweight previews. All 464 exact image files are hosted alongside the app in `docs/assets/`. Preview PNGs total about 3.9 MB across the entire catalog; only the selected preview and visible/nearby route previews load. Maps without a minimap show an open-map button without downloading a full image for the card. Open a local map from a place or route step; choose an exit, zoom, fit the map or focus the recorded portal. Portal overlays use the source image pixel coordinates and never invent an internal walking path. Full-resolution images load on demand. Their dimensions and all 457 portal coordinates are checked in `data/map-image-audit.json`.

Game sprites and local map images come from a pinned [OSMS data repository](https://github.com/ohmi69/osms_datamine_dashboard) snapshot. Map images load from this site first, using immutable source-hash filenames; the original image CDN is a fallback. Requests have bounded timeouts, failures hide the broken image, and the full-map viewer offers an explicit retry. `python3 scripts/vendor-map-images.py` restores missing or changed assets and verifies their Git blob hashes. Builds require no image download. Roboto, Lucide and the visual matcher are self-hosted. Game sprites can still require their source CDN; market and item-detail refreshes require internet. The atlas illustration and route geometry are included in the source.

## Verify a change

```sh
python3 scripts/build.py
python3 scripts/validate.py
node --check src/runtime.js
node --check src/storage.js
node tests/map-labels.test.cjs
node tests/local-maps.test.cjs
node tests/storage.test.cjs
node tests/map-gestures.test.cjs
node tests/quest-flow.test.cjs
node tests/map-images.test.cjs
```

The validator checks all 457 included directed portal pairs against the pinned source audit, road/route endpoint agreement, known routes and sprite coverage. The illustrated atlas has 64 published community anchors and three clearly marked schematic forest points; 179 other map records remain available through search and connections without invented map coordinates. Portal activation conditions and complete transport coverage still require in-game verification.


## Visual location companion

Open Live companion from **Connect phone** on a computer, or the phone button next to your profile in the top bar on a phone (its dot shows the connection: green connected, amber connecting, grey Mac away).

**On a Mac, use Maple Atlas Companion** (`macos/`, see [macos/README.md](macos/README.md)). It captures the game window natively and pairs with **one scan**: point the phone's camera at the app's QR and the phone connects. No camera is needed on the Mac. The browser flow below remains for other computers. It also finds your dot on the minimap, so the phone shows where you are on the local game map and which way to walk to the next route portal (adapted from [Maple Route](https://github.com/maplerouteadmin-dev/maple-route), MIT).

1. The app detects the device role. Computers (including Macs) only create pairing codes and share the game window. Phones/tablets only receive the connection. Role detection uses mobile client hints and platform signals, including iPad desktop mode; it does not use viewport width. Screen-sharing support is checked separately. Browser identity can be spoofed, so this is interface guidance, not authentication. See [mobile browser signals](https://developer.mozilla.org/en-US/docs/Web/API/NavigatorUAData/mobile) and [screen-capture support](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).
2. Computer: **Create computer code** (allow the camera; it opens first so the browser shares this computer's local address and is ready to read the phone's response). Phone: **Connect to computer → Scan computer code**.
3. The phone explicitly shows **Code scanned · One more step** and a new response QR. Hold it up to the computer's camera, which is already scanning. This second scan is required. A computer without a camera can use a QR image or pasted response.
4. Both pages show **Connecting**, then **Verifying both devices**. **Connected** appears only after a two-way application confirmation. The phone keeps the success screen open until **View map** is pressed. A phone waiting for its response to be scanned can choose **The computer scanned this response** to start a bounded connection check; that button does not claim success.
5. Computer: **Share game window → Start visual tracking**. Sharing controls stay hidden until the connection is verified. Two consistent strong observations, or enough new landmarks across partial views, confirm a map. The phone follows a recognized location; outside route coverage, it opens the original local map.
6. Connection and tracking are separate states. A healthy link can show **Waiting for screen sharing**, **Finding your map**, **Tracking live** or **Tracking paused**. Heartbeat acknowledgements detect interruption and failed connections even when no game map is being detected. Code expiry, timeout, version mismatch and disconnection have explicit messages and a new-pairing action.

Both devices must be on the same reachable local network. A phone on cellular data or a computer on a different network cannot use this relay-free mode. Keep both pages open. **Disconnect**, closing/reloading, or a failed connection ends a browser-to-browser session and stops capture. Refresh both devices after pairing protocol updates.

**With the Mac app, pair once.** The phone keeps the Mac's pairing code in this site's `localStorage` (separately for Main and Dev), and the app keeps its pairing identity (secret, ICE credentials, DTLS certificate, UDP port) in `~/Library/Application Support/Maple Atlas Companion/`, readable only by your account. Switching apps, screen lock, a reload or either side restarting only pauses the link: the phone reconnects by itself when Maple Atlas is on screen again, or with one tap on **Reconnect** (or the status badge) after a deliberate disconnect or when the Mac app was closed. **Forget this Mac** on the phone, or **Pair a new phone** on the Mac, removes the pairing. If the Mac's Wi-Fi address changes, scan once more (a DHCP reservation avoids this). While connected and on screen, the phone keeps its screen awake. **Your character → Full screen** hides the browser bars, as does **View map** after pairing; adding the site to the Home screen opens it as a full-screen app.

Screenshot/photo recognition tests are developer tooling only. The public app has no minimap-test uploader. Use the local benchmark commands below for private image checks.

The source inventory has 336 maps with images, 335 with usable landmarks, and 12 additional catalog names with no image reference. White Room has no distinctive landmarks. The index contains both minimap and full-scene descriptors. It identifies map IDs; it does not yet track the exact player dot, verify quest completion, or read account data. Repeated event maps can be visually indistinguishable. The reader keeps those uncertain. Full-scene recognition depends on reference coverage, scale and visible landmarks; use the minimap when scenery is insufficient.

The pipeline uses ORB binary descriptors with their reference coordinates, a local locality-sensitive search index, Hamming-distance matching, a RANSAC geometric check, separation from competing maps, and a short in-memory observation history. Repeated ambiguous frames cannot manufacture confidence. A second image scale is checked when necessary. OpenCV executes in a dedicated Web Worker; one frame is analyzed at a time. No OCR, cloud AI, account login, extension, game-memory access or simulated game inputs are used. This is an independent fan tool, not approved by Nexon; it cannot promise ban-free use.

The first visual download is about 43 MB. In **Connection help & offline use**, **Download offline essentials** saves the application, search catalog, QR tools, visual vectors and matching runtime in this browser's Cache Storage. Existing browser IndexedDB stores quest progress and dated market records. Screenshots and visual observations are never written to either store; browser-to-browser session identifiers and WebRTC keys are never stored, and a Mac app pairing code is kept only as described above. Pairing uses an encrypted WebRTC data channel with `iceServers: []`; the QR/manual exchange supplies the offer/answer and host candidates. Codes (`MA2…`) carry only the ICE username and password, the DTLS SHA-256 fingerprint, session, expiry and up to four direct UDP host addresses (IPv4 first, then IPv6 or private `.local` names) as uppercase base32. The receiver rebuilds a minimal data-channel SDP, so a typical code is about 140 characters (a 41×41 QR) instead of a compressed full SDP (about 660 characters, 97×97). Browsers only reveal a device's local IP address after camera or microphone permission; otherwise they advertise a random `.local` mDNS name that many phones, routers and macOS Local Network settings cannot resolve, which leaves ICE with no reachable pair. The computer therefore opens its camera before gathering, and the phone keeps its scanning camera open until its response is gathered. Without a camera the page warns that it is only sharing a private name. Chrome withholds the address and username fragment of incoming peer-reflexive candidates, and plans to reject edited ICE credentials, so a one-way (single-scan) exchange is not used. The channel carries session confirmations, heartbeats, map IDs, a geometric match ratio, status, sequence numbers and timestamps. It never carries screen images or video. Both pages must remain open on the same reachable local network. Guest isolation, firewalls, VPNs, browser restrictions, screen lock and background suspension can prevent or interrupt the connection. No relay fallback is configured.

### Rebuilding and checking the visual index

Normal builds use committed artifacts. To regenerate dependencies, run `npm ci --ignore-scripts && npm run vendor`. To rebuild map descriptors:

```sh
python3 -m venv .openai/vision-env
.openai/vision-env/bin/pip install -r scripts/requirements-vision.txt
.openai/vision-env/bin/python scripts/visual-index.py --download
python3 scripts/build.py --channel dev
node tests/visual-matcher.test.cjs
node tests/visual-tracker.test.cjs
node tests/companion-link.test.cjs
node tests/companion-device.test.cjs
node tests/offline.test.cjs
```

`data/visual-sources.json` pins every source image to the OSMS export commit and Git blob hash. `scripts/visual-index.py --sources` regenerates that inventory only when the pinned raw export is present in the ignored research directory. The binary index has a content-hashed filename, byte length and SHA-256 checked by the worker before use. The uploaded photograph used during development stays outside the published files.

The October 24, 2026 test run used the same matcher as the browser worker:

| Input | Confidently correct | Uncertain/rejected | Confidently wrong |
| --- | ---: | ---: | ---: |
| 336 cropped reference views | 288 | 48 | 0 |
| 8 cropped full game scenes | 7 | 1 | 0 |
| 1 real monitor photo, tested whole and in four crops | 5 | 0 | 0 |
| Wall-only crop, solid image, random noise | 0 | 3 | 0 |

These are controlled reference-image tests plus one real photo, not a measured accuracy rate across live gameplay. Similar Free Market rooms account for many uncertain results. The supplied photo of Construction Site North of Kerning City also passed in the actual browser UI with 203 geometrically aligned landmarks. Map titles were not read. Walking, moving overlays, different game settings and device performance still need real-play testing.

Reproduce the public-image benchmark with the pinned Python environment above:

```sh
.openai/vision-env/bin/python scripts/benchmark-vision.py
node scripts/benchmark-vision.cjs
```

It prepares 336 map crops, eight scene crops and two negative images, and writes the results under ignored `.openai/vision-benchmark/`. Use `--photo /path/to/photo.jpg --expected MAP_ID` to add a private image locally. The standard test suite also checks vector integrity, three representative image cases, temporal confirmation, stale-location handling, data-channel validation and offline cache behavior.
