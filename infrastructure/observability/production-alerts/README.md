# Production user-facing alerts

The local Grafana rules do not run in production. Production has Axiom API logs,
API/Sync traces and metrics, Postgres state, and an uptime Worker. CloudWatch
holds transcription Lambda and deployment logs; it does not cover all these
failures. No hosted Grafana was found on the managed runtime host.

Use Axiom's custom webhook notifier with `discord-body.tmpl` aimed directly at the Discord webhook. Three grouped monitors fit the
current monitor allowance. Keep the live organization, dataset names, monitor
IDs and Discord webhook in private configuration, never in this public repo.

| Rule                         | Production source             | Evaluation                                                                                  |
| ---------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| Recording Capture failed     | `recording_jobs`              | Terminal failure in the last 15 minutes                                                     |
| Export failed or overdue     | `recording_jobs`, Render kind | Terminal failure in 15 minutes, or active for over 14 hours                                 |
| Transcript failed or overdue | `transcriptions`              | Terminal failure in 15 minutes, or active for over 30 minutes                               |
| Webhook retries exhausted    | `webhook_deliveries`          | Exhausted in the last 15 minutes                                                            |
| API 5xx rate                 | Axiom API request logs        | More than 15 server errors in 5 minutes, sustained for 5 evaluations                        |
| Sync connection failures     | Axiom Sync event spans        | More than 10 upgrade rejections/abnormal closures in 5 minutes, sustained for 5 evaluations |

The Capture and Export rules are disjoint: a Render failure only counts as Export. API errors are unsampled in the
production `errors` request-log mode. Sync exports the same named events as spans;
its stdout logs are not required. The API count is the 0.05-errors/second threshold
over a five-minute window, not a percentage of all requests. Sync counts only rejected upgrades and closures explicitly marked `close_kind=abnormal`. Axiom keeps span attributes outside its conventions in the `attributes.custom` map, so the query reads `['attributes.custom']['close_kind']`; `['attributes.close_kind']` is rejected as an invalid field. Normal leaves, acknowledged class ends and server drains are excluded; unclassified older events are not counted. Install the Sync instrumentation before switching the monitor.

## Read-only state collector

`collector.go` is a standalone alert-only executable, not an API service change.
Build on the remote test machine from `apps/api` to reuse its pinned pgx version:

```sh
go test ../../infrastructure/observability/production-alerts/collector.go ../../infrastructure/observability/production-alerts/collector_test.go ../../infrastructure/observability/production-alerts/discord_test.go
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o collector ../../infrastructure/observability/production-alerts/collector.go
```

The collector uses one connection, a read-only transaction and a five-second SQL
timeout. It emits four counts per Tenant plus four empty-Tenant heartbeat rows, including zero values to clear earlier failures. Tenant display names and stable Tenant IDs are read at run time and exported to the private Axiom dataset; only names appear in Discord. No job IDs, connection strings, error details or customer payloads are exported. This deliberately reverses the former no-Tenant-data policy; keep attribution in its separate commit for privacy review. A rejected or
partial ingest fails the service. The freshness monitor detects missing snapshots
within five minutes. Latest values, not sums of repeated snapshots, drive alerts.

Install the binary at `/opt/chalk-alerts/collector` and the units in `/etc/systemd/system`.
The service reuses `/run/chalk/env/api.env` under the existing runtime User. It reads
`CHALK_DATABASE_URL` and derives its ingest token/dataset from
`OTEL_EXPORTER_OTLP_LOGS_HEADERS`. It does not change that file or any app unit.
Optional private `/etc/chalk-alerts/collector.env` can override
`CHALK_ALERT_AXIOM_TOKEN` and `CHALK_ALERT_LOG_DATASET`. Prefer a dedicated read-only
database credential when one is available; the transaction itself always forbids
writes. Keep credentials out of SSM command bodies and CI output.

Before enabling the timer, run `collector --check` with the private environment
and verify the per-Tenant state counts against Postgres. Then run the service once,
confirm all per-Tenant snapshots and the four heartbeat rows in Axiom, and enable `chalk-alert-state.timer`.
Only install these alert files: do not run an application deployment controller.

The next managed release targets the existing host: its controller replaces only
the managed runtime files and leaves `/opt/chalk-alerts` and the root alert units
in `/etc/systemd/system` intact. The controller regression suite checks preservation
of the alert units. Reboots also keep them; the collector is ordered after the
runtime restore service so the private environment is restored first. There is
currently no managed host-replacement path. A genuinely new host needs this
alert-only installation repeated before alerts are considered healthy; the native
freshness monitor remains enabled independently and detects a missing collector.

