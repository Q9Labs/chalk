"""Retain and restore the npm latest tags used by production promotion."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
REGISTRY = "https://registry.npmjs.org/"


def package_names():
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            'import { releasePackages } from "./scripts/npm-release.mjs"; console.log(JSON.stringify(releasePackages.map(({ name }) => name)));',
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        raise RuntimeError(f"Could not read npm release packages: {result.stderr.strip()}")
    return json.loads(result.stdout)


def read_latest(package):
    result = subprocess.run(
        ["npm", "view", package, "dist-tags.latest", "--json", "--registry", REGISTRY],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    output = result.stdout + result.stderr
    if result.returncode:
        if "E404" in output or "404" in output:
            return None
        raise RuntimeError(f"npm view failed for {package} with exit code {result.returncode}.")
    try:
        latest = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"npm view returned invalid JSON for {package}.") from error
    if latest is not None and not isinstance(latest, str):
        raise RuntimeError(f"npm view returned a non-string latest tag for {package}.")
    return latest


def retain(output):
    latest = {package: read_latest(package) for package in package_names()}
    compact = json.dumps(latest, separators=(",", ":"))
    Path(output).write_text(compact + "\n", encoding="utf-8")
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as output_file:
            output_file.write(f"npm_latest={compact}\n")
    return latest


def pending_publish_runs():
    command = ["gh", "run", "list", "--workflow", "npm-publish.yml", "--json", "databaseId,status", "--limit", "20"]
    repository = os.environ.get("GITHUB_REPOSITORY")
    if repository:
        command.extend(["--repo", repository])
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"Could not list npm publish runs (exit code {result.returncode}).")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("gh returned invalid JSON while listing npm publish runs.") from error


def wait_for_publish_runs():
    while True:
        pending = [run for run in pending_publish_runs() if run.get("status") != "completed"]
        if not pending:
            return
        for run in pending:
            run_id = run.get("databaseId")
            if run_id is None:
                raise RuntimeError("gh returned an npm publish run without a database ID.")
            print(f"Waiting for npm publish run {run_id}.")
            subprocess.run(["gh", "run", "watch", str(run_id)], cwd=ROOT, capture_output=True, text=True)


def write_summary(rows):
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary_path:
        return
    with open(summary_path, "a", encoding="utf-8") as summary:
        summary.write("| Package | Previous | Found | Action |\n| --- | --- | --- | --- |\n")
        for package, previous, found, action in rows:
            summary.write(f"| {package} | {previous} | {found} | {action} |\n")


def restore(previous):
    if not isinstance(previous, dict):
        raise RuntimeError("PREVIOUS_NPM_LATEST must be a JSON object.")
    wait_for_publish_runs()
    rows = []
    failed = False
    for package, version in previous.items():
        if version is None:
            print(f"Warning: no previous npm latest recorded for {package}; skipping.")
            rows.append((package, "null", "not checked", "skipped (no previous latest)"))
            continue
        if not isinstance(version, str):
            raise RuntimeError(f"Previous npm latest for {package} must be a string or null.")
        try:
            found = read_latest(package)
        except RuntimeError as error:
            print(f"Could not read npm latest for {package}: {error}", file=sys.stderr)
            rows.append((package, version, "unavailable", "failed to read latest"))
            failed = True
            continue
        action = "unchanged"
        if found != version:
            result = subprocess.run(
                ["npm", "dist-tag", "add", f"{package}@{version}", "latest"],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )
            if result.returncode:
                print(f"npm dist-tag add failed for {package} (exit code {result.returncode}).", file=sys.stderr)
                rows.append((package, version, found if found is not None else "null", "restore failed"))
                failed = True
                continue
            action = "restored"
            for attempt in range(5):
                try:
                    found = read_latest(package)
                except RuntimeError:
                    found = None
                if found == version:
                    break
                if attempt < 4:
                    time.sleep(0.5)
            if found != version:
                print(f"npm latest verification failed for {package}.", file=sys.stderr)
                rows.append((package, version, found if found is not None else "null", "verification failed"))
                failed = True
                continue
        rows.append((package, version, found if found is not None else "null", action))
    write_summary(rows)
    return not failed


def main(argv=None):
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    retain_parser = subparsers.add_parser("retain")
    retain_parser.add_argument("--output", required=True)
    subparsers.add_parser("restore")
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == "retain":
            retain(arguments.output)
        else:
            value = os.environ.get("PREVIOUS_NPM_LATEST")
            if value is None:
                raise RuntimeError("PREVIOUS_NPM_LATEST is required for npm tag restoration.")
            if not restore(json.loads(value)):
                return 1
    except (RuntimeError, json.JSONDecodeError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
