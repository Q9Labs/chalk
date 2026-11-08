import importlib.machinery
import importlib.util
from pathlib import Path
import subprocess
import sys
import json
import os
import re
import shutil
import signal
import tempfile
import time
import unittest

loader = importlib.machinery.SourceFileLoader("staging_lock", str(Path(__file__).with_name("staging-lock")))
spec = importlib.util.spec_from_loader(loader.name, loader)
lock = importlib.util.module_from_spec(spec)
loader.exec_module(lock)


class LeaseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.remote = str(Path(self.directory.name) / "remote.git")
        subprocess.run(["git", "init", "--quiet", "--bare", self.remote], check=True)
        self.store = lock.Store(self.remote)

    def test_take_held_release_and_retake(self):
        sha, lease, previous = self.store.acquire("lane-a", "retest", "run-1", 180)
        self.assertIsNone(previous)
        with self.assertRaises(lock.Held):
            self.store.acquire("lane-b", "latency", "run-2", 180)
        self.store.update(sha, lease)
        _, _, previous = self.store.acquire("lane-b", "latency", "run-2", 180)
        self.assertEqual(previous["holder"], "lane-a")

    def test_expired_takeover_cannot_be_released_by_previous_owner(self):
        sha, lease, _ = self.store.acquire("lane-a", "retest", "run-1", -1)
        self.store.acquire("lane-b", "latency", "run-2", 180)
        with self.assertRaises(lock.Conflict):
            self.store.update(sha, lease)
        self.assertEqual(self.store.read()[1]["holder"], "lane-b")

    def test_compare_and_swap_conflict_on_create_and_renew(self):
        sha, lease, _ = self.store.acquire("lane-a", "retest", "run-1", 180)
        with self.assertRaises(lock.Conflict):
            self.store.cas(None, {**lease, "holder": "lane-b"})
        self.store.update(sha, lease, 180)
        with self.assertRaises(lock.Conflict):
            self.store.update(sha, lease, 180)

    def test_wrapper_refuses_held_lease_and_releases_after_child_failure(self):
        sha, lease, _ = self.store.acquire("lane-a", "retest", "run-1", 180)
        evidence = str(Path(self.directory.name) / "evidence.json")
        args = [sys.executable, str(Path(__file__).with_name("staging-lock")), "--remote", self.remote, "--holder", "lane-b", "--purpose", "latency", "--run-id", "run-2", "--wait", "0", "--evidence", evidence, "--", sys.executable, "-c", "raise SystemExit(7)"]
        refused = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(refused.returncode, 75)
        self.assertFalse(json.loads(Path(evidence).read_text())["acquired"])
        self.store.update(sha, lease)
        result = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertTrue(json.loads(Path(evidence).read_text())["acquired"])
        self.assertEqual(self.store.read()[1]["holder"], "lane-b")
        self.store.acquire("lane-c", "retest", "run-3", 180)

    def test_cancellation_stops_entire_group_before_release(self):
        self.assert_group_stopped_before_release(cancel=True)

    def test_renewal_failure_stops_entire_group_before_release(self):
        self.assert_group_stopped_before_release(cancel=False)

    def test_measurement_timeout_stops_with_lease_before_release(self):
        source = (Path(__file__).resolve().parents[2] / "features/scorecard/staging-latency.mjs").read_text()
        args = json.loads(re.search(r'workload\("timeout", (\[[^\n]*?\]),', source)[1])
        # Exercise the real measurement command's timeout options, not a mirrored flag list.
        self.assert_group_stopped_before_release(cancel=False, command_prefix=["timeout", *args[:args.index("pnpm")]])

    def assert_group_stopped_before_release(self, cancel, command_prefix=()):
        directory = Path(self.directory.name)
        pids = directory / "pids.json"
        ready = directory / "grandchild-ready"
        audit = directory / "release.json"
        hook = Path(self.remote) / "hooks/pre-receive"
        hook.write_text("#!" + sys.executable + "\n" + f'''
import datetime as dt
import json
from pathlib import Path
import subprocess
import sys
old, new, ref = sys.stdin.read().split()
lease = json.loads(subprocess.check_output(["git", "show", new + ":lease.json"]))
expired = dt.datetime.fromisoformat(lease["expires_at"].replace("Z", "+00:00")) <= dt.datetime.now(dt.timezone.utc)
if expired:
    states = [subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True).stdout.strip() for pid in json.loads(Path({str(pids)!r}).read_text())]
    Path({str(audit)!r}).write_text(json.dumps(states))
    sys.exit(0 if all(not state or state.startswith(("Z", "X")) for state in states) else 1)
if old != "0" * 40 and {not cancel!r}:
    previous = json.loads(subprocess.check_output(["git", "show", old + ":lease.json"]))
    if previous["token"] == lease["token"]:
        sys.exit(1)  # Reject renewal, but allow release and the next holder.
''')
        hook.chmod(0o755)
        grandchild = f'''
import os, signal, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
Path({str(ready)!r}).write_text(str(os.getpid()))
time.sleep(120)
'''
        workload = f'''
import json, os, subprocess, sys, time
from pathlib import Path
subprocess.Popen([sys.executable, "-c", {grandchild!r}], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
while not Path({str(ready)!r}).exists():
    time.sleep(0.01)
Path({str(pids)!r}).write_text(json.dumps([os.getpid(), int(Path({str(ready)!r}).read_text())]))
time.sleep(120)
'''
        command = [sys.executable, "-c", workload]
        if command_prefix:
            # Match the leased orchestrator -> timeout -> kit nesting, not timeout as group leader.
            command = [sys.executable, "-c", f"import subprocess; raise SystemExit(subprocess.call({[*command_prefix, *command]!r}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))"]
        wrapper = subprocess.Popen([sys.executable, str(Path(__file__).with_name("staging-lock")), "--remote", self.remote, "--holder", "lane-a", "--purpose", "latency", "--run-id", "run-1", "--ttl", "60", "--wait", "0", "--", *command], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 5
            while not pids.exists() and wrapper.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(pids.exists(), "workload and grandchild did not start")
            if cancel:
                wrapper.send_signal(signal.SIGTERM)
            _, stderr = wrapper.communicate(timeout=15 if cancel else 40)
            self.assertEqual(wrapper.returncode, 75, stderr)
            self.assertTrue(audit.exists(), stderr)
            self.assertTrue(all(not state or state.startswith(("Z", "X")) for state in json.loads(audit.read_text())), "lease released before the entire workload stopped")
            self.store.acquire("next-lane", "retest", "run-2", 180)
        finally:
            if pids.exists():
                for pid in json.loads(pids.read_text()):
                    try:
                        group = os.getpgid(pid)
                        if group != os.getpgrp():
                            os.killpg(group, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            if wrapper.poll() is None:
                wrapper.kill()
            wrapper.communicate()

    def test_workflow_cleanup_deletes_own_resources_while_another_lane_holds_lease(self):
        held, _, _ = self.store.acquire("other-lane", "soak", "other-run", 180)
        root = Path(__file__).resolve().parents[2]
        work = Path(self.directory.name) / "work"
        work.mkdir()
        subprocess.run(["git", "init", "--quiet", str(work)], check=True)
        subprocess.run(["git", "-C", str(work), "remote", "add", "origin", self.remote], check=True)
        (work / "scripts/staging-sfu").mkdir(parents=True)
        (work / "scripts/staging-sfu/staging-lock").symlink_to(root / "scripts/staging-sfu/staging-lock")
        (work / ".private").mkdir()
        (work / ".private/proof-run-ids").write_text("finished-run\n")
        tools = work / "bin"
        tools.mkdir()
        pnpm = tools / "pnpm"
        pnpm.write_text("#!" + shutil.which("node") + "\n" + r'''
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { cleanupByRunId } from "CLEANUP_MODULE";
assert.deepEqual(process.argv.slice(2), ["prod:proof", "cleanup", "finished-run"]);
const own = { id: "own-space", name: "chalk-proof:finished-run", metadata: { proof_run_id: "finished-run" }, archived: false };
const foreign = { id: "foreign-space", name: "chalk-proof:other-run", metadata: { proof_run_id: "other-run" }, archived: false };
const episode = { id: "own-episode", status: "active", metadata: { proof_run_id: "finished-run" } };
const foreignEpisode = { id: "foreign-episode", status: "active", metadata: { proof_run_id: "other-run" } };
const base = "/v1/tenants/test";
globalThis.fetch = async (url, { method }) => {
  const path = new URL(url).pathname;
  if (process.env.CLEANUP_FAIL === "1" && method === "POST") return Response.json({ error: { code: "cleanup.failed" } }, { status: 503 });
  let value;
  if (method === "GET" && path === `${base}/spaces`) value = { spaces: [own, foreign], pagination: { next_cursor: "" } };
  else if (method === "GET" && path === `${base}/spaces/${own.id}/episodes`) value = { episodes: [episode], pagination: { next_cursor: "" } };
  else if (method === "POST" && path === `${base}/spaces/${own.id}/episodes/${episode.id}/end`) { episode.status = "ended"; value = {}; }
  else if (method === "GET" && path === `${base}/spaces/${own.id}/episodes/${episode.id}`) value = episode;
  else if (method === "GET" && path === `${base}/transcripts`) value = { transcripts: [], pagination: { next_cursor: "" } };
  else if (method === "POST" && path === `${base}/spaces/${own.id}/archive`) { own.archived = true; value = {}; }
  else if (method === "GET" && path === `${base}/spaces/${own.id}`) value = own;
  else throw new Error(`Unexpected cleanup request: ${method} ${path}`);
  return Response.json(value);
};
await cleanupByRunId({ tenant_id: "test", api_key: "test", api_url: "https://cleanup.invalid", web_url: "https://proof.invalid" }, "finished-run");
await writeFile("result.json", JSON.stringify({ own, foreign, episode, foreignEpisode }));
'''.replace("CLEANUP_MODULE", (root / "scripts/prod-proof/cleanup.mjs").as_uri()))
        pnpm.chmod(0o755)
        workflow = (root / ".github/workflows/real-call-proof.yml").read_text()
        step = workflow.split("      - name: Clean proof runs\n", 1)[1].split("      - name:", 1)[0]
        script = "\n".join(line[10:] for line in step.split("        run: |\n", 1)[1].splitlines())
        env = {**os.environ, "PATH": f"{tools}{os.pathsep}{os.environ['PATH']}", "STAGING_SFU_PROOF": "true", "RUN_PREFIX": "finished-run"}
        child = subprocess.Popen(["bash", "-c", script], cwd=work, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            stdout, stderr = child.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.communicate()
            self.fail("Cleanup was blocked by another lane's staging lease")
        self.assertEqual(child.returncode, 0, stdout + stderr)
        state = json.loads((work / "result.json").read_text())
        self.assertEqual(state["episode"]["status"], "ended")
        self.assertTrue(state["own"]["archived"])
        self.assertFalse(state["foreign"]["archived"])
        self.assertEqual(state["foreignEpisode"]["status"], "active")
        self.assertEqual(self.store.read()[0], held)
        failed = subprocess.run(["bash", "-c", script], cwd=work, env={**env, "CLEANUP_FAIL": "1"}, capture_output=True, text=True, timeout=5)
        self.assertEqual(failed.returncode, 1)
        self.assertIn("Remote cleanup failed", failed.stderr)
        self.assertEqual(self.store.read()[0], held)


if __name__ == "__main__":
    unittest.main()
