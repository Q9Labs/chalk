import importlib.machinery
import importlib.util
from pathlib import Path
import subprocess
import sys
import json
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


if __name__ == "__main__":
    unittest.main()
