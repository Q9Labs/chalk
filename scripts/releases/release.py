#!/usr/bin/env python3
"""Release-set commands used by Release, Nightly, and Promote. No rebuild fallback."""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from github_release import GitHub, ancestor, cut_decision, held_candidates, newest_activation, outputs, payload, timestamp
from release_set import canonical, digest, require, validate, validate_manifest


def env(name):
    value = os.environ.get(name, "")
    require(value, f"missing {name}")
    return value


def load_set(github, info, directory):
    run = github.request(f"actions/runs/{info['run_id']}")
    require(run["head_branch"] == "master" and run["event"] in ("schedule", "workflow_dispatch")
            and run["head_repository"]["full_name"] == github.repository
            and run["path"].split("@")[0] in (".github/workflows/nightly.yml", ".github/workflows/ci.yml"),
            "release artifacts must originate from a trusted master Release/nightly run")
    data = github.artifact(info["run_id"], info["set_artifact_id"], "release-set.json", info["set_sha256"])
    value = validate(json.loads(data))
    require(value["run_id"] == str(info["run_id"]), "release set producing run mismatch")
    require(value["target_sha"] == info["target_sha"] and value["release_id"] == info["release_id"], "deployment identity mismatch")
    backend = value["backend"]
    require(backend["artifact_id"] == str(info["manifest_artifact_id"])
            and backend["sha256"] == info["manifest_sha256"], "deployment backend reference mismatch")
    manifest = github.artifact(value["run_id"], backend["artifact_id"], value["release_id"] + ".json", backend["sha256"])
    validate_manifest(value, manifest)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "release-set.json").write_bytes(data)
    (directory / (value["release_id"] + ".json")).write_bytes(manifest)
    for target, member in value["web"].items():
        web = github.artifact(value["run_id"], member["artifact_id"], f"web-{target}.tar.gz", member["sha256"])
        (directory / f"web-{target}.tar.gz").write_bytes(web)
    return value


def selection_outputs(item, prefix=""):
    info = payload(item)
    return {prefix + key: info[key] for key in ("run_id", "target_sha", "release_id", "set_artifact_id", "set_sha256",
                                               "manifest_artifact_id", "manifest_sha256")} | {prefix + "deployment_id": item["id"]}


def plan(github, args):
    target = subprocess.check_output(["git", "rev-parse", "origin/master"], text=True).strip()
    deployments = github.deployments("nightly")
    should_cut, reason = cut_decision(target, deployments, datetime.now(timezone.utc), args.manual)
    print(f"Nightly decision: {reason}; pinned master {target}")
    active = newest_activation(deployments)
    if active:
        ancestor(payload(active)["target_sha"], target)
    if should_cut:
        github.gate(target)
        if not args.dry_run:
            require(os.environ.get("CHALK_IMMUTABLE_REPLAY_READY") == "true", "exact-manifest host replay must be qualified before deployment")
    result = {"should_cut": should_cut, "target_sha": target,
              "baseline_run_id": payload(active)["run_id"] if active else "",
              "baseline_artifact_id": payload(active)["manifest_artifact_id"] if active else ""}
    if active and held_candidates([active], datetime.now(timezone.utc)):
        load_set(github, payload(active), args.directory / "previous")
        result.update(selection_outputs(active, "previous_"))
    if should_cut and not args.dry_run:
        result["attempt_id"] = github.record("nightly", target, {"channel": "nightly-cut", "target_sha": target,
            "run_id": env("GITHUB_RUN_ID"), "attempted_at": datetime.now(timezone.utc).isoformat()}, "in_progress")
    outputs(result)


def select(github, args):
    require(os.environ.get("CHALK_IMMUTABLE_REPLAY_READY") == "true", "exact-manifest rollback support is not qualified")
    candidates = held_candidates(github.deployments("nightly"), datetime.now(timezone.utc))
    require(candidates, "no held nightly with fresh evidence (30-day eligibility limit)")
    failures = []
    selected = None
    for candidate in candidates:
        try:
            info = payload(candidate)
            ancestor(info["target_sha"])
            github.gate(info["target_sha"])
            load_set(github, info, args.directory / "candidate")
        except (ValueError, subprocess.CalledProcessError) as error:
            failures.append(f"deployment {candidate['id']}: {error}")
            continue
        selected = candidate
        break
    require(selected, "no available held release set: " + "; ".join(failures))
    result = selection_outputs(selected)
    previous = [item for item in github.deployments("production") if item["latest_status"] == "success"
                and payload(item).get("activated_at") and payload(item).get("channel") == "production-release"]
    require(previous, "production rollback release set is not seeded; no mutation allowed")
    old = max(previous, key=lambda item: timestamp(payload(item)["activated_at"]))
    load_set(github, payload(old), args.directory / "previous")
    result.update(selection_outputs(old, "previous_"))
    print(json.dumps(result, indent=2))
    with Path(env("GITHUB_STEP_SUMMARY")).open("a") as summary:
        summary.write("## Selected held nightly (before production approval or mutation)\n\n```json\n"
                      + json.dumps(result, indent=2) + "\n```\n")
        if failures:
            summary.write("\nSkipped unavailable candidates:\n" + "\n".join("- " + item for item in failures) + "\n")
    outputs(result)


def resolve(github, args):
    info = {key: env(key.upper()) for key in ("run_id", "target_sha", "release_id", "set_artifact_id", "set_sha256",
                                              "manifest_artifact_id", "manifest_sha256")}
    value = load_set(github, info, args.directory)
    ancestor(value["target_sha"])
    github.gate(value["target_sha"])
    outputs({"release_id": value["release_id"], "manifest_artifact_id": value["backend"]["artifact_id"],
             "manifest_sha256": value["backend"]["sha256"]})


