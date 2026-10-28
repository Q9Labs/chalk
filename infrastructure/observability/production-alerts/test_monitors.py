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
    def test_observed_w33_w34_reports_alert_only_with_the_new_rules(self):
        fixtures = json.loads(Path(__file__).with_name("testdata").joinpath("observed-connection-reports.json").read_text())
        rows = []
        for fixture in fixtures:
            envelope = fixture["envelope"]
            rows.append({"at": envelope["_time"], "service": envelope["service.name"],
                         "event": envelope["attributes.event"], "tenant": envelope["attributes.tenant_id"],
                         "episode": envelope["attributes.episode_id"], "participant": envelope["attributes.participant_id_hash"],
                         "trigger": envelope["attributes.trigger"], "report": json.dumps(fixture["report"])})
        baseline = self.query_fixture(rows, without_connection_reports=True)
        self.assertTrue(all(not any(table["columns"]) for table in baseline["tables"]))
        result = self.query_fixture(rows)
        actual = {}
        for table in result["tables"]:
            fields = [field["name"] for field in table["fields"]]
            for values in zip(*table["columns"]):
                row = dict(zip(fields, values))
                summary = row["alert_message"].split("\n")[4]
                episode = summary.split("Episode: ")[1].split(".")[0]
                failure = summary.split("Failure: ")[1].split(".")[0]
                actual[episode] = (failure, row["value"])
                self.assertIn("media_error_kind: unknown; media_error_step: unknown", summary)
                self.assertIn("03:05:00 PKT", summary)
        self.assertEqual(actual, {fixture["envelope"]["attributes.episode_id"]:
                                 (fixture["expected_failure"], fixture["expected_count"]) for fixture in fixtures})

    def query_fixture(self, rows, without_connection_reports=False):
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
            "datetime(" + row.get("at", "2026-10-27T22:05:00Z") + ")," + str(row.get("value", 0)) + "," +
            ",".join(json.dumps(row.get(key, "")) for key in fields.values()) for row in rows
        ) + "];\n"
        query = monitor_definitions(VARIABLES, without_connection_reports=without_connection_reports)[0]["aplQuery"].replace("['fixture-logs']", "FixtureLogs")
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
        return result

    @unittest.skipUnless(LIVE, "use --live for read-only Axiom execution")
    def test_media_projection_mismatch_sources_directions_deduplication_and_noise(self):
        rows = [{"stream": "production-state-v2", "tenant": "school-one",
                 "name": "Example school", "rule": "recording", "value": 0}]

        def report(tenant="school-one", episode="episode-a", participant="hash-a",
                   source="microphone", publication="on", projection="off",
                   duration=5000, attempt=1, at="2026-10-27T22:05:00Z",
                   trigger="media_projection_mismatch", event="media_projection_mismatch",
                   envelope_event="sdk.connection_report"):
            diagnostic = {"event": event, "elapsed_ms": 5000, "source": source,
                          "publication_state": publication, "projection_state": projection}
            if duration is not None:
                diagnostic["duration_ms"] = duration
            if attempt is not None:
                diagnostic["attempt"] = attempt
            rows.append({"at": at, "service": "chalk-api", "event": envelope_event,
                         "tenant": tenant, "episode": episode, "participant": participant,
                         "trigger": trigger, "report": json.dumps({"version": 1, "trigger": trigger,
                             "events": [diagnostic, diagnostic,
                                        {"event": "state_changed", "elapsed_ms": 6000}]})})

        report()
        report()  # Duplicate diagnostics and uploads still count one participant.
        report(participant="hash-b", publication="off", projection="on", duration=9000,
               attempt=2, at="2026-10-27T22:06:00Z")
        report(source="camera", publication="off", projection="on")
        report(tenant="school-two")
        report(episode="episode-b")
        report(episode="older-optional-fields", duration=None, attempt=None)
        report(participant="noise-state", event="media_state")
        report(participant="noise-trigger", trigger="connection_lost")
        report(participant="noise-rejected", envelope_event="sdk.connection_report.rejected")
        report(participant="noise-aligned-on", projection="on")
        report(participant="noise-aligned-off", publication="off")
        report(participant="noise-source", source="")
        report(participant="noise-missing-state", projection="")

        actual = {}
        for table in self.query_fixture(rows)["tables"]:
            fields = [field["name"] for field in table["fields"]]
            for values in zip(*table["columns"]):
                row = dict(zip(fields, values))
                lines = row["alert_message"].split("\n")
                summary = lines[4]
                self.assertEqual(lines[2], "connection-report")
                self.assertIn("Failure: media_projection_mismatch.", summary)
                self.assertIn("2026-10-28T03:05:00 PKT", summary)
                episode = summary.split("Episode: ")[1].split(".")[0]
                source = summary.split("Source: ")[1].split(";")[0]
                actual[lines[1], episode, source] = row["value"]
                if lines[1] == "school-one":
                    self.assertIn("Tenant: Example school (school-one).", summary)
                else:
                    self.assertIn("Tenant: school-two.", summary)
                if episode == "older-optional-fields":
                    self.assertIn("publication: on; projection: off. Duration: unknown; attempt: unknown.", summary)
                elif source == "camera":
                    self.assertIn("publication: off; projection: on. Duration: 5000 ms; attempt: 1.", summary)
                elif lines[1] == "school-one" and episode == "episode-a":
                    self.assertIn("publication: off; projection: on. Duration: 9000 ms; attempt: 2.", summary)
                else:
                    self.assertIn("publication: on; projection: off. Duration: 5000 ms; attempt: 1.", summary)
        self.assertEqual(actual, {
            ("school-one", "episode-a", "microphone"): 2,
            ("school-one", "episode-a", "camera"): 1,
            ("school-two", "episode-a", "microphone"): 1,
            ("school-one", "episode-b", "microphone"): 1,
            ("school-one", "older-optional-fields", "microphone"): 1,
        })

    @unittest.skipUnless(LIVE, "use --live for read-only Axiom execution")
    def test_real_apl_single_failures_deduplication_noise_and_pkt_rollover(self):
        rows = [
            {"stream": "production-state-v2", "tenant": tenant, "name": name,
             "rule": "recording", "value": 0}
            for tenant, name in [("school-one", "Example school"), ("school-two", "Another school")]
        ]

        def report(tenant="school-one", episode="episode-a", participant="hash-a",
                   trigger="join_failed", codes=("media_start_failed",),
                   event="sdk.connection_report", service="chalk-api",
                   kind="NotReadableError", step="local_capture", at="2026-10-27T22:05:00Z"):
            rows.append({"at": at, "service": service, "event": event, "tenant": tenant,
                         "episode": episode, "participant": participant,
                         "trigger": trigger, "report": json.dumps({"version": 1,
                             "trigger": trigger, "events": [
                                 {"event": "space_join_span", "elapsed_ms": 0, "media_error_kind": "NotAllowedError", "media_error_step": "local_capture"}
                             ] + [{"event": "connection_failed", "elapsed_ms": index + 1,
                                 "code": code, "media_error_kind": kind, "media_error_step": step} for index, code in enumerate(codes)] + [
                                 {"event": "state_changed", "elapsed_ms": 64}
                             ]})})

        report(codes=("media_start_failed", "media_start_failed"))
        report()  # A duplicate upload is not another affected person.
        report(participant="hash-b", kind="network", step="sfu_tracks", at="2026-10-27T22:06:00Z")
        report(participant="hash-c", codes=("access_unavailable",), kind="", step="")
        rows[-1]["report"] = json.dumps({"version": 1, "trigger": "join_failed", "events": [
            {"event": "connection_failed", "elapsed_ms": 1, "code": "access_unavailable"}
        ]})  # An older SDK report has no cause fields at all.
        report(participant="hash-d", trigger="recovery_exhausted", codes=("media_recovery_exhausted",))
        report(tenant="school-two")
        report(episode="episode-b")
        report(tenant="unknown-school")  # Missing collector data must not hide a report.
        report(participant="noise-1", trigger="connection_lost")
        report(participant="noise-2", trigger="recovery_exhausted", codes=("sync_recovery_exhausted",))
        report(participant="noise-3", event="sdk.connection_report.rejected")
        report(participant="noise-4", service="another-service")
        report(participant="noise-5", trigger="recovery_exhausted", codes=("media_state",))

        result = self.query_fixture(rows)
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
                if failure == "join_failed":
                    self.assertIn("media_error_kind: unknown; media_error_step: unknown", summary)
                elif lines[1] == "school-one" and episode == "episode-a" and failure == "media_start_failed":
                    self.assertIn("media_error_kind: network; media_error_step: sfu_tracks", summary)
                else:
                    self.assertIn("media_error_kind: NotReadableError; media_error_step: local_capture", summary)
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
