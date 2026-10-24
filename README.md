# Maple Atlas

A map-first Classic World companion with an original illustrated atlas, recorded portal routes, NPC and monster details, real game sprites, and manual quest progress.

## Build and preview

Requires Python 3.10 or newer; no package installation or API keys.

```sh
python3 scripts/build.py
python3 -m http.server 8000 --directory docs
```

Open `http://localhost:8000`. GitHub Pages serves the committed `docs/` directory. The application fills the browser directly, with no embedded preview frame. The project plan lives at `docs/plan.html`.

## Source layout

- `src/template.html`: application markup and world insertion point.
- `src/app.css`, `src/fullscreen.css`: interface and browser sizing.
- `src/storage.js`: IndexedDB persistence, migration and save error handling.
- `src/runtime.js`: interactions, routing, map positioning and progress.
- `src/world.svg`: original vector map illustration.
- `data/world.json`: portable map, portal, quest, atlas-position and sprite snapshot.
- `data/provenance.json`: snapshot and external sprite-source provenance.
- `docs/index.html`: generated standalone application; rebuild after source changes.

To import a newer reviewed concept snapshot and rebuild:

```sh
python3 scripts/export-site.py /absolute/path/to/reviewed-visuals
```

The exporter reads the final atlas fragment, runtime, artwork, world data and fullscreen CSS from that directory. Routine builds subsequently use only this repository. Research files are excluded from Git and from the published site.

## Data and behavior

The map uses a reviewed Classic World data snapshot. Atlas positions, map contents and recorded portal links are distinct datasets; a map without a reviewed atlas position is not placed at its return town. Routes depend on the recorded graph and do not promise support for every scripted portal, taxi, ship, scroll or eligibility condition.

Location and quest progress are entered manually. Progress is stored in this browser's IndexedDB database, with no account, server synchronization or game connection. Clearing browser data removes that progress. Quest associations and level checks do not validate every in-game prerequisite.

Game sprites are referenced from a pinned [OSMS data repository](https://github.com/ohmi69/osms_datamine_dashboard) snapshot. Roboto, Lucide and sprite images load from external CDNs; the application is not fully offline. The atlas illustration and route geometry are included in the source.

## Verify a change

```sh
python3 scripts/build.py
python3 scripts/validate.py
node --check src/runtime.js
node --check src/storage.js
```

The validator checks all 457 included directed portal pairs against the pinned source audit, road/route endpoint agreement, known routes and sprite coverage. The illustrated atlas has 64 published community anchors and three clearly marked schematic forest points; 179 other map records remain available through search and connections without invented map coordinates. Portal activation conditions and complete transport coverage still require in-game verification.
