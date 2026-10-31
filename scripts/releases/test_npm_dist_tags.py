"""Retain and restore npm latest tags during production promotion."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import npm_dist_tags

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/releases/npm_dist_tags.py"


class NpmDistTagTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.state_path = self.root / "state.json"
        self.summary = self.root / "summary.md"
        self.write_executable("npm", """#!/usr/bin/env python3
import json
import os
import sys

path = os.environ["FAKE_NPM_STATE"]
with open(path, encoding="utf-8") as state_file:
    state = json.load(state_file)
args = sys.argv[1:]
state.setdefault("npm_calls", []).append(args)

def save():
    with open(path, "w", encoding="utf-8") as state_file:
        json.dump(state, state_file)

if args[0] == "view":
    package = args[1]
    state.setdefault("latest_reads", []).append([package, state["latest"].get(package)])
    for event in state.get("publish_events", []):
        if event["after_reads"] == len(state["latest_reads"]):
            state.setdefault("publish_runs", []).append(event["run"])
            state.setdefault("watch_updates_by_run", {})[str(event["run"]["databaseId"])] = event["tags_after_publish"]
    if package not in state["latest"] or state["latest"][package] is None:
        print("E404", file=sys.stderr)
        save()
        sys.exit(1)
    print(json.dumps(state["latest"][package]))
elif args[:2] == ["dist-tag", "add"]:
    package, version = args[2].rsplit("@", 1)
    if state.get("fail_dist_tag_add"):
        save()
        sys.exit(1)
    state["latest"][package] = version
    save()
else:
    save()
    sys.exit(2)
save()
""")
        self.write_executable("gh", """#!/usr/bin/env python3
import json
import os
import sys

path = os.environ["FAKE_NPM_STATE"]
with open(path, encoding="utf-8") as state_file:
    state = json.load(state_file)
args = sys.argv[1:]
state.setdefault("gh_calls", []).append(args)

def save():
    with open(path, "w", encoding="utf-8") as state_file:
        json.dump(state, state_file)

if args[:2] == ["run", "list"]:
    print(json.dumps(state.get("publish_runs", [])))
elif args[:2] == ["run", "watch"]:
    run_id = args[2]
    for run in state.get("publish_runs", []):
        if str(run.get("databaseId")) == run_id:
            updates = state.get("watch_updates_by_run", {}).get(run_id, state.get("watch_updates", {}))
            state["latest"].update(updates)
            run["status"] = "completed"
    save()
else:
    save()
    sys.exit(2)
