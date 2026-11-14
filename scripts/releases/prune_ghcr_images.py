"""Prune old Chalk release images from GHCR without breaking a multi-architecture index.

A release publishes one tagged index per component. Each index points at one untagged
image per architecture, and the attestation of an index is a tagged `sha256-<digest>`
referrer. Deleting a child that a kept index still lists would break pulls by digest,
so the plan keeps every kept index together with its children and its referrers.
"""

import argparse
import base64
from datetime import datetime, timedelta, timezone
import json
import os
import re
import subprocess
import sys
import urllib.request

PACKAGES = ("chalk-api", "chalk-sync")
KEEP_RELEASES = 30
MIN_AGE_DAYS = 90
REFERRER_TAG = re.compile(r"^sha256-([0-9a-f]{64})")
MANIFEST_TYPES = ", ".join(
    (
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    )
)


def referrer_subject(version):
    for tag in version["tags"]:
        match = REFERRER_TAG.match(tag)
        if match:
            return "sha256:" + match.group(1)
    return None


def plan_prune(versions, children_of, now, keep_releases=KEEP_RELEASES, min_age_days=MIN_AGE_DAYS):
    """Return the versions to delete. `children_of(digest)` lists the child digests of an index."""
    releases = sorted(
        (v for v in versions if v["tags"] and referrer_subject(v) is None),
        key=lambda v: v["created_at"],
        reverse=True,
    )
    cutoff = now - timedelta(days=min_age_days)
    kept = releases[:keep_releases] + [v for v in versions if v["created_at"] >= cutoff]
    protected = set()
    for release in kept:
        protected.add(release["digest"])
        protected.update(children_of(release["digest"]))
    for referrer in versions:
        subject = referrer_subject(referrer)
        if subject in protected:
            protected.add(referrer["digest"])
            protected.update(children_of(referrer["digest"]))
    return [v for v in versions if v["digest"] not in protected and v["created_at"] < cutoff]


def github(*args):
    result = subprocess.run(["gh", "api", *args], capture_output=True, text=True)
    if result.returncode:
        sys.exit(f"gh api {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def package_root():
    owner_type = github(f"repos/{os.environ['GITHUB_REPOSITORY']}", "--jq", ".owner.type").strip()
    owner = os.environ["GITHUB_REPOSITORY_OWNER"]
    return f"{'orgs' if owner_type == 'Organization' else 'users'}/{owner}/packages/container"


def list_versions(root, package):
    pages = json.loads(github("--paginate", "--slurp", f"{root}/{package}/versions?per_page=100"))
    return [
        {
            "id": item["id"],
            "digest": item["name"],
            "created_at": datetime.fromisoformat(item["created_at"].replace("Z", "+00:00")),
            "tags": item.get("metadata", {}).get("container", {}).get("tags", []),
        }
        for page in pages
        for item in page
    ]


def registry_children(owner, package, token):
    """Read child digests from the registry, which is the only place an index lists them."""
    credentials = base64.b64encode(f"{owner}:{token}".encode()).decode()
    scope = f"repository:{owner}/{package}:pull"
    request = urllib.request.Request(
        f"https://ghcr.io/token?service=ghcr.io&scope={scope}",
        headers={"Authorization": f"Basic {credentials}"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        bearer = json.load(response)["token"]

    def children_of(digest):
        manifest = urllib.request.Request(
            f"https://ghcr.io/v2/{owner}/{package}/manifests/{digest}",
            headers={"Authorization": f"Bearer {bearer}", "Accept": MANIFEST_TYPES},
        )
        with urllib.request.urlopen(manifest, timeout=30) as response:
            return [child["digest"] for child in json.load(response).get("manifests", [])]

    return children_of


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply", action="store_true", help="delete; without it only print the plan")
    parser.add_argument("--keep-releases", type=int, default=KEEP_RELEASES)
    parser.add_argument("--min-age-days", type=int, default=MIN_AGE_DAYS)
    args = parser.parse_args()

    owner = os.environ["GITHUB_REPOSITORY_OWNER"].lower()
    token = os.environ["GITHUB_TOKEN"]
    root = package_root()
    now = datetime.now(timezone.utc)
    for package in PACKAGES:
        versions = list_versions(root, package)
        doomed = plan_prune(
            versions, registry_children(owner, package, token), now, args.keep_releases, args.min_age_days
        )
        print(f"{package}: {len(versions)} versions, {len(doomed)} to delete ({'apply' if args.apply else 'dry run'})")
        for version in doomed:
            print(f"  {version['digest']} {version['created_at']:%Y-%m-%d} {','.join(version['tags']) or '-'}")
            if args.apply:
                github("-X", "DELETE", f"{root}/{package}/versions/{version['id']}")


if __name__ == "__main__":
    main()