## Connection-report rules

The first monitor also evaluates [connection-reports.apl](connection-reports.apl).
It still uses the existing Discord notifier and the same three-monitor allowance.
The API/Sync traffic monitor's thresholds and five-positive-run delay are unchanged.

| Failure                    | Accepted report                                                            | Threshold                                        |
| -------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ |
| `join_failed`              | Trigger `join_failed`, without a `media_start_failed` diagnostic           | At least one affected participant in ten minutes |
| `media_start_failed`       | Trigger `join_failed`, with a `media_start_failed` diagnostic              | At least one affected participant in ten minutes |
| `media_recovery_exhausted` | Trigger `recovery_exhausted`, with a `media_recovery_exhausted` diagnostic | At least one affected participant in ten minutes |

Each rule groups by Tenant ID, Episode ID and failure. Repeated uploads and
multiple matching diagnostics count once per participant within that group.
A failed media start is the more specific join-failure category, not a second
alert for the same failed join. Only accepted `sdk.connection_report` API events
count: rejected uploads, ordinary state changes, connection-loss reports and
retries that recover without exhaustion do not. Permission/device failures that
actually stop a join still count; do not hide a real class failure as noise.

The monitor checks every minute, with `Above 0`, one positive run, per-group
notifications, no repeat-every-run and no no-data alert. Waiting for several
people to fail would miss a single-person class interruption. The ten-minute
window tolerates ingestion delay and deduplicates repeat reports. It is not a
ten-minute delivery guarantee: an offline client, rate limit, broken exporter,
or delayed/rejected report can still prevent or delay an alert.

Messages include the sanitized database Tenant name plus its stable ID, the
Episode ID, failure, affected-participant count and first report time in **PKT**
(UTC+05:00, including date rollover). The new collector exports the already
sanitized name as `chalk_alert_tenant_name`; install its alert-only binary before
enabling these rules. Without a matching snapshot, the message uses the Tenant
ID instead of dropping the failure. Counts and the evaluation clock are not part
of the notification group; its first-report time stays fixed while that first
report remains in the window. A continuing incident can open a new group when
the oldest report ages out or the Tenant name changes. Threshold closure is not
proof that anyone recovered or rejoined.

**MEDIA_STATE_MISMATCH_SLOT:** the named slot in the APL is intentionally inactive
until the SDK/API lane confirms the persistent mismatch trigger and fields.
Transient `media_state` diagnostics and a local mic icon alone must not page.
The class checklist covers the mic-on/remote-muted symptom in the meantime.

Run the offline provisioning tests from this directory:

```sh
python3 test_monitors.py
```

With `AXIOM_TOKEN` and `AXIOM_ORG_ID` supplied privately, add `--live` to execute
the real expanded monitor query against synthetic Axiom datatables. This proves
single-person thresholds, tenant/Episode isolation, duplicate suppression,
noise exclusions, missing-name fallback and PKT date rollover without ingesting
events or changing monitors. It does not prove Discord receipt or live SDK reports.

## Reconcile the native monitors

Load these values privately: `AXIOM_TOKEN` (monitor/notifier management),
`AXIOM_ORG_ID`, `LOG_DATASET`, `TRACE_DATASET`, and `DISCORD_WEBHOOK_URL`.
The Discord URL lives in 1Password vault `dev`, item
**Chalk production alerts Discord webhook**.

```sh
python3 infrastructure/observability/production-alerts/provision.py
python3 infrastructure/observability/production-alerts/provision.py --apply --disabled
# Enable only after the collector snapshots and Discord destination are verified:
python3 infrastructure/observability/production-alerts/provision.py --apply
```

For a release that keeps the existing alerts enabled, validate with the first
command, install the updated alert-only collector, then run the final `--apply`
command. Do not stage all existing monitors with `--disabled` during a live class.
Confirm the native monitor evaluation and actual Discord receipt after release.
To undo only the connection-report rules while keeping the previous job, traffic
and freshness queries enabled, run from the repository root with the same private
environment:

```sh
python3 infrastructure/observability/production-alerts/provision.py --apply --without-connection-reports
```

This undo leaves the collector's harmless sanitized-name field in place and
reconciles only the same three monitor names and notifier. It does not disable
the collector or any application unit.

Only the three exact monitor names and the exact notifier name are reconciled;
unrelated configuration is untouched. Provisioning without a webhook is permitted
only with `--disabled`; it is preparation, not working alert delivery. The state
and traffic monitors notify separately for each rule/summary group. No data is not
a failure in those two monitors; the third monitor explicitly catches missing
state coverage. Trace/log exporter health remains covered by the uptime Worker
and existing telemetry health checks, not by a new claim of complete telemetry.

