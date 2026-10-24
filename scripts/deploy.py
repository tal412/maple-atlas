#!/usr/bin/env python3
"""Push the current release branch and explicitly start the Pages workflow."""
import argparse
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    branch = git('branch', '--show-current')
    if branch not in ('main', 'dev'):
        raise SystemExit('Switch to main or dev before deploying.')
    if git('status', '--porcelain'):
        raise SystemExit('Commit your changes before deploying. No files have been pushed.')
    subprocess.run(['git', 'push', 'origin', branch], cwd=ROOT, check=True)
    # Explicit dispatch also works when GitHub does not deliver a push trigger.
    subprocess.run(['gh', 'workflow', 'run', 'pages.yml', '--ref', branch], cwd=ROOT, check=True)
    print(f'Publishing {branch}. GitHub Actions will validate both branches before deployment.')
    print('Main: https://tal412.github.io/maple-atlas/')
    print('Dev:  https://tal412.github.io/maple-atlas/dev/')
    print('Progress: gh run list --workflow pages.yml')


if __name__ == '__main__':
    main()
