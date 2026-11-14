import unittest
from pathlib import Path

import provision

ONCALL = {"id": "n2", "name": provision.ONCALL_NOTIFIER}
OTHER = {"id": "n1", "name": "Chalk production Discord"}


class KeptOncallIds(unittest.TestCase):
    def test_apply_without_the_url_keeps_an_existing_oncall_notifier(self):
        self.assertEqual(provision.kept_oncall_ids([OTHER, ONCALL], detach=False), ["n2"])

    def test_no_oncall_notifier_means_none_attached(self):
        self.assertEqual(provision.kept_oncall_ids([OTHER], detach=False), [])

    def test_detach_removes_it_on_request_only(self):
        self.assertEqual(provision.kept_oncall_ids([OTHER, ONCALL], detach=True), [])


class MonitorDefinitions(unittest.TestCase):
    def test_every_rule_branch_is_joined_and_each_windowed_rule_leaves_the_generic_query(self):
        query = provision.monitor_definitions({"LOG_DATASET": "logs", "TRACE_DATASET": "traces"})[0]["aplQuery"]
        self.assertEqual(query.count(" | union (\n"), len(provision.RULE_BRANCHES) + 1)
        for _, rule in provision.RULE_BRANCHES:
            if rule:
                self.assertIn(f"chalk_alert_rule != '{rule}'", query)
                self.assertIn(f"chalk_alert_rule == '{rule}'", query)


if __name__ == "__main__":
    unittest.main()
