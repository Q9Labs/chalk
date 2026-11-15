import unittest
from pathlib import Path

import provision

class MonitorDefinitions(unittest.TestCase):
    def test_every_rule_branch_is_joined_and_each_windowed_rule_leaves_the_generic_query(self):
        query = provision.monitor_definitions({"LOG_DATASET": "logs", "TRACE_DATASET": "traces"})[0]["aplQuery"]
        self.assertEqual(query.count(" | union (\n"), len(provision.RULE_BRANCHES) + 1)
        for _, rules in provision.RULE_BRANCHES:
            for rule in rules:
                self.assertIn(f"chalk_alert_rule != '{rule}'", query)
                self.assertIn(f"'{rule}'", query.split(" | union (\n", 1)[1])

    def test_every_rule_the_collector_writes_for_readiness_is_read_by_its_query_and_watched_for_staleness(self):
        monitors = provision.monitor_definitions({"LOG_DATASET": "logs", "TRACE_DATASET": "traces"})
        stale = monitors[2]["aplQuery"]
        for rule in ("sync-readiness", "database-unreachable", "runtime-health"):
            self.assertIn(f"'{rule}'", stale)
        self.assertEqual(monitors[2]["operator"], "Above")
        self.assertTrue(monitors[2]["notifyByGroup"])

    def test_the_readiness_query_judges_each_rule_on_its_own_samples(self):
        query = Path(provision.__file__).with_name("readiness.apl").read_text()
        self.assertIn("by chalk_alert_rule, probe_minute", query)
        self.assertIn("by chalk_alert_rule\n", query)
        self.assertIn("bin(now(), 30m)", query)


def live(monitors, notifier_ids):
    return [{**monitor, "notifierIds": notifier_ids} for monitor in monitors]


class MonitorDrift(unittest.TestCase):
    def setUp(self):
        self.expected = provision.monitor_definitions({"LOG_DATASET": "logs", "TRACE_DATASET": "traces"})

    def test_monitors_with_no_notifier_match(self):
        self.assertEqual(provision.monitor_drift(self.expected, live(self.expected, [])), [])
        self.assertEqual(provision.monitor_drift(self.expected, [{**monitor} for monitor in self.expected]), [])

    def test_the_definitions_reference_no_notifier(self):
        self.assertTrue(all("notifierIds" not in monitor for monitor in self.expected))
        source = Path(provision.__file__).read_text().lower()
        for word in ("discord", "oncall", "slack", "whatsapp"):
            self.assertNotIn(word, source)

    def test_a_changed_query_threshold_or_flag_is_named(self):
        changed = live(self.expected, [])
        changed[0]["aplQuery"] += " | take 1"
        changed[1]["threshold"] = 99
        changed[2]["alertOnNoData"] = not changed[2]["alertOnNoData"]
        self.assertEqual(
            provision.monitor_drift(self.expected, changed),
            [f"{self.expected[0]['name']}: aplQuery differs", f"{self.expected[1]['name']}: threshold differs", f"{self.expected[2]['name']}: alertOnNoData differs"],
        )

    def test_whitespace_in_the_query_is_not_drift(self):
        spaced = live(self.expected, [])
        spaced[0]["aplQuery"] = spaced[0]["aplQuery"].replace(" | ", "\n| ")
        self.assertEqual(provision.monitor_drift(self.expected, spaced), [])

    def test_a_missing_monitor_and_an_attached_notifier_are_named(self):
        deployed = live(self.expected, [])[:2]
        deployed[0]["notifierIds"] = ["n1"]
        problems = provision.monitor_drift(self.expected, deployed)
        self.assertEqual(problems, [f"{self.expected[0]['name']}: a notifier is attached", f"{self.expected[2]['name']}: missing"])


if __name__ == "__main__":
    unittest.main()
