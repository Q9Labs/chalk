import unittest

from watch_phases import ReleaseWatch, confirmed_readiness_failures


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
    def test_single_vantage_connection_loss_never_counts(self):
        sample = snapshot("new", api=None, sync=None)
        events = [{"type":"public-status","network":"air","timestamp":150,"api":{"http":None},"sync":{"http":None}},
                  {"type":"public-status","network":"instabox","timestamp":151,"api":{"http":200,"body":{"status":"ok"}},"sync":{"http":200,"body":{"status":"ready"}}}]
        watch = ReleaseWatch(target())
        self.assertFalse(watch.evaluate(sample, 152, ssm_started_at=0, stopped_at=1, events=events)["rollback"])
        watch = ReleaseWatch(target())
        watch.evaluate(snapshot("new"), 0, ssm_started_at=0, stopped_at=0)
        for at in (30,60):
            current = [{**event,"timestamp":at} for event in events]
            self.assertFalse(watch.evaluate(sample, at, events=current)["rollback"])

    def test_both_network_connection_failures_in_same_window_count(self):
        watch = ReleaseWatch(target())
        watch.evaluate(snapshot("new"),0,ssm_started_at=0,stopped_at=0)
        for at in (30,60):
            events=[{"type":"public-status","network":network,"timestamp":at,"sync":{"http":None}} for network in ("air","instabox")]
            result=watch.evaluate(snapshot("new"),at,events=events)
        self.assertTrue(result["rollback"])

    def test_http_response_or_bad_body_counts_from_one_network(self):
        for response in ({"http":503},{"http":200,"body":{"status":"not_ready"}}):
            event={"type":"public-status","network":"air","timestamp":30,"sync":response}
            self.assertTrue(confirmed_readiness_failures(snapshot("new"),30,[event])["sync"])
            self.assertFalse(confirmed_readiness_failures(snapshot("new"),60,[event],since=30)["sync"])

    def test_connection_failures_outside_same_window_do_not_count(self):
        events=[{"type":"public-status","network":"air","timestamp":0,"sync":{"http":None}},
                {"type":"public-status","network":"instabox","timestamp":31,"sync":{"http":None}}]
        self.assertFalse(confirmed_readiness_failures(snapshot("new",sync=None),31,events)["sync"])

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
