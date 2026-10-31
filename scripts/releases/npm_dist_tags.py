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
VERIFY_ATTEMPTS = 6
VERIFY_DELAY_SECONDS = 10
RETAIN_STABILITY_ROUNDS = 3


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
        if "E404" in output:
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
    wait_for_publish_runs()
    latest = read_stable_latest(package_names())
    compact = json.dumps(latest, separators=(",", ":"))
    Path(output).write_text(compact + "\n", encoding="utf-8")
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as output_file:
            output_file.write(f"npm_latest={compact}\n")
    return latest


def read_all_latest(packages):
    return {package: read_latest(package) for package in packages}


def read_stable_latest(packages):
    latest = read_all_latest(packages)
    for _ in range(RETAIN_STABILITY_ROUNDS):
        if not in_flight_publish_runs():
            return latest
        wait_for_publish_runs()
        latest = read_all_latest(packages)
    if in_flight_publish_runs():
        raise RuntimeError("npm latest tags did not stabilize while retaining.")
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


def in_flight_publish_runs():
    return [run for run in pending_publish_runs() if run.get("status") != "completed"]


def wait_for_publish_runs():
    while True:
        pending = in_flight_publish_runs()
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


def verify_latest(package, version):
    found = None
    for attempt in range(VERIFY_ATTEMPTS):
        try:
            found = read_latest(package)
        except RuntimeError:
            found = None
        if found == version:
            return found
        if attempt + 1 < VERIFY_ATTEMPTS:
            time.sleep(VERIFY_DELAY_SECONDS)
    return found


def restore_package(package, version):
    if version is None:
        print(f"Warning: no previous npm latest recorded for {package}; skipping.")
        return (package, "null", "not checked", "skipped (no previous latest)"), True
    if not isinstance(version, str):
        raise RuntimeError(f"Previous npm latest for {package} must be a string or null.")
    try:
        found = read_latest(package)
    except RuntimeError as error:
        print(f"Could not read npm latest for {package}: {error}", file=sys.stderr)
        return (package, version, "unavailable", "failed to read latest"), False
    if found == version:
        return (package, version, found, "unchanged"), True
    result = subprocess.run(
        ["npm", "dist-tag", "add", f"{package}@{version}", "latest"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        print(f"npm dist-tag add failed for {package} (exit code {result.returncode}).", file=sys.stderr)
        return (package, version, found if found is not None else "null", "restore failed"), False
    found = verify_latest(package, version)
    if found != version:
        print(f"npm latest verification failed for {package}.", file=sys.stderr)
        return (package, version, found if found is not None else "null", "verification failed"), False
    return (package, version, found, "restored"), True


def restore(previous):
    if not isinstance(previous, dict):
        raise RuntimeError("PREVIOUS_NPM_LATEST must be a JSON object.")
    wait_for_publish_runs()
    rows = []
    failed = False
    for package, version in previous.items():
        row, ok = restore_package(package, version)
        rows.append(row)
        failed |= not ok
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
