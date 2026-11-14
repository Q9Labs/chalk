import contextlib
import importlib.machinery
import importlib.util
from pathlib import Path
import subprocess
import sys
import io
import json
import os
import re
import shutil
import signal
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest import mock

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

    def test_a_failing_git_command_is_named_in_the_error(self):
        args = [sys.executable, str(Path(__file__).with_name("staging-lock")), "--remote", str(Path(self.directory.name) / "missing"), "--holder", "lane-a", "--purpose", "retest", "--run-id", "run-1", "--wait", "0", "--", sys.executable, "-c", "pass"]
        result = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(result.returncode, 75)
        self.assertIn("git ls-remote failed:", result.stderr)

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
        # Only the flags before the cap matter here; the cap and the kit's arguments come from the sample count, which can come from the environment.
        flags = json.loads("[" + re.search(r'workload\(\s*"timeout",\s*\[(.*?),\s*`\$\{', source, re.S)[1] + "]")
        # Exercise the real measurement command's timeout flags, not a mirrored flag list.
        self.assert_group_stopped_before_release(cancel=False, command_prefix=["timeout", *flags, "40m"])

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

    def run_cut_acquire(self, wait, cf_ownership_seconds):
        """A cut-side acquire against a Cloudflare-style holder that releases after cf_ownership_seconds, on a mocked clock."""
        # The holder's lease runs on the real clock while the wait runs on the mocked one, so a TTL a slow
        # runner can outlast lets the cut take the lease over and the release below then conflicts.
        sha, lease, _ = self.store.acquire("nightly-cf-latency", "action-latency", "cf-run", 3600)
        started = Path(self.directory.name) / "child-started"
        clock = [0.0]
        released = []

        def sleep(seconds):
            clock[0] += seconds
            if clock[0] >= cf_ownership_seconds and not released:
                self.store.update(sha, lease)
                released.append(True)

        args = SimpleNamespace(remote=self.remote, holder="nightly-proof", purpose="camera-share", run_id="cut-run", wait=wait, ttl=180, evidence=None,
                               command=[sys.executable, "-c", f"open({str(started)!r}, 'w').close()"])
        # Swap the lock's own `time` name, not the stdlib module's functions: subprocess polls with time.sleep while a
        # loaded machine runs git, and a process-wide fake would re-enter the release above with a stale lease.
        with mock.patch.object(lock, "time", SimpleNamespace(monotonic=lambda: clock[0], sleep=sleep)), contextlib.redirect_stderr(io.StringIO()):
            status = lock.run(args)
        return status, started.exists(), clock[0]

    def test_cut_outwaits_a_cloudflare_latency_run_that_owns_the_lease_for_its_whole_step(self):
        workflow = (Path(__file__).parents[2] / ".github/workflows/real-call-proof.yml").read_text()
        wait = int(re.search(r"STAGING_LEASE_WAIT=(\d+) scripts/staging-sfu/gate-lease nightly-proof ", workflow).group(1))
        step_cap_seconds = 25 * 60
        self.assertIn("|| 25 }}", workflow)
        # The earlier 600-second wait failed here: the cut gave up while the Cloudflare run still held the lease.
        status, started, _ = self.run_cut_acquire(600, step_cap_seconds)
        self.assertEqual((status, started), (75, False))
        self.reset_remote()
        status, started, elapsed = self.run_cut_acquire(wait, step_cap_seconds)
        self.assertEqual((status, started), (0, True))
        self.assertGreaterEqual(elapsed, step_cap_seconds)

    def reset_remote(self):
        shutil.rmtree(self.remote)
        subprocess.run(["git", "init", "--quiet", "--bare", self.remote], check=True)

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


