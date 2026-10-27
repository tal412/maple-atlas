#!/usr/bin/env python3
"""Build docs/index.html from the portable src/ and data/ snapshot."""

from __future__ import annotations

import json
import hashlib
import argparse
import re
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
LUCIDE_URL = "./vendor/lucide.js"



class MarkupAudit(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: set[str] = set()
        self.duplicates: set[str] = set()
        self.iframes = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        ident = attributes.get("id")
        if ident:
            if ident in self.ids:
                self.duplicates.add(ident)
            self.ids.add(ident)
        if tag == "iframe":
            self.iframes += 1

    handle_startendtag = handle_starttag


def ocean_art(source: str) -> str:
    art = re.sub(r"^<\?xml[^>]*>\s*", "", source.strip())
    ET.fromstring(art)
    if not re.match(r"<g\b", art):
        raise ValueError("World artwork must be the reviewed SVG group.")
    for layer in ("sea", "ripples"):
        pattern = rf'<rect\b[^>]*fill="url\(#mva-{layer}\)"[^>]*/>'
        matches = re.findall(pattern, art)
        if len(matches) != 1:
            raise ValueError(f"Expected one {layer} ocean rectangle.")
        original = matches[0]
        if "data-ocean=" not in original:
            art = art.replace(original, original.replace("<rect ", '<rect data-ocean="true" ', 1), 1)
    return art


def build(project: Path = PROJECT, channel: str = 'main') -> Path:
    src = project / "src"
    read = lambda name: (src / name).read_text(encoding="utf-8")
    template = read("template.html")
    runtime = '\n'.join(read(name + '.js') for name in ['map-labels', 'map-gestures', 'map-images', 'local-maps', 'quest-flow', 'search-index', 'search-data', 'item-data', 'item-sources', 'market-data', 'search-ui', 'companion-link', 'companion-device', 'minimap-position', 'quest-helper', 'quest-panel', 'companion-ui', 'offline', 'runtime', 'intro'])
    data = json.loads((project / "data" / "world.json").read_text(encoding="utf-8"))
    visual = json.loads((project / 'docs/data/visual-index.json').read_text())
    data['visualMaps'] = visual['maps']
    catalog = (project / 'data/search-catalog.json').read_bytes()
    search_name = 'search-' + hashlib.sha256(catalog).hexdigest()[:16] + '.json'
    data['searchCatalog'] = './data/' + search_name
    data['marketCatalog'] = './data/market.json'
    assets = json.loads((project / 'data/map-assets.json').read_text())['maps']
    for m in data['maps']:
        m['localImage'] = './' + assets[m['id']]['image']['path']
        m['localMinimap'] = './' + assets[m['id']]['preview']['path'] if 'preview' in assets[m['id']] else None
    if template.count("<!-- MAPLE_WORLD -->") != 1 or runtime.count("__INLINE_MAP_DATA__") != 1:
        raise ValueError("Expected exactly one world and one data insertion point.")
    palette = json.loads((project / 'data/night-palette.json').read_text())
    art = ocean_art(read('world.svg'))
    art = re.sub(r'#[0-9a-fA-F]{6}\b', lambda m: 'var(--art-' + m[0][1:] + ',' + m[0] + ')', art)
    night_css = '@media(prefers-color-scheme:dark){#maple-atlas-concept{' + ''.join('--art-' + key[1:] + ':' + value + ';' for key, value in palette.items()) + '}}'
    # The homepage (src/intro.html) lives inside the app root, after the other dialogs.
    intro = read('intro.html')
    template = template[:template.rindex('</div>')] + intro + template[template.rindex('</div>'):]
    app = template.replace("<!-- MAPLE_WORLD -->", art)
    app = app.replace('id="maple-atlas-concept"', f'id="maple-atlas-concept" data-channel="{channel}"', 1)
    # Main is the only public channel: it no longer advertises the dev preview.
    channel_link = '<a class="mc-channel" href="../">Dev preview · Open main ↗</a>' if channel == 'dev' else ''
    app = app.replace('<small>Classic World</small>', '<small>Classic World</small>' + channel_link, 1)
    if channel != 'dev':
        app = re.sub(r'<a id="mc-mobile-channel"[^>]*>[^<]*</a>', '', app, count=1)
    if channel == 'dev':
        app = app.replace('href="./dev/">Open dev preview', 'href="../">Dev preview · Open main')
    encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    runtime = runtime.replace("__INLINE_MAP_DATA__", encoded)
    if re.search(r"</script", runtime, re.I):
        raise ValueError("Runtime contains an unsafe inline script terminator.")
    css = read("app.css") + "\n" + read("fullscreen.css") + '\n' + read('mobile.css') + '\n' + read('search.css') + '\n' + read('companion.css') + '\n' + read('quests.css') + '\n' + read('intro.css') + '\n' + night_css + "\n.cursor-interaction{cursor:pointer}\n"
    page = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="description" content="Explore Classic World maps, NPCs, monsters and recorded portal routes. Track your MapleStory quest progress with Maple Atlas.">
  <meta name="theme-color" content="#f8fafd" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#1e1f20" media="(prefers-color-scheme: dark)">
  <title>Maple Atlas</title>
  <link rel="icon" type="image/svg+xml" href="./favicon.svg">
  <link rel="manifest" href="./manifest.webmanifest">
  <link rel="apple-touch-icon" href="./icons/icon-192.png">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <style>
""" + css + """  </style>
</head>
<body>
""" + app + "\n<script>\n" + read("storage.js") + "\n</script>\n" + '<script src="' + LUCIDE_URL + '"></script>\n<script>\n' + "window.mapleStorageReady.then(() => {\n" + runtime + "\n});\n</script>\n</body>\n</html>\n"
    audit = MarkupAudit()
    audit.feed(page)
    if audit.duplicates or audit.iframes:
        raise ValueError(f"Invalid output: duplicate IDs {sorted(audit.duplicates)}, iframes {audit.iframes}")
    if not {"maple-atlas-concept", "mc-world", "mc-route", "mc-markers"}.issubset(audit.ids):
        raise ValueError("Required application elements are missing.")
    if "__INLINE_MAP_DATA__" in page or "<!-- MAPLE_WORLD -->" in page:
        raise ValueError("An unresolved build placeholder remains.")
    docs = project / "docs"
    docs.mkdir(parents=True, exist_ok=True)
    (docs / 'data').mkdir(exist_ok=True)
    for old in (docs / 'data').glob('search-*.json'):
        if old.name != search_name:
            old.unlink()
    (docs / 'data' / search_name).write_bytes(catalog)
    (docs / 'data/market.json').write_bytes((project / 'data/market-snapshot.json').read_bytes())
    output = docs / "index.html"
    output.write_text(page, encoding="utf-8")
    (docs / ".nojekyll").write_text("", encoding="utf-8")
    (docs / 'favicon.svg').write_text(read('favicon.svg'), encoding='utf-8')
    # Installable app: "Add to Home screen" opens the map full screen, without browser bars.
    (docs / 'icons').mkdir(exist_ok=True)
    for size in (192, 512):
        (docs / f'icons/icon-{size}.png').write_bytes((project / f'src/icons/icon-{size}.png').read_bytes())
    label = 'Maple Atlas Dev' if channel == 'dev' else 'Maple Atlas'
    manifest = {
        'id': './', 'name': label, 'short_name': label, 'start_url': './', 'scope': './',
        'display': 'fullscreen', 'display_override': ['fullscreen', 'standalone'], 'orientation': 'any',
        'background_color': '#1e1f20', 'theme_color': '#1e1f20',
        'description': 'Classic World atlas and live map companion.',
        'icons': [{'src': f'./icons/icon-{size}.png', 'sizes': f'{size}x{size}', 'type': 'image/png', 'purpose': 'any'} for size in (192, 512)],
    }
    (docs / 'manifest.webmanifest').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    if channel == 'dev':
        output.write_text(page.replace('<title>Maple Atlas</title>', '<title>Maple Atlas · Dev</title>'), encoding='utf-8')
    offline_files = ['index.html', 'favicon.svg', 'vendor/lucide.js', 'vendor/roboto-latin.woff2', 'data/' + search_name]
    # The phone only scans QR codes; the companion apps read the map name from the minimap.
    offline_files += ['vendor/companion/qr.js']
    cache_version = hashlib.sha256((docs / 'vendor/companion/versions.json').read_bytes() + visual['sha256'].encode() + (docs / 'vendor/lucide.js').read_bytes() + (docs / 'vendor/roboto-latin.woff2').read_bytes()).hexdigest()[:12]
    worker = read('service-worker.js').replace('__CACHE_NAME__', json.dumps('maple-atlas-offline-' + channel + '-' + cache_version)).replace('__OFFLINE_FILES__', json.dumps(offline_files)).replace('__CHANNEL__', json.dumps(channel))
    (docs / 'sw.js').write_text(worker)
    print(f"Built {output.relative_to(project)}: {len(page.encode('utf-8')):,} bytes; {len(audit.ids)} unique IDs; no iframe.")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--channel', choices=('main', 'dev'), default='main')
    build(channel=parser.parse_args().channel)