## Prove delivery and reset

All rules share one route: Axiom monitor → custom webhook notifier → Discord.
A direct webhook POST proves the endpoint only, not this route.

1. With production monitors enabled, run `collector --test`. This emits a dedicated
   `delivery-test` group, with no database write or induced user failure.
2. Wait for the native monitor evaluation using its history/completion evidence.
   Confirm the **TEST: Chalk alert delivery** message in the actual
   Discord channel. Record the monitor history and channel/message evidence privately.
3. Run `collector --clear-test`, confirm the honest threshold-closed message, and remove the test
   notification from the channel when supported. The test events remain in Axiom's
   normal retention but carry no customer data; the latest test value is zero.
4. Query all rule groups and freshness, and confirm the timer remains active.

If the Discord item is absent, finish the code and checks, leave monitors disabled,
and report delivery as unproved. Do not infer receipt from a successful HTTP response
from Axiom or from a created notifier. Rollback disables the three named monitors
and stops/disables only `chalk-alert-state.timer`; it leaves all app units alone.

## Discord layout and recovery

Axiom's [custom webhook documentation](https://axiom.co/docs/monitor-data/custom-webhook-notifier)
exposes Go templates, `Action`, `Value`, `GroupKeys` and `GroupValues`. The
[notifier API](https://axiom.co/docs/restapi/endpoints/createNotifier) accepts
`properties.customWebhook.url`, `body`, and `headers`; provisioning explicitly
sets `Content-Type: application/json`. Axiom joins each result’s group columns
into one `GroupValues` string: `GroupKeys` and `GroupValues` are not parallel
arrays. The job and connection queries therefore group on one `alert_message`
column containing newline-delimited Tenant identity, rule, headline, summary,
next action, and engineer line. Names have controls removed by the collector;
the fixed text has no embedded newlines. The template slices at newline byte
boundaries (preserving Unicode), then JSON-quotes the resulting message.
Complete result messages are included within a conservative 1,700-byte budget;
a counted omission notice directs engineers to the monitor for additional groups.
This stays below Discord’s 2,000-character limit without cutting Unicode or
silently losing an entire alert batch. Old query groups use fallback wording
until the queries are switched; the legacy delivery-test group is explicitly
identified as a notification test. The integer-range operation was also checked against Axiom’s live renderer. Its output is Discord JSON with all mentions disabled. Threshold
closure is explicitly **not proof of repair**. It says the threshold is no
longer exceeded and asks an engineer to confirm the earlier outcome. No
undocumented resolve-suppression flag is used.

The freshness headline is “The alert system has stopped reporting”. API and
Sync describe the threshold (more than 15 server errors or ten connection
failures in five minutes), not the weighted internal value. Job messages show
the count. The last line is always “For engineers” and a first diagnostic command.
Capture terminal failure does not establish that all source is unrecoverable:
the completion recovery path can retain source. Therefore no complete video is
promised; an engineer checks recoverability immediately. Export and transcript
messages require checking the actual source expiry, not an invented deadline.
As of 2026-10-11, these template changes had not been sent to production Discord;
receipt and Axiom's runtime rendering required staged delivery proof. See the
[tracker](../../../tracker.yaml) for current alert-delivery work; this note does
not establish the current production state.

## Tenant attribution (separate commit)

Names come from `tenants.name` in the read-only snapshot, never from committed
configuration. Every rule emits a zero for every Tenant on every collection, so
latest-value evaluation clears an old count immediately instead of keeping a
stale positive group. Stable Tenant IDs distinguish identical display names.
Counts are distinct affected Recordings for Capture, Export and transcript, and
exhausted deliveries for webhooks; they are not necessarily distinct classes.
Names are limited to 80 characters and stripped of control/Discord formatting
characters. Discord mentions are disabled. Names may reveal internal tests but
are not a reliable test/customer classification: no rule suppresses a Tenant
based on its name. API/Sync events have no safe Tenant attribution today; their
messages explicitly say attribution is unavailable rather than guess.

For Export, the earliest source expiry is calculated from the Capture completion
and the Episode's frozen retention policy, matching the API's deferred artifact
query. Transcript uses its immutable `source_expires_at`. Unknown or already
expired deadlines are stated explicitly; recoverability is not promised. Tenant
names/IDs and expiry timestamps go to private observability, not the public repo.
