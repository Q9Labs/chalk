"""Offline provisioning tests and optional read-only Axiom query proof.

Run --live with AXIOM_TOKEN and AXIOM_ORG_ID to evaluate synthetic datatables.
No events, monitors or notifiers are written.
"""

import json
import os
from pathlib import Path
import sys
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from provision import monitor_definitions


VARIABLES = {"LOG_DATASET": "fixture-logs", "TRACE_DATASET": "fixture-traces"}
LIVE = "--live" in sys.argv
if LIVE:
    sys.argv.remove("--live")


class MonitorTests(unittest.TestCase):
    def test_connection_rules_keep_existing_monitor_budget_and_thresholds(self):
        monitors = monitor_definitions(VARIABLES)
        self.assertEqual(len(monitors), 3)
        report_monitor = monitors[0]
        self.assertEqual(report_monitor["operator"], "Above")
        self.assertEqual(report_monitor["threshold"], 0)
        self.assertEqual(report_monitor["intervalMinutes"], 1)
        self.assertEqual(report_monitor["rangeMinutes"], 10)
        self.assertEqual(report_monitor["triggerFromNRuns"], 1)
        self.assertEqual(report_monitor["triggerAfterNPositiveResults"], 1)
        self.assertTrue(report_monitor["notifyByGroup"])
        self.assertFalse(report_monitor["notifyEveryRun"])
        self.assertFalse(report_monitor["alertOnNoData"])
        self.assertIn("sdk.connection_report", report_monitor["aplQuery"])
        self.assertNotIn("${", report_monitor["aplQuery"])
        self.assertEqual(monitors[1]["threshold"], 30)
        self.assertEqual(monitors[1]["triggerAfterNPositiveResults"], 5)
        self.assertTrue(monitors[2]["alertOnNoData"])

    def test_selective_undo_preserves_all_previous_queries_and_notifier_route(self):
        definitions = json.loads(Path(__file__).with_name("monitors.json").read_text())
        rollback = monitor_definitions(VARIABLES, without_connection_reports=True)
        for before, after in zip(definitions, rollback):
            expected = before["aplQuery"].replace("${CONNECTION_REPORT_BRANCH}", "")
            for key, value in VARIABLES.items():
                expected = expected.replace("${" + key + "}", value)
            self.assertEqual(after["aplQuery"], expected)
            self.assertFalse(after["disabled"])
        self.assertEqual(rollback[1:], monitor_definitions(VARIABLES)[1:])

    @unittest.skipUnless(LIVE, "use --live for read-only Axiom execution")
    def test_real_apl_single_failures_deduplication_noise_and_pkt_rollover(self):
        rows = [
            {"stream": "production-state-v2", "tenant": tenant, "name": name,
             "rule": "recording", "value": 0}
            for tenant, name in [("school-one", "Example school"), ("school-two", "Another school")]
        ]

        def report(tenant="school-one", episode="episode-a", participant="hash-a",
                   trigger="join_failed", codes=("media_start_failed",),
                   event="sdk.connection_report", service="chalk-api"):
            rows.append({"service": service, "event": event, "tenant": tenant,
                         "episode": episode, "participant": participant,
                         "trigger": trigger, "report": json.dumps({"version": 1,
                             "trigger": trigger, "events": [{"event": "connection_failed", "code": code} for code in codes]})})

        report(codes=("media_start_failed", "media_start_failed"))
        report()  # A duplicate upload is not another affected person.
        report(participant="hash-b")
        report(participant="hash-c", codes=("access_unavailable",))
        report(participant="hash-d", trigger="recovery_exhausted", codes=("media_recovery_exhausted",))
        report(tenant="school-two")
        report(episode="episode-b")
        report(tenant="unknown-school")  # Missing collector data must not hide a report.
        report(participant="noise-1", trigger="connection_lost")
        report(participant="noise-2", trigger="recovery_exhausted", codes=("sync_recovery_exhausted",))
        report(participant="noise-3", event="sdk.connection_report.rejected")
        report(participant="noise-4", service="another-service")
        report(participant="noise-5", trigger="recovery_exhausted", codes=("media_state",))

        fields = {
            "service.name": "service", "attributes.event": "event",
            "attributes.tenant_id": "tenant", "attributes.episode_id": "episode",
            "attributes.participant_id_hash": "participant", "attributes.trigger": "trigger",
            "attributes.report": "report", "chalk_alert_stream": "stream",
            "chalk_alert_tenant": "tenant", "chalk_alert_tenant_name": "name",
            "chalk_alert_rule": "rule", "chalk_alert_headline": "headline",
            "chalk_alert_summary": "summary", "chalk_alert_next": "next",
            "chalk_alert_engineers": "engineers",
        }
        schema = ",".join("['" + field + "']:string" for field in fields)
        fixture = "let FixtureLogs=datatable(_time:datetime,chalk_alert_value:long," + schema + ")[" + ",".join(
            "datetime(2026-10-27T22:05:00Z)," + str(row.get("value", 0)) + "," +
            ",".join(json.dumps(row.get(key, "")) for key in fields.values()) for row in rows
        ) + "];\n"
        query = monitor_definitions(VARIABLES)[0]["aplQuery"].replace("['fixture-logs']", "FixtureLogs")
        request = Request(
            "https://api.axiom.co/v1/datasets/_apl?format=tabular",
            data=json.dumps({"apl": fixture + query + " | where value > 0",
                             "startTime": "2026-10-27T00:00:00Z", "endTime": "2026-10-29T00:00:00Z"}).encode(),
            headers={"Authorization": "Bearer " + os.environ["AXIOM_TOKEN"],
                     "X-Axiom-Org-Id": os.environ["AXIOM_ORG_ID"], "Content-Type": "application/json"},
        )
        try:
            with urlopen(request, timeout=30) as response:
                result = json.load(response)
        except HTTPError as error:
            # The request contains synthetic fixtures only; never print credentials or headers.
            with error:
                self.fail(f"Axiom query HTTP {error.code}: {error.read(2000).decode()}")
        self.assertFalse(result["status"]["isPartial"])
        actual = {}
        for table in result["tables"]:
            fields = [field["name"] for field in table["fields"]]
            for values in zip(*table["columns"]):
                row = dict(zip(fields, values))
                lines = row["alert_message"].split("\n")
                self.assertEqual(lines[2], "connection-report")
                summary = lines[4]
                self.assertIn("2026-10-28", summary)
                self.assertIn("03:05:00 PKT", summary)
                episode = summary.split("Episode: ")[1].split(".")[0]
                failure = summary.split("Failure: ")[1].split(".")[0]
                actual[lines[1], episode, failure] = row["value"]
                self.assertIn("Report a problem", lines[5])
                if lines[1] == "school-one":
                    self.assertIn("Example school (school-one)", summary)
                elif lines[1] == "unknown-school":
                    self.assertIn("Tenant: unknown-school.", summary)
        self.assertEqual(actual, {
            ("school-one", "episode-a", "media_start_failed"): 2,
            ("school-one", "episode-a", "join_failed"): 1,
            ("school-one", "episode-a", "media_recovery_exhausted"): 1,
            ("school-two", "episode-a", "media_start_failed"): 1,
            ("school-one", "episode-b", "media_start_failed"): 1,
            ("unknown-school", "episode-a", "media_start_failed"): 1,
        })


if __name__ == "__main__":
    unittest.main()
