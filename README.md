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

Game sprites and local map images come from a pinned [OSMS data repository](https://github.com/ohmi69/osms_datamine_dashboard) snapshot. Map images load from this site first, using immutable source-hash filenames; the original image CDN is a fallback. Requests have bounded timeouts, failures hide the broken image, and the full-map viewer offers an explicit retry. `python3 scripts/vendor-map-images.py` restores missing or changed assets and verifies their Git blob hashes. Builds require no image download. Roboto and Lucide are self-hosted. Game sprites can still require their source CDN; market and item-detail refreshes require internet. The atlas illustration and route geometry are included in the source.

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

The live companion follows your game on your phone. **Maple Atlas Companion** runs on the computer with the game (macOS: see [macos/README.md](macos/README.md); Windows: `windows/build.sh` builds `MapleAtlasCompanion.exe`). It reads the in-game minimap and sends the map you're on and your position to the phone. On a computer browser, **Live companion** points to these apps.

1. Open the companion app. It shows a QR (until a phone is paired).
2. On the phone, scan it with the camera app (it opens the site with the code in the URL fragment), or use **Live companion → Scan the companion's code**. A QR image or the pasted link also works.
3. The phone connects with no second step. It remembers the computer (`localStorage`, per site) and reconnects by itself when Maple Atlas is on screen, or with one tap on **Reconnect** or the status badge. **Forget this computer** removes the pairing; **Pair a new phone** in the app replaces it.
4. In the game, press **+** on the minimap until its map name shows. In the app, choose the game window, put the box around the minimap and its name, and start tracking. The phone shows a gold **You** dot on the local game map and live hints toward the next route portal.

Both devices must be on the same reachable local network. Guest Wi-Fi, VPNs and firewalls can block the link; on Windows, allow the app on private networks. The map name is read every 1.5 s and the dot about five times a second, on the computer only: screenshots never leave it. The link is an encrypted WebRTC data channel with no signaling, STUN or TURN server; the app is an ICE-lite peer, and the phone proves the QR secret over its own DTLS certificate. Pairing codes (`MA2…`) carry the app's ICE credentials, DTLS fingerprint, LAN addresses, session, expiry and secret. The channel carries confirmations, heartbeats, map IDs, positions, tracking status and sequence numbers, never images. The earlier browser-to-browser pairing (two scans) has been removed; its codes are refused.

### Reading the map name

The companion apps read the map name shown at the top of the in-game minimap ("Victoria Road" / "Henesys"): press **+** on the minimap until the name shows, and keep the whole minimap with its name inside the app's box. `src/map-name.js` finds the light-blue name strip, prepares its white letters, and matches the recognized street and map name to the 336 maps in `docs/data/visual-index.json`; text recognition runs on the computer (Tesseract, `macos/engine/ocr`, Apache-2.0), the same reader as the Quest Helper. Maps with the very same name and street (for example the Coconut Harvest copies) are told apart by the map you came from. Reading the map from the minimap picture was removed in 0.3.5.

```sh
node tests/map-name.test.cjs
node tests/minimap-position.test.cjs
node tests/companion-link.test.cjs
node tests/companion-device.test.cjs
node tests/offline.test.cjs
```
