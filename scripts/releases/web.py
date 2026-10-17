#!/usr/bin/env python3
"""Build two target-specific archives; deploy one verified archive without building."""

import argparse
import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path

from release_set import canonical, digest, require, validate

ROOT = Path(__file__).resolve().parents[2]


def public_config(target, sha):
    nightly = target == "nightly"
    return {"environment": target, "commit": sha,
            "api_url": "https://nightly-api.chalkmeet.com" if nightly else "https://api.chalkmeet.com",
            "sync_url": "wss://nightly-sync.chalkmeet.com/v1/sync" if nightly else "wss://sync.chalkmeet.com/v1/sync",
            "app_url": "https://nightly.chalkmeet.com" if nightly else "https://chalkmeet.com"}


def read_marker(data):
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        members = archive.getmembers()
        require(all(not Path(member.name).is_absolute() and ".." not in Path(member.name).parts
                    and (member.isfile() or member.isdir()) for member in members), "unsafe web archive")
        require(sum(member.size for member in members) <= 1024 ** 3, "web archive exceeds 1 GiB")
        names = [member.name for member in members]
        require(len(names) == len(set(names)), "duplicate web archive member")
        require("dist/client/_worker.js" in names and "wrangler.toml" in names, "missing prebuilt proxy/config")
        marker = json.load(archive.extractfile("dist/client/release.json"))
    require(marker["config_sha256"] == digest(canonical(marker["config"])), "invalid web marker fingerprint")
    require(marker["config"] == public_config(marker["config"]["environment"], marker["config"]["commit"]),
            "web marker has unexpected endpoints")
    return marker


def build(target, sha, output, dry_run=False):
    config = public_config(target, sha)
    command = ["pnpm", "exec", "turbo", "run", "build", "--filter=web...", "--force", "--env-mode=loose"]
    if dry_run:
        print(json.dumps({"command": command, "config": config, "output": str(output)}))
        return
    environment = {**os.environ, "CHALK_ENVIRONMENT": target, "CHALK_COMMIT_SHA": sha,
                   "VITE_API_URL": config["api_url"], "VITE_CHALK_SYNC_URL": config["sync_url"],
                   "VITE_PUBLIC_APP_URL": config["app_url"]}
    subprocess.run(command, cwd=ROOT, env=environment, check=True)
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="chalk-web-") as temporary:
        stage = Path(temporary)
        shutil.copytree(ROOT / "apps/web/dist/client", stage / "dist/client")
        # Advanced-mode Worker is source-complete JS: no Functions compilation at promotion.
        shutil.copyfile(ROOT / "scripts/releases/pages-worker.mjs", stage / "dist/client/_worker.js")
        (stage / "dist/client/release.json").write_bytes(canonical({"config": config, "config_sha256": digest(canonical(config))}))
        (stage / "wrangler.toml").write_text(
            'name = "chalk-web"\ncompatibility_date = "2024-12-01"\ncompatibility_flags = ["nodejs_compat"]\n'
            'pages_build_output_dir = "dist/client"\n[vars]\n'
            + f'CHALK_API_ORIGIN = "{config["api_url"]}"\nCHALK_ENVIRONMENT = "{target}"\n'
            + f'CHALK_COMMIT_SHA = "{sha}"\n')
        with tarfile.open(output / f"web-{target}.tar.gz", "w:gz") as archive:
            archive.add(stage / "dist", arcname="dist")
            archive.add(stage / "wrangler.toml", arcname="wrangler.toml")


def deploy(target, release_set_path, archive_path, project, dry_run=False):
    release_set = validate(json.loads(release_set_path.read_text()))
    member = release_set["web"][target]
    data = archive_path.read_bytes()
    require(digest(data) == member["sha256"], "web archive checksum mismatch")
    require(read_marker(data) == {"config": member["config"], "config_sha256": member["config_sha256"]}, "web archive config mismatch")
    command = [str(ROOT / "node_modules/.bin/wrangler"), "pages", "deploy", "dist/client", "--project-name", project,
               "--branch", "master", "--commit-hash", release_set["target_sha"], "--commit-dirty=false", "--no-bundle"]
    if dry_run:
        print(json.dumps({"command": command, "archive_sha256": digest(data), "config": member["config"]}))
        return
    require(os.environ.get("CLOUDFLARE_ACCOUNT_ID") and os.environ.get("CLOUDFLARE_API_TOKEN"), "missing Pages credentials")
    with tempfile.TemporaryDirectory(prefix="chalk-pages-") as temporary:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            archive.extractall(temporary, filter="data")
        subprocess.run(command, cwd=temporary, check=True)


def verify(target, release_set_path):
    release_set = validate(json.loads(release_set_path.read_text()))
    expected = release_set["web"][target]
    url = expected["config"]["app_url"] + "/release.json?sha=" + release_set["target_sha"]
    with urllib.request.urlopen(urllib.request.Request(url, headers={"Cache-Control": "no-cache"}), timeout=30) as response:
        observed = json.load(response)
    require(observed == {"config": expected["config"], "config_sha256": expected["config_sha256"]}, "served web release mismatch")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("command", choices=("build", "deploy", "verify"))
    parser.add_argument("--target", choices=("nightly", "production"), required=True)
    parser.add_argument("--sha")
    parser.add_argument("--output", type=Path, default=Path("web-output"))
    parser.add_argument("--release-set", type=Path)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--project")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.command == "build":
        build(args.target, args.sha, args.output, args.dry_run)
    elif args.command == "deploy":
        deploy(args.target, args.release_set, args.archive, args.project, args.dry_run)
    else:
        verify(args.target, args.release_set)
