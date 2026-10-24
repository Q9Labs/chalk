import unittest

from watch_phases import ReleaseWatch


def snapshot(revision="old", api=200, sync=200):
    return {
        "api": {"http": api, "body": {"status": "ok"}},
        "sync": {"http": sync, "body": {"status": "ready"}},
        "component_releases": {name: {"source_revision": revision} for name in ("api", "sync")},
        "containers": {"chalk-" + name: {"revision": revision} for name in ("api", "sync")},
    }


class ReleaseWatchTest(unittest.TestCase):
    def test_old_readiness_failure_holds_without_rollback(self):
        watch = ReleaseWatch("new")
        for at in (0, 30, 60):
            result = watch.evaluate(snapshot(sync=503), at)
            self.assertTrue(result["hold"])
            self.assertFalse(result["rollback"])

    def test_swap_timeout_begins_at_deliberate_stop_not_ssm_start(self):
        watch = ReleaseWatch("new")
        self.assertFalse(watch.evaluate(snapshot(sync=503), 200, ssm_started_at=0)["rollback"])
        self.assertFalse(watch.evaluate(snapshot(sync=503), 320, stopped_at=200)["rollback"])
        self.assertTrue(watch.evaluate(snapshot(sync=503), 321)["rollback"])

    def test_watch_requires_both_new_identities_and_readiness(self):
        watch = ReleaseWatch("new")
        self.assertEqual(watch.evaluate(snapshot(), 1, ssm_started_at=0)["phase"], "swap")
        self.assertEqual(watch.evaluate(snapshot("new", sync=503), 2)["phase"], "swap")
        mixed = snapshot("new")
        mixed["containers"]["chalk-sync"]["revision"] = "old"
        self.assertEqual(watch.evaluate(mixed, 2.5)["phase"], "swap")
        self.assertEqual(watch.evaluate(snapshot("new"), 3)["watch_started_at"], 3)

    def test_one_second_sampling_does_not_accelerate_rollback(self):
        watch = ReleaseWatch("new")
        watch.evaluate(snapshot("new"), 0, ssm_started_at=0)
        for at in range(1, 60):
            self.assertFalse(watch.evaluate(snapshot("new", sync=503), at)["rollback"])
        self.assertTrue(watch.evaluate(snapshot("new", sync=503), 60)["rollback"])

    def test_successful_sample_resets_consecutive_failures(self):
        watch = ReleaseWatch("new")
        watch.evaluate(snapshot("new"), 0, ssm_started_at=0)
        watch.evaluate(snapshot("new", sync=503), 30)
        watch.evaluate(snapshot("new"), 60)
        self.assertFalse(watch.evaluate(snapshot("new", sync=503), 90)["rollback"])

    def test_failed_call_rolls_back_immediately_only_during_watch(self):
        event = {"type": "checkpoint", "pass": False, "timestamp": 5}
        watch = ReleaseWatch("new")
        self.assertTrue(watch.evaluate(snapshot(), 5, events=[event])["hold"])
        self.assertFalse(watch.evaluate(snapshot(), 6, ssm_started_at=6, events=[event])["rollback"])
        watch.evaluate(snapshot("new"), 7)
        self.assertFalse(watch.evaluate(snapshot("new"), 8, events=[event])["rollback"])
        self.assertTrue(watch.evaluate(snapshot("new"), 9, events=[{**event, "timestamp": 9}])["rollback"])


if __name__ == "__main__":
    unittest.main()
