import unittest

from watch_phases import ReleaseWatch


def snapshot(revision="old", api=200, sync=200):
    return {
        "release_id": revision + "-release",
        "api": {"http": api, "body": {"status": "ok"}},
        "sync": {"http": sync, "body": {"status": "ready"}},
        "component_releases": {name: {"source_revision": revision, "release_id": revision + "-" + name} for name in ("api", "sync")},
        "containers": {"chalk-" + name: {"revision": revision, "image": revision + "-" + name} for name in ("api", "sync")},
    }

def target():
    value = snapshot("new")
    return {**value, "images": {name: "new-" + name for name in ("api", "sync")}}


class ReleaseWatchTest(unittest.TestCase):
    def test_old_readiness_failure_holds_without_rollback(self):
        watch = ReleaseWatch(target())
        for at in (0, 30, 60):
            result = watch.evaluate(snapshot(sync=503), at)
            self.assertTrue(result["hold"])
            self.assertFalse(result["rollback"])

    def test_swap_timeout_begins_at_deliberate_stop_not_ssm_start(self):
        watch = ReleaseWatch(target())
        self.assertFalse(watch.evaluate(snapshot(sync=503), 200, ssm_started_at=0)["rollback"])
        self.assertFalse(watch.evaluate(snapshot(sync=503), 320, stopped_at=200)["rollback"])
        self.assertTrue(watch.evaluate(snapshot(sync=503), 321)["rollback"])

    def test_watch_requires_both_new_identities_and_readiness(self):
        watch = ReleaseWatch(target())
        self.assertEqual(watch.evaluate(snapshot(), 1, ssm_started_at=0, stopped_at=0)["phase"], "swap")
        self.assertEqual(watch.evaluate(snapshot("new", sync=503), 2)["phase"], "swap")
        mixed = snapshot("new")
        mixed["containers"]["chalk-sync"]["revision"] = "old"
        self.assertEqual(watch.evaluate(mixed, 2.5)["phase"], "swap")
        self.assertEqual(watch.evaluate(snapshot("new"), 3)["watch_started_at"], 3)

    def test_one_second_sampling_does_not_accelerate_rollback(self):
        watch = ReleaseWatch(target())
        watch.evaluate(snapshot("new"), 0, ssm_started_at=0, stopped_at=0)
        for at in range(1, 60):
            self.assertFalse(watch.evaluate(snapshot("new", sync=503), at)["rollback"])
        self.assertTrue(watch.evaluate(snapshot("new", sync=503), 60)["rollback"])

    def test_watch_waits_for_new_web_without_treating_ready_backend_as_down(self):
        watch = ReleaseWatch(target())
        result = watch.evaluate(snapshot("new"), 150, ssm_started_at=0, stopped_at=1, web_ready=False)
        self.assertEqual(result["phase"], "swap")
        self.assertFalse(result["rollback"])
        self.assertEqual(watch.evaluate(snapshot("new"), 160, web_ready=True)["watch_started_at"], 160)

    def test_successful_sample_resets_consecutive_failures(self):
        watch = ReleaseWatch(target())
        watch.evaluate(snapshot("new"), 0, ssm_started_at=0, stopped_at=0)
        watch.evaluate(snapshot("new", sync=503), 30)
        watch.evaluate(snapshot("new"), 60)
        self.assertFalse(watch.evaluate(snapshot("new", sync=503), 90)["rollback"])

    def test_failed_call_rolls_back_immediately_only_during_watch(self):
        event = {"type": "checkpoint", "pass": False, "timestamp": 5}
        watch = ReleaseWatch(target())
        self.assertTrue(watch.evaluate(snapshot(), 5, events=[event])["hold"])
        self.assertFalse(watch.evaluate(snapshot(), 6, ssm_started_at=6, events=[event])["rollback"])
        watch.evaluate(snapshot("new"), 7, stopped_at=6)
        self.assertFalse(watch.evaluate(snapshot("new"), 8, events=[event])["rollback"])
        self.assertTrue(watch.evaluate(snapshot("new"), 9, events=[{**event, "timestamp": 9}])["rollback"])

    def test_same_revision_does_not_start_watch_before_cutover(self):
        watch = ReleaseWatch(target())
        self.assertEqual(watch.evaluate(snapshot("new"), 0, ssm_started_at=0)["phase"], "swap")
        self.assertFalse(watch.evaluate(snapshot("new", sync=503), 60, stopped_at=1)["rollback"])
        self.assertEqual(watch.evaluate(snapshot("new"), 80)["phase"], "watch")

    def test_unchanged_component_matches_its_own_target_identity(self):
        manifest = target()
        old = snapshot()
        manifest["component_releases"]["api"] = old["component_releases"]["api"]
        manifest["images"]["api"] = "old-api"
        sample = snapshot("new")
        sample["component_releases"]["api"] = old["component_releases"]["api"]
        sample["containers"]["chalk-api"] = old["containers"]["chalk-api"]
        watch = ReleaseWatch(manifest)
        self.assertEqual(watch.evaluate(sample, 2, ssm_started_at=0, stopped_at=1)["phase"], "watch")


if __name__ == "__main__":
    unittest.main()