def assemble(github, args):
    run = env("GITHUB_RUN_ID")
    manifest_data = github.artifact(run, env("MANIFEST_ARTIFACT_ID"), env("RELEASE_ID") + ".json")
    manifest = json.loads(manifest_data)
    runtime = json.loads(github.artifact(env("RUNTIME_RUN_ID"), env("RUNTIME_ARTIFACT_ID"),
                                        "qualified-runtime.json", env("RUNTIME_SHA256")))
    require(set(runtime) == {"runtime", "versions"}, "qualified runtime artifact contains unexpected fields")
    # A retained qualified member is valid only when none of its build inputs changed.
    # New qualification is required; rebuilding at promote time is never allowed.
    worker_inputs = ["scripts/recorder", "infrastructure/recorder", "apps/api", "apps/recording-renderer",
                     "packages", "sdks", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", "turbo.json", ".tool-versions"]
    paths = {"capture": worker_inputs, "render": worker_inputs,
             "dispatcher": ["apps/transcription-dispatcher", "scripts/transcription-dispatcher", "packages",
                            "pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", ".tool-versions"]}
    for members in runtime["runtime"].values():
        for role, member in members.items():
            source = member["source_revision"]
            ancestor(source, env("TARGET_SHA"))
            changed = subprocess.check_output(["git", "diff", "--name-only", source, env("TARGET_SHA"), "--", *paths[role]], text=True)
            require(not changed, f"{role} inputs changed since qualification; publish a new qualified runtime artifact")
    web = {}
    for target in ("nightly", "production"):
        artifact_id = env("WEB_" + target.upper() + "_ARTIFACT_ID")
        data = github.artifact(run, artifact_id, f"web-{target}.tar.gz")
        from web import read_marker
        marker = read_marker(data)
        web[target] = {"artifact_id": artifact_id, "sha256": digest(data), **marker}
    value = validate({"schema_version": 1, "target_sha": env("TARGET_SHA"), "release_id": env("RELEASE_ID"),
        "run_id": run, "run_attempt": env("GITHUB_RUN_ATTEMPT"), "created_at": datetime.now(timezone.utc).isoformat(),
        "backend": {"artifact_id": env("MANIFEST_ARTIFACT_ID"), "sha256": digest(manifest_data),
                    "components": manifest["component_releases"]}, "web": web, **runtime})
    validate_manifest(value, manifest_data)
    args.directory.mkdir(parents=True, exist_ok=True)
    data = canonical(value)
    (args.directory / "release-set.json").write_bytes(data)
    outputs({"sha256": digest(data), "manifest_sha256": digest(manifest_data)})


def recheck(github, args):
    deployment = github.request(f"deployments/{env('DEPLOYMENT_ID')}")
    statuses = github.request(f"deployments/{deployment['id']}/statuses?per_page=1")
    deployment["latest_status"] = statuses[0]["state"] if statuses else "pending"
    require(held_candidates([deployment], datetime.now(timezone.utc)), "selected nightly was revoked, failed, or aged out")
    require(payload(deployment)["set_sha256"] == env("SET_SHA256"), "selection changed")


def record(github, args):
    # Keep failed attempts separate from the activated record so the daily baseline
    # is the last actual activation, never an artifact build or a status update.
    result = env("PROOF_RESULT")
    passed = result == "passed" and os.environ.get("SERVED_MATCHES") == "true" and os.environ.get("DEPLOY_RESULT") == "success"
    info = {key: env(key.upper()) for key in ("target_sha", "release_id", "run_id", "set_artifact_id", "set_sha256",
                                              "manifest_artifact_id", "manifest_sha256")}
    info.update(channel="nightly-cut" if args.environment == "nightly" else "production-release",
                proof_result="passed" if passed else "failed", served_matches=passed,
                proof_run_id=env("GITHUB_RUN_ID"))
    info["proof_artifacts"] = [{"artifact_id": str(item["id"]), "name": item["name"], "digest": item.get("digest")}
                               for item in github.pages(f"actions/runs/{env('GITHUB_RUN_ID')}/artifacts", "artifacts")
                               if "proof" in item["name"].lower() and not item["expired"]]
    if os.environ.get("SOURCE_DEPLOYMENT_ID"):
        info["source_nightly_deployment_id"] = env("SOURCE_DEPLOYMENT_ID")
    if os.environ.get("ACTIVATED_AT"):
        info["activated_at"] = env("ACTIVATED_AT")
    deployment_id = github.record(args.environment, info["target_sha"], info, "success" if passed else "failure")
    if os.environ.get("ATTEMPT_ID"):
        github.status(env("ATTEMPT_ID"), "success" if passed else "failure")
    if args.environment == "production" and not passed and os.environ.get("SOURCE_DEPLOYMENT_ID"):
        github.status(env("SOURCE_DEPLOYMENT_ID"), "failure")
    outputs({"deployment_id": deployment_id})


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("command", choices=("plan", "select", "resolve", "assemble", "recheck", "record"))
    parser.add_argument("--directory", type=Path, default=Path("release-input"))
    parser.add_argument("--environment", choices=("nightly", "production"), default="nightly")
    parser.add_argument("--manual", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    globals()[args.command](GitHub(), args)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Release refused: {error}", file=sys.stderr)
        sys.exit(1)
