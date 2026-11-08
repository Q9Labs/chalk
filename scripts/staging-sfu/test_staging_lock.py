import importlib.machinery
import importlib.util
from pathlib import Path
import subprocess
import sys
import json
import os
import shutil
import signal
import tempfile
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
