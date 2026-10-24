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
- `src/app.css`, `src/fullscreen.css`: interface and browser sizing.
- `src/storage.js`: IndexedDB persistence, migration and save error handling.
- `src/local-maps.js`: readable directions and zoomable original game-map viewer.
- `src/map-labels.js`: stable label placement during map motion.
- `src/favicon.svg`: original maple-leaf map pin icon.
- `src/runtime.js`: interactions, routing, map positioning and progress.
- `src/world.svg`: original vector map illustration.
- `data/world.json`: portable map, portal, quest, atlas-position and sprite snapshot.
- `data/provenance.json`: snapshot and external sprite-source provenance.
- `docs/index.html`: generated standalone application; rebuild after source changes.

## Main and dev

- **Main:** https://tal412.github.io/maple-atlas/ — built from `main`.
- **Dev preview:** https://tal412.github.io/maple-atlas/dev/ — built from `dev`.

Work on `dev`, commit source changes and push. The Pages workflow validates both branches and publishes them together, keeping the root site on the `main` revision. To release tested work, merge `dev` into `main` and push `main`. A failed check prevents publishing. Both URLs expose `version.json` with their branch and commit.

To republish the current branches without another commit, run `gh workflow run pages.yml --ref main`, or use **Run workflow** on the repository's Actions page. The deployment never merges development changes into the stable branch.

```sh
git switch dev
python3 scripts/build.py
python3 scripts/validate.py
node tests/map-labels.test.cjs
node tests/local-maps.test.cjs
node tests/storage.test.cjs
# After committing and pushing dev, review /dev/ before releasing:
git switch main
git merge --ff-only dev
git push origin main
git switch dev
```

For a local development-channel build, use `python3 scripts/build.py --channel dev`. Main uses the existing `maple-atlas` IndexedDB database; dev uses `maple-atlas-dev`, so preview testing does not change main progress. Research, local mobile QA pages and backend drafts are ignored and never published.

## Data and behavior

The map uses a reviewed Classic World data snapshot. Atlas positions, map contents and recorded portal links are distinct datasets; a map without a reviewed atlas position is not placed at its return town. Routes depend on the recorded graph and do not promise support for every scripted portal, taxi, ship, scroll or eligibility condition.

Location and quest progress are entered manually. Progress is stored in this browser's IndexedDB database, with no account, server synchronization or game connection. Clearing browser data removes that progress. Quest associations and level checks do not validate every in-game prerequisite.

Every one of the 246 location records includes a full-resolution game map, with 218 minimaps for lightweight previews. Open a local map from a place or route step; choose an exit, zoom, fit the map or focus the recorded portal. Portal overlays use the source image pixel coordinates and never invent an internal walking path. Full-resolution images load on demand. Their dimensions and all 457 portal coordinates are checked in `data/map-image-audit.json`.

Game sprites and local map images are referenced from a pinned [OSMS data repository](https://github.com/ohmi69/osms_datamine_dashboard) snapshot. Roboto, Lucide and sprite images load from external CDNs; the application is not fully offline. The atlas illustration and route geometry are included in the source.

## Verify a change

```sh
python3 scripts/build.py
python3 scripts/validate.py
node --check src/runtime.js
node --check src/storage.js
node tests/map-labels.test.cjs
node tests/local-maps.test.cjs
node tests/storage.test.cjs
```

The validator checks all 457 included directed portal pairs against the pinned source audit, road/route endpoint agreement, known routes and sprite coverage. The illustrated atlas has 64 published community anchors and three clearly marked schematic forest points; 179 other map records remain available through search and connections without invented map coordinates. Portal activation conditions and complete transport coverage still require in-game verification.
