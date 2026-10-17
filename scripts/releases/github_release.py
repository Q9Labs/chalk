"""GitHub API boundary and pure nightly selection rules."""

import io
import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from release_set import digest, require

CHANNEL = "nightly-cut"


def timestamp(value):
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(result.tzinfo is not None, "timestamp must include timezone")
    return result


def payload(deployment):
    value = deployment.get("payload", {})
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return {}
    return value if isinstance(value, dict) else {}


def newest_activation(deployments):
    activated = [item for item in deployments if payload(item).get("channel") == CHANNEL
                 and payload(item).get("activated_at")]
    return max(activated, key=lambda item: timestamp(payload(item)["activated_at"]), default=None)


def cut_decision(target, deployments, now, manual=False):
    require(re.fullmatch(r"[0-9a-f]{40}", target), "target must be a full SHA")
    active = newest_activation(deployments)
    if active:
        info = payload(active)
        if info["target_sha"] == target:
            if manual and (active.get("latest_status") != "success" or info.get("proof_result") != "passed"):
                return True, "explicit retry of failed activation/proof"
            return False, "master has no new commits"
        if timestamp(info["activated_at"]).date() >= now.date():
            return False, "already activated a nightly today (UTC)"
    if not manual and any(payload(item).get("channel") == CHANNEL and payload(item).get("target_sha") == target
                          for item in deployments):
        return False, "automatic retry suppressed; use the manual retry after fixing the cause"
    return True, "manual retry" if manual else "new master commits"


def held_candidates(deployments, now, max_age_hours=24 * 30):
    candidates = []
    for item in deployments:
        info = payload(item)
        if (info.get("channel") != CHANNEL or item.get("latest_status") != "success"
                or info.get("proof_result") != "passed" or info.get("served_matches") is not True
                or not info.get("activated_at")):
            continue
        age = (now - timestamp(info["activated_at"])).total_seconds()
        if not 0 <= age <= max_age_hours * 3600:
            continue
        if not all(info.get(key) for key in ("run_id", "target_sha", "release_id", "set_artifact_id", "set_sha256",
                                             "manifest_artifact_id", "manifest_sha256")):
            continue
        candidates.append(item)
    return sorted(candidates, key=lambda item: (timestamp(payload(item)["activated_at"]), int(item["id"])), reverse=True)


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        redirected = super().redirect_request(request, fp, code, message, headers, new_url)
        if redirected and urlsplit(request.full_url).netloc != urlsplit(new_url).netloc:
            redirected.remove_header("Authorization")
        return redirected


class GitHub:
    def __init__(self):
        self.repository = os.environ["GITHUB_REPOSITORY"]
        self.token = os.environ["GH_TOKEN"]
        self.base = os.environ.get("GITHUB_API_URL", "https://api.github.com")

    def request(self, route, data=None, raw=False):
        url = route if route.startswith("https://") else f"{self.base}/repos/{self.repository}/{route}"
        request = urllib.request.Request(url, data=None if data is None else json.dumps(data).encode(), headers={
            "Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json",
        })
        try:
            with urllib.request.build_opener(SafeRedirect()).open(request, timeout=60) as response:
                result = response.read()
        except urllib.error.HTTPError as error:
            raise ValueError(f"GitHub {request.method} {route}: HTTP {error.code}") from None
        return result if raw else json.loads(result)

    def pages(self, route, key=None):
        page = 1
        while True:
            result = self.request(f"{route}{'&' if '?' in route else '?'}per_page=100&page={page}")
            items = result[key] if key else result
            yield from items
            if len(items) < 100:
                return
            page += 1

    def deployments(self, environment):
        result = []
        for item in self.pages(f"deployments?environment={environment}"):
            if payload(item).get("channel") not in (CHANNEL, "production-release"):
                continue
            statuses = self.request(f"deployments/{item['id']}/statuses?per_page=1")
            item["latest_status"] = statuses[0]["state"] if statuses else "pending"
            result.append(item)
        return result

    def gate(self, sha):
        require(any(run["conclusion"] == "success" and run["head_sha"] == sha and run["head_branch"] == "master"
                    and run["event"] in ("push", "schedule", "workflow_dispatch")
                    for run in self.pages(f"actions/workflows/gate.yml/runs?head_sha={sha}&status=completed", "workflow_runs")),
                "target has no successful Gate run")

    def artifact(self, run_id, artifact_id, filename, expected_hash=None):
        info = self.request(f"actions/artifacts/{artifact_id}")
        require(str(info["workflow_run"]["id"]) == str(run_id), "artifact belongs to another run")
        require(not info["expired"] and timestamp(info["expires_at"]) > datetime.now(timezone.utc), "artifact expired")
        archive = self.request(f"actions/artifacts/{artifact_id}/zip", raw=True)
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            require(zipped.namelist() == [filename], f"expected one artifact member: {filename}")
            require(zipped.getinfo(filename).file_size <= 1024 * 1024 * 1024, "artifact exceeds 1 GiB")
            data = zipped.read(filename)
        if expected_hash:
            require(digest(data) == expected_hash, f"artifact checksum mismatch: {filename}")
        return data

    def record(self, environment, sha, info, state):
        deployment = self.request("deployments", {"ref": sha, "environment": environment, "auto_merge": False,
            "required_contexts": [], "production_environment": environment == "production", "payload": info})
        self.status(deployment["id"], state)
        return deployment["id"]

    def status(self, deployment_id, state):
        self.request(f"deployments/{deployment_id}/statuses", {"state": state, "auto_inactive": False,
            "log_url": f"{os.environ['GITHUB_SERVER_URL']}/{self.repository}/actions/runs/{os.environ['GITHUB_RUN_ID']}"})


def ancestor(sha, target="origin/master"):
    subprocess.run(["git", "merge-base", "--is-ancestor", sha, target], check=True)


def outputs(values):
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as stream:
        for key, value in values.items():
            require("\n" not in str(value), "multiline workflow output")
            stream.write(f"{key}={str(value).lower() if isinstance(value, bool) else value}\n")
