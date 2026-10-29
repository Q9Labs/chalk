"""Require an explicit production commit reachable from live origin/master."""

from http.client import HTTPException
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request

PRODUCTION_RELEASE_URL = 'https://chalkmeet.com/release.json'


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def verify_publish_ref(release_sha, release_url=PRODUCTION_RELEASE_URL):
    if not re.fullmatch('[0-9a-f]{40}', release_sha):
        raise ValueError('release_sha must be an explicit full lowercase commit SHA for publishing')

    try:
        remote = git('ls-remote', 'origin', 'refs/heads/master').split()
        if len(remote) != 2 or remote[1] != 'refs/heads/master' or not re.fullmatch('[0-9a-f]{40}', remote[0]):
            raise ValueError('Ancestry check failed: could not read a valid live origin/master SHA')
        live_master_sha = remote[0]
        shallow = git('rev-parse', '--is-shallow-repository') == 'true'
        git('fetch', '--no-tags', *(['--unshallow'] if shallow else []), 'origin', live_master_sha)
    except subprocess.CalledProcessError as error:
        raise ValueError('Ancestry check failed: could not fetch live origin/master history') from error
    if subprocess.run(['git', 'merge-base', '--is-ancestor', release_sha, live_master_sha]).returncode != 0:
        raise ValueError(f'Ancestry check failed: release_sha {release_sha} is not an ancestor of live origin/master {live_master_sha}')

    request = urllib.request.Request(release_url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'chalk-release/1.0'})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            if response.status != 200:
                raise ValueError('Production identity check failed: release.json did not return HTTP 200')
            marker = json.load(response)
    except (OSError, urllib.error.URLError, HTTPException) as error:
        raise ValueError(f'Production identity check failed: release.json is unreachable ({error})') from error
    except (ValueError, UnicodeError) as error:
        raise ValueError('Production identity check failed: release.json is malformed') from error
    if (not isinstance(marker, dict) or marker.get('environment') != 'production'
            or not isinstance(marker.get('commit'), str) or not re.fullmatch('[0-9a-f]{40}', marker['commit'])):
        raise ValueError('Production identity check failed: release.json must report production and a full commit SHA')
    if marker['commit'] != release_sha:
        raise ValueError(f'Production identity check failed: release_sha {release_sha} does not match live production {marker["commit"]}')
    print(f'Publish ref verified: {release_sha} is on origin/master and live in production')


if __name__ == '__main__':
    try:
        verify_publish_ref(sys.argv[1] if len(sys.argv) == 2 else '')
    except ValueError as error:
        sys.exit(str(error))
