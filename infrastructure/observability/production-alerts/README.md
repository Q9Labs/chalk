# Production user-facing alerts

The local Grafana rules do not run in production. Production has Axiom API logs,
API/Sync traces and metrics, Postgres state, and an uptime Worker. CloudWatch
holds transcription Lambda and deployment logs; it does not cover all these
failures. No hosted Grafana was found on the managed runtime host.

Use Axiom's native Discord webhook notifier. Three grouped monitors fit the
current monitor allowance. Keep the live organization, dataset names, monitor
IDs and Discord webhook in private configuration, never in this public repo.

| Rule                               | Production source             | Evaluation                                                                         |
| ---------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| Recording Capture or Render failed | `recording_jobs`              | Terminal failure in the last 15 minutes                                            |
| Export failed or overdue           | `recording_jobs`, Render kind | Terminal failure in 15 minutes, or active for over 14 hours                        |
| Transcript failed or overdue       | `transcriptions`              | Terminal failure in 15 minutes, or active for over 30 minutes                      |
| Webhook retries exhausted          | `webhook_deliveries`          | Exhausted in the last 15 minutes                                                   |
| API 5xx rate                       | Axiom API request logs        | More than 15 server errors in 5 minutes, sustained for 5 evaluations               |
| Sync connection failures           | Axiom Sync event spans        | More than 10 upgrade rejections/closures in 5 minutes, sustained for 5 evaluations |

The SQL and user-facing summaries match PR #139. API errors are unsampled in the
production `errors` request-log mode. Sync exports the same named events as spans;
its stdout logs are not required. The API count is the 0.05-errors/second threshold
over a five-minute window, not a percentage of all requests. Sync preserves #139's
closure definition, including ordinary closures; changing that policy is separate.

## Read-only state collector

`collector.go` is a standalone alert-only executable, not an API service change.
Build on the remote test machine from `apps/api` to reuse its pinned pgx version:

```sh
go test ../../infrastructure/observability/production-alerts/collector.go ../../infrastructure/observability/production-alerts/collector_test.go
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o collector ../../infrastructure/observability/production-alerts/collector.go
```

The collector uses one connection, a read-only transaction and a five-second SQL
timeout. It emits only four aggregate counts and public summaries, no job IDs,
Tenant IDs, connection strings, error details or customer payloads. A rejected or
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
and verify all four state counts against Postgres. Then run the service once,
confirm the four snapshots in Axiom, and enable `chalk-alert-state.timer`.
Only install these alert files: do not run an application deployment controller.

The next managed release targets the existing host: its controller replaces only
the managed runtime files and leaves `/opt/chalk-alerts` and the root alert units
in `/etc/systemd/system` intact. The controller regression suite checks preservation
of the alert units. Reboots also keep them; the collector is ordered after the
runtime restore service so the private environment is restored first. There is
currently no managed host-replacement path. A genuinely new host needs this
alert-only installation repeated before alerts are considered healthy; the native
freshness monitor remains enabled independently and detects a missing collector.

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

Only the three exact monitor names and the exact notifier name are reconciled;
unrelated configuration is untouched. Provisioning without a webhook is permitted
only with `--disabled`; it is preparation, not working alert delivery. The state
and traffic monitors notify separately for each rule/summary group. No data is not
a failure in those two monitors; the third monitor explicitly catches missing
state coverage. Trace/log exporter health remains covered by the uptime Worker
and existing telemetry health checks, not by a new claim of complete telemetry.

## Prove delivery and reset

All rules share one route: Axiom monitor → native DiscordWebhook notifier → Discord.
A direct webhook POST proves the endpoint only, not this route.

1. With production monitors enabled, run `collector --test`. This emits a dedicated
   `delivery-test` group, with no database write or induced user failure.
2. Wait for the native monitor evaluation using its history/completion evidence.
   Confirm the **TEST: Chalk production alert delivery proof** message in the actual
   Discord channel. Record the monitor history and channel/message evidence privately.
3. Run `collector --clear-test`, confirm native recovery, and remove the test
   notification from the channel when supported. The test events remain in Axiom's
   normal retention but carry no customer data; the latest test value is zero.
4. Query all rule groups and freshness, and confirm the timer remains active.

If the Discord item is absent, finish the code and checks, leave monitors disabled,
and report delivery as unproved. Do not infer receipt from a successful HTTP response
from Axiom or from a created notifier. Rollback disables the three named monitors
and stops/disables only `chalk-alert-state.timer`; it leaves all app units alone.