save()
""")

    def write_executable(self, name, content):
        executable = self.bin / name
        executable.write_text(content)
        executable.chmod(0o755)

    def write_state(self, state):
        self.state_path.write_text(json.dumps(state))

    def read_state(self):
        return json.loads(self.state_path.read_text())

    def environment(self, **values):
        return {
            **os.environ,
            "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
            "FAKE_NPM_STATE": str(self.state_path),
            "GITHUB_REPOSITORY": "example/repository",
            **values,
        }

    def run_restore(self, previous, state):
        self.write_state(state)
        environment = self.environment(
            PREVIOUS_NPM_LATEST=json.dumps(previous, separators=(",", ":")),
            GITHUB_STEP_SUMMARY=str(self.summary),
        )
        return subprocess.run(
            [sys.executable, str(SCRIPT), "restore"],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
        )

    def run_retain(self, packages, state):
        self.write_state(state)
        output = self.root / "previous-npm.json"
        github_output = self.root / "github-output"
        with patch.object(npm_dist_tags, "package_names", return_value=packages), patch.dict(
            os.environ,
            self.environment(GITHUB_OUTPUT=str(github_output)),
        ):
            return npm_dist_tags.retain(output)

    @staticmethod
    def dist_tag_calls(state):
        return [call for call in state["npm_calls"] if call[:2] == ["dist-tag", "add"]]

    def test_retain_records_latest_tags_and_null_for_a_404(self):
        self.write_state({"latest": {"package-one": "1.2.3"}, "npm_calls": []})
        output = self.root / "previous-npm.json"
        github_output = self.root / "github-output"
        with patch.object(npm_dist_tags, "package_names", return_value=["package-one", "package-missing"]), patch.dict(
            os.environ,
            self.environment(GITHUB_OUTPUT=str(github_output)),
        ):
            retained = npm_dist_tags.retain(output)
        expected = {"package-one": "1.2.3", "package-missing": None}
        self.assertEqual(retained, expected)
        self.assertEqual(json.loads(output.read_text()), expected)
        self.assertIn(f'npm_latest={json.dumps(expected, separators=(",", ":"))}', github_output.read_text())

    def test_retain_waits_for_publish_before_reading_all_tags(self):
        previous = {"package-a": "1.0.0", "package-b": "2.0.0"}
        after_publish = {"package-a": "1.1.0", "package-b": "2.1.0"}
        state = {
            "latest": previous.copy(),
            "npm_calls": [],
            "publish_runs": [{"databaseId": 123, "status": "in_progress"}],
            "watch_updates": after_publish,
        }
        retained = self.run_retain(list(previous), state)
        updated = self.read_state()
        self.assertEqual(retained, after_publish)
        self.assertEqual(updated["latest_reads"], [[package, version] for package, version in after_publish.items()])
        self.assertIn(["run", "watch", "123"], updated["gh_calls"])

    def test_retain_rereads_all_tags_when_publish_starts_during_snapshot(self):
        previous = {"package-a": "1.0.0", "package-b": "2.0.0"}
        after_publish = {"package-a": "1.1.0", "package-b": "2.1.0"}
        state = {
            "latest": previous.copy(),
            "npm_calls": [],
            "publish_events": [
                {
                    "after_reads": 2,
                    "run": {"databaseId": 124, "status": "in_progress"},
                    "tags_after_publish": after_publish,
                }
            ],
        }
        retained = self.run_retain(list(previous), state)
        updated = self.read_state()
        self.assertEqual(retained, after_publish)
        self.assertEqual(
            updated["latest_reads"],
            [[package, version] for package, version in previous.items()]
            + [[package, version] for package, version in after_publish.items()],
        )
        self.assertIn(["run", "watch", "124"], updated["gh_calls"])

    def test_retain_fails_when_publish_runs_keep_starting_during_snapshot(self):
        previous = {"package-a": "1.0.0", "package-b": "2.0.0"}
        after_publish = {"package-a": "1.1.0", "package-b": "2.1.0"}
        state = {
            "latest": previous.copy(),
            "npm_calls": [],
            "publish_events": [
                {
                    "after_reads": count,
                    "run": {"databaseId": 200 + count, "status": "in_progress"},
                    "tags_after_publish": after_publish,
                }
                for count in (2, 4, 6, 8)
            ],
        }
        with self.assertRaisesRegex(RuntimeError, "did not stabilize"):
            self.run_retain(list(previous), state)
        updated = self.read_state()
        self.assertEqual(len(updated["latest_reads"]), 8)
        self.assertEqual(len([call for call in updated["gh_calls"] if call[:2] == ["run", "watch"]]), 3)

    def test_read_latest_does_not_treat_bare_404_as_unpublished(self):
        result = subprocess.CompletedProcess([], 1, "", "HTTP 404")
        with patch.object(npm_dist_tags.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "npm view failed"):
                npm_dist_tags.read_latest("package-one")

    def test_restore_only_adds_tags_that_moved(self):
        previous = {"package-one": "1.0.0", "package-two": "2.0.0"}
        state = {"latest": {"package-one": "1.0.0", "package-two": "2.1.0"}, "npm_calls": []}
        result = self.run_restore(previous, state)
        self.assertEqual(result.returncode, 0, result.stderr)
        updated = self.read_state()
        self.assertEqual(self.dist_tag_calls(updated), [["dist-tag", "add", "package-two@2.0.0", "latest"]])
        self.assertEqual(updated["latest"], previous)
        self.assertIn("| Package | Previous | Found | Action |", self.summary.read_text())

    def test_restore_does_not_add_tags_when_nothing_moved(self):
        previous = {"package-one": "1.0.0", "package-two": "2.0.0"}
        state = {"latest": previous.copy(), "npm_calls": []}
        result = self.run_restore(previous, state)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.dist_tag_calls(self.read_state()), [])

    def test_restore_waits_for_in_progress_publish_before_restoring(self):
        previous = {"package-one": "1.0.0"}
        state = {
            "latest": previous.copy(),
            "npm_calls": [],
            "publish_runs": [{"databaseId": 123, "status": "in_progress"}],
            "watch_updates": {"package-one": "1.1.0"},
        }
        result = self.run_restore(previous, state)
        self.assertEqual(result.returncode, 0, result.stderr)
        updated = self.read_state()
        self.assertEqual(updated["latest"], previous)
        self.assertEqual(updated["gh_calls"][0][:3], ["run", "list", "--workflow"])
        self.assertIn(["run", "watch", "123"], updated["gh_calls"])
        self.assertEqual(self.dist_tag_calls(updated), [["dist-tag", "add", "package-one@1.0.0", "latest"]])

    def test_restore_reproduces_publish_finishing_during_promotion_rollback(self):
        incident = json.loads((ROOT / "scripts/releases/fixtures/npm-promotion-rollback.json").read_text())
        previous = incident["previous_tags"]
        result = self.run_restore(
            previous,
            {
                "latest": previous.copy(),
                "npm_calls": [],
                "publish_runs": [incident["publish_run"]],
                "watch_updates": incident["tags_after_publish"],
            },
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        updated = self.read_state()
        expected_calls = [["dist-tag", "add", f"{package}@{version}", "latest"] for package, version in previous.items()]
        self.assertEqual(self.dist_tag_calls(updated), expected_calls)
        self.assertEqual(updated["latest"], previous)

    def test_failing_dist_tag_add_returns_nonzero(self):
        result = self.run_restore(
            {"package-one": "1.0.0"},
            {"latest": {"package-one": "1.1.0"}, "npm_calls": [], "fail_dist_tag_add": True},
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("npm dist-tag add failed", result.stderr)

    def test_null_previous_latest_is_skipped(self):
        result = self.run_restore(
            {"package-one": None},
            {"latest": {"package-one": "1.1.0"}, "npm_calls": []},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.read_state()["npm_calls"], [])
        self.assertIn("skipped (no previous latest)", self.summary.read_text())

    def test_workflow_retains_npm_before_artifact_and_gates_recovery_on_rollback(self):
        workflow = (ROOT / ".github/workflows/promote.yml").read_text()
        approve = workflow.split("  approve:\n", 1)[1].split("  release:\n", 1)[0]
        retain = approve.index("Retain the live npm latest tags before the first promotion changes them")
        artifact = approve.index("uses: actions/upload-artifact@")
        retain_step = approve[retain:].split("      - name:", 1)[0]
        self.assertLess(retain, artifact)
        self.assertIn("GH_TOKEN: ${{ github.token }}", retain_step)
        self.assertIn("pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1", approve[:retain])
        self.assertIn("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020", approve[:retain])
        self.assertNotIn("registry-url:", approve[:retain])
        self.assertIn("npm_latest: ${{ steps.npm.outputs.npm_latest }}", approve)
        self.assertIn('--argjson npm "$(cat previous-npm.json)"', approve)
        self.assertIn("npm_latest:$npm", approve)
        self.assertIn("previous-npm.json", approve[artifact:])

        rollback = workflow.split("  rollback:\n", 1)[1].split("  rollback-npm:\n", 1)[0]
        rollback_npm = workflow.split("  rollback-npm:\n", 1)[1].split("  result:\n", 1)[0]
        rollback_condition = rollback.split("    if: >-\n", 1)[1].split("    uses: ./.github/workflows/ci.yml", 1)[0]
        npm_condition = rollback_npm.split("    if: >-\n", 1)[1].split("    runs-on:", 1)[0]
        self.assertEqual(rollback_condition, npm_condition)
        self.assertIn("needs: [select, approve, release, proof, rollback]", rollback_npm)
        self.assertIn("timeout-minutes: 45", rollback_npm)
        self.assertIn("registry-url: https://registry.npmjs.org/", rollback_npm)
        self.assertIn("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}", rollback_npm)
        self.assertEqual(re.findall(r"secrets\.([A-Za-z0-9_]+)", rollback_npm), ["NPM_TOKEN"])
        result = workflow.split("  result:\n", 1)[1].split("  github-release:\n", 1)[0]
        self.assertIn("needs: [select, approve, release, proof, rollback, rollback-npm]", result)
        self.assertIn("NPM_ROLLBACK_RESULT: ${{ needs.rollback-npm.result }}", result)
        self.assertIn("os.environ.get('NPM_ROLLBACK_RESULT') == 'success'", result)


if __name__ == "__main__":
    unittest.main()
