#!/usr/bin/env python3
"""Download exact pinned map assets for static hosting; verify every Git blob."""
import concurrent.futures
import hashlib
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'data/map-assets.json').read_text())


def matches(content, entry):
    return len(content) == entry['bytes'] and hashlib.sha1(
        b'blob ' + str(len(content)).encode() + b'\0' + content
    ).hexdigest() == entry['gitBlob']


def download(entry):
    target = ROOT / 'docs' / entry['path']
    if target.exists() and matches(target.read_bytes(), entry):
        return
    source = entry['source']
    raw = source.replace('https://cdn.jsdelivr.net/gh/', 'https://raw.githubusercontent.com/').replace('@', '/')
    errors = []
    for url in [raw, source, raw]:
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                content = response.read()
            if not matches(content, entry):
                raise ValueError('Downloaded bytes do not match the pinned Git blob')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            return
        except Exception as error:
            errors.append(str(error))
    raise RuntimeError(entry['path'] + ': ' + '; '.join(errors))


if __name__ == '__main__':
    assets = [entry for m in manifest['maps'].values() for entry in m.values()]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        jobs = [pool.submit(download, entry) for entry in assets]
        for i, job in enumerate(concurrent.futures.as_completed(jobs), 1):
            job.result()
            if i % 40 == 0 or i == len(jobs):
                print(f'Verified {i}/{len(jobs)} original map assets', flush=True)