class DeployLeaseTests(unittest.TestCase):
    """The nightly managed deploy restarts API, Sync and the SFU node, so it takes the staging lease like the proofs."""

    workflows = Path(__file__).parents[2] / ".github/workflows"

    def test_nightly_deploy_waits_for_the_lease_and_production_does_not(self):
        ci = (self.workflows / "ci.yml").read_text()
        wrapped = re.search(r'if \[\[ "\$MANAGED_ENVIRONMENT" == nightly \]\]; then\n\s+#[^\n]*\n\s+(STAGING_LEASE_WAIT=\d+ scripts/staging-sfu/gate-lease [^\n]+)\n\s+else\n\s+(node scripts/deploy/deploy-managed-release.mjs "\$\{args\[@\]\}")\n', ci)
        self.assertIsNotNone(wrapped)
        self.assertEqual(wrapped[1], 'STAGING_LEASE_WAIT=1800 scripts/staging-sfu/gate-lease nightly-deploy managed-deploy "$GITHUB_RUN_ID" -- node scripts/deploy/deploy-managed-release.mjs "${args[@]}"')
        self.assertEqual(ci.count("deploy-managed-release.mjs"), ci.count("deploy-managed-release.mjs \"${args[@]}\" --dry-run") + 2)

    def test_the_deploy_checkout_keeps_no_credentials_because_staging_lock_sends_its_own(self):
        # A persisted extraheader plus the one staging-lock adds from GH_TOKEN is two Authorization headers, and GitHub rejects the request.
        ci = (self.workflows / "ci.yml").read_text()
        job = ci[ci.index("\n  deploy-managed:") :]
        checkout = job[job.index("Checkout deployment tooling") :]
        self.assertIn("persist-credentials: false", checkout[: checkout.index("- name: Setup Node")])

    def test_the_deploy_job_and_every_caller_may_write_the_lease_ref(self):
        ci = (self.workflows / "ci.yml").read_text()
        job = ci[ci.index("\n  deploy-managed:") :]
        self.assertRegex(job[: job.index("steps:")], r"permissions:\n\s+contents: write")
        # A caller cannot grant less than a called job asks for, or the whole run fails at startup.
        for name, jobs in (("nightly.yml", ["release"]), ("promote.yml", ["release", "rollback"])):
            text = (self.workflows / name).read_text()
            for job_name in jobs:
                block = text[text.index(f"\n  {job_name}:") :]
                self.assertRegex(block[: block.index("uses: ./.github/workflows/ci.yml")], r"permissions:\n\s+contents: write", f"{name} {job_name}")


class GateLeaseTests(unittest.TestCase):
    """gate-lease names why the lease stopped a gating job; staging-lock keeps the lease rules."""

    def run_gate(self, evidence, status, stderr=""):
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, directory, True)
        fake = directory / "fake-lock"
        fake.write_text(
            "#!/usr/bin/env bash\n"
            'while [ "$#" -gt 0 ]; do case "$1" in --evidence) path=$2; shift 2;; --) shift; break;; *) shift 2;; esac; done\n'
            + (f"printf '%s' '{json.dumps(evidence)}' > \"$path\"\n" if evidence is not None else "")
            + f"printf '%s\\n' '{stderr}' >&2\n"
            f"exit {status}\n"
        )
        fake.chmod(0o755)
        output, summary = directory / "output", directory / "summary"
        env = {**os.environ, "STAGING_LOCK": str(fake), "GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(summary), "STAGING_LEASE_WAIT": "30"}
        gate = Path(__file__).with_name("gate-lease")
        result = subprocess.run([str(gate), "nightly-proof", "camera-share", "42", "--", "true"], env=env, capture_output=True, text=True, timeout=10)
        return result, output.read_text() if output.exists() else "", summary.read_text() if summary.exists() else ""

    def test_a_lease_that_was_never_acquired_is_a_named_timeout(self):
        held = {"holder": "lane-a", "purpose": "retest", "run_id": "7", "token": "secret-token"}
        result, output, summary = self.run_gate({"previous": held, "acquired": False, "lost": False}, 75, "Staging SFU lease unavailable after bounded wait.")
        self.assertEqual(result.returncode, 75)
        self.assertIn("failure=staging-sfu-lease-timeout", output)
        self.assertIn("::error title=staging-sfu-lease-timeout::", result.stdout)
        self.assertIn("lane-a (retest, run 7)", result.stdout)
        self.assertIn("staging-sfu-lease-timeout", summary)
        self.assertNotIn("secret-token", result.stdout + summary)

    def test_staging_lock_failing_before_the_lease_is_not_a_timeout(self):
        # A Git failure ends staging-lock before it writes any evidence: the real error must show, not a wait that never happened.
        result, output, summary = self.run_gate(None, 75, "Staging SFU lease operation failed; workload not authorized to continue.")
        self.assertEqual(result.returncode, 75)
        self.assertIn("failure=staging-sfu-lease-error", output)
        self.assertNotIn("timeout", output + summary)
        self.assertIn("before it took the lease", result.stdout)
        self.assertIn("Staging SFU lease operation failed", result.stdout)

    def test_a_lease_lost_while_running_is_a_named_loss(self):
        result, output, _ = self.run_gate({"previous": None, "acquired": True, "lost": True}, 75)
        self.assertEqual(result.returncode, 75)
        self.assertIn("failure=staging-sfu-lease-lost", output)

    def test_an_exit_75_from_the_workload_itself_is_not_named(self):
        result, output, _ = self.run_gate({"previous": None, "acquired": True, "lost": False}, 75)
        self.assertEqual(result.returncode, 75)
        self.assertEqual(output, "")

    def test_other_statuses_pass_through(self):
        for status in (0, 1):
            result, output, _ = self.run_gate({"previous": None, "acquired": True, "lost": False}, status)
            self.assertEqual((result.returncode, output), (status, ""))


if __name__ == "__main__":
    unittest.main()
