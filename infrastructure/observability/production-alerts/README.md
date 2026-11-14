# Production user-facing alerts

The local Grafana rules do not run in production. Production has Axiom API logs, API/Sync traces and metrics, Postgres state and an uptime Worker. CloudWatch holds transcription Lambda and deployment logs and does not cover these failures.

Axiom's custom webhook notifier with `discord-body.tmpl` posts straight to the Discord webhook. Three grouped monitors fit the current monitor allowance. When `ONCALL_WEBHOOK_URL` is set, `provision.py` also reconciles a second, free Slack-type notifier aimed at the Q9 Oncall webhook and attaches both notifiers to every monitor (the plan has no custom-webhook feature for a new notifier). The on-call guide for the Chalk SFU alerts, including the DigitalOcean node alerts `do-monitoring.sh` sets, is [sfu-runbook.md](sfu-runbook.md). Keep the live organization, dataset names, monitor IDs and Discord webhook in private configuration, never in this repo.

The rules are the `.apl` queries, `monitors.json`, `state.sql` and the thresholds in `provision.py`. Judgment behind them:

- The Capture and Export rules are disjoint: a Render failure only counts as Export.
- API errors are unsampled in the production `errors` request-log mode, and the API threshold is 0.05 errors/second over five minutes, not a percentage of requests. Sync counts only rejected upgrades and closures marked `close_kind=abnormal`; normal leaves, acknowledged class ends and server drains are excluded. Axiom keeps span attributes outside its conventions in `attributes.custom`, so the query reads `['attributes.custom']['close_kind']` (`['attributes.close_kind']` is rejected). Install the Sync instrumentation before switching the monitor.
- State rules take the latest sample per minute and alert on at least four unhealthy minute samples in five minutes while the newest is unhealthy and newer than 90 seconds. That tolerates a short blip and timer jitter (a 24-second failure cannot page, a roughly five-minute outage can) and gives detection after about three to four minutes plus one evaluation interval. A healthy sample clears on the next evaluation. Missing evidence is not proof of continued failure.
- Rules that read the API log (`turn-credentials.apl`, `recovery-refused.apl`, `deadline-scheduler.apl`) have alert text that names no Tenant, node or address. Axiom refuses to save a monitor naming a field its dataset has never received, so `deadline-scheduler.apl` reads `consecutive_failures` and `phase` through `column_ifexists` with defaults that never alert. A `control_busy` skip waits on a publication fence that Sync normally releases in seconds, so it alerts only after sixty passes. Own-SFU placement outcomes are a metric only, with no rule, because no log line records them.
- All SFU thresholds beyond the readiness shape live in `THRESHOLDS` in `provision.py`; the APL files read placeholders, and `provision.py` refuses a query with an unresolved one.

## Call verdicts

When `CHALK_ALERT_AXIOM_QUERY_TOKEN` is set in `/etc/chalk-alerts/collector.env`, the collector also judges each Episode that ended 30 to 100 seconds ago (at most 10 a minute) and writes one `call-verdict <episode id>` row, value 1, only for a bad one. The first monitor's generic branch already alerts on that row, so the alert goes to Discord and Oncall with the verdict line and the command `pnpm diagnose:call <episode id>`. No new service and no new monitor.

- It reads rows by id: every row of the Axiom log dataset that names the Episode, then the SFU node events of the connections those rows name. The time range only bounds the scan.
- The rules and thresholds are `call-verdict.json`, which `pnpm diagnose:call` reads too. Both test against `scripts/diagnose-call/fixtures/cases.json`, so a changed rule fails in both places until both agree.
- `CHALK_ALERT_AXIOM_ORG_ID` and `CHALK_ALERT_QUERY_DATASET` (default: `CHALK_ALERT_LOG_DATASET`) are optional. The query token needs read access to the log dataset only; the ingest token cannot query. The goroutine has a 12-second budget and a failure prints a short message to the journal, so the other rows never wait on it.
- The `call-verdict` row is written 30 to 100 seconds after the Episode ends, plus at most the collector's 12-second query budget, so no later than 112 seconds (`flag_within_ms` in `call-verdict.json` is 120 seconds, and a test fails when the constants pass it). The monitor then evaluates once a minute, so the Discord and Oncall alert follows within another minute. A dataset that has not yet received node events (`attributes.connection_id` unknown) gives a verdict from the API rows alone, with the cause "unknown".
- The verdict line names the failing stage and the side (see "Diagnose one call" in `docs/observability.md`). A stretch the viewer chose, such as a hidden tab, is named in the line but raises no row.

## Read-only state collector

`collector.go` is a standalone alert-only executable, not an API change. Build it from `apps/api` to reuse the pinned pgx, with Go 1.26.11, targeting the host (`aarch64` is Go's `arm64`):

```sh
GOTOOLCHAIN=go1.26.11 go test ../../infrastructure/observability/production-alerts/collector.go ../../infrastructure/observability/production-alerts/call_verdict.go ../../infrastructure/observability/production-alerts/collector_test.go ../../infrastructure/observability/production-alerts/call_verdict_test.go
GOTOOLCHAIN=go1.26.11 CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o collector ../../infrastructure/observability/production-alerts/collector.go ../../infrastructure/observability/production-alerts/call_verdict.go
```

It uses one connection, a read-only transaction and a five-second SQL timeout. It emits per-Tenant counts (zeros included, so latest-value evaluation clears an old count immediately) plus empty-Tenant heartbeat rows and global rows for Sync readiness, SFU retirement debt and, when enabled, SFU readiness and certificate expiry. A rejected or partial ingest fails the service. The freshness monitor detects missing snapshots within five minutes and counts six rules; it does not count the SFU rows. The SFU readiness row exists only on hosts that enable the probe, so counting it would page every host without an SFU. The debt row comes from the same database read as the others, so a stopped collector is already caught. Only snapshots newer than five minutes drive state alerts.

Install the collector only after the API release that runs the `sfu_retirement_debts` migration and after `provision.py --apply` has updated the first monitor, otherwise the previous query pages any positive debt age as a generic failure. Install the updated collector and monitor definitions together.

Tenant display names and stable IDs are read at run time and exported to the private Axiom dataset; only names appear in Discord, capped at 80 characters with control and Discord formatting characters stripped, and mentions disabled. Names may reveal internal tests but no rule suppresses a Tenant by name. No job IDs, connection strings, error details or customer payloads are exported. API and Sync events have no safe Tenant attribution, so their messages say so rather than guess.

The collector also probes Sync at `http://127.0.0.1:14100/readyz` (override with `CHALK_ALERT_SYNC_READY_URL`): 200 emits zero, anything else one. Redirects are not followed, the HTTP probe is bounded to five seconds and SQL to ten, so readiness is still ingested when SQL fails. Only allowlisted reason codes are exported; no body, endpoint or exception text.

### Certificate expiry

When the collector has a certificate to read (the API's SFU client certificate in `CHALK_ALERT_SFU_CLIENT_CERT`, each SFU node's server certificate via the `sfu-readiness` handshake, and the direct door's when `CHALK_ALERT_DIRECT_DOOR_URL` is set) it emits one global `certificate-expiry` row: 1 when the soonest has 21 days or fewer left, has expired, or the door cannot finish a TLS handshake. The 21-day and 7-day texts differ, so the grouped monitor notifies twice. An unreachable SFU node is `sfu-readiness`'s concern and adds nothing here.

Server certificates last 180 days (`certs <env> server`, then `deploy`); the API's SFU client certificate lasts 365 days and is a separate target (`certs <env> api <key file> <current certificate>`, then install it where the API and collector read it). A chain failing only because of expiry reads as expired; any other failure (unknown authority, wrong name) raises `untrusted` instead of hiding an expiry. Expiry is the earliest NotAfter along the verified chain, with the pinned CA counting for the SFU but a system root not counting for the door. If the CA ends before its leaf, renewing the server certificate does not help: move the old `ca.crt` aside, run `certs <env> ca` (it refuses while one exists, because a new CA orphans everything it issued), reissue the server, API and operator certificates, and give every node and the API the new CA. The direct door's certificate is issued and renewed by its Caddy proxy over TLS-ALPN-01 on port 443, so a warning there means renewal is failing; check the proxy journal. Checks run in parallel (3 s per node, 8 s total), so a slow node never delays another row.

### Own SFU readiness

When `CHALK_ALERT_SFU_READY_URL` (one node) or `CHALK_ALERT_SFU_READY_URLS` (comma-separated) is set, the collector emits one global `sfu-readiness` row per run, unhealthy when any node is, with the reason of the first unhealthy node in list order (so a fleet pages for a down or draining standby too). With both unset it emits nothing. All nodes share `CHALK_ALERT_SFU_CLIENT_CERT`, `CHALK_ALERT_SFU_CLIENT_KEY`, `CHALK_ALERT_SFU_CA` and `CHALK_ALERT_SFU_SERVER_NAME` (the SFU name, as `CHALK_SFU_SERVER_NAME`). The SFU's `/readyz` is a mutual-TLS 1.3 listener that answers only a client certificate naming the API's service identity, so the operator reuses the API's SFU client certificate on the same host.

The probe has a five-second bound and follows no redirects. A configured probe fails closed: a missing file pages instead of turning the rule off. Reasons are `ready` (0), `tls_config`, `unreachable`, `draining`, `http_status`, `invalid_response`, the `admission_*` reasons (the node refuses new Episodes) and `packet_budget` (reserved packets at least 90% of budget); only these codes leave the probe, never error text, bodies, endpoints or node identifiers. Live calls continue while only admission is closed, so the message says new calls may fail to start. The alert message points engineers at `/readyz` through the SFU deploy tunnel and the node's `media telemetry` journal lines.

To enable it: place the certificate, key (mode 0600) and CA where the collector's User can read them, never in git or SSM command bodies; add the variables to the private `/etc/chalk-alerts/collector.env`; run `collector --check` and confirm one `sfu-readiness` row with value 0 and reason `ready`; run `provision.py --apply`, since the monitor already contains the branch. Roll the collector out before the SFU carries production traffic. To disable, remove both URL variables and restart the timer: the rows stop and the branch idles. The step-by-step production-host procedure is in [sfu-runbook.md](sfu-runbook.md#the-readiness-probe-on-the-production-host).

### Install

Install the binary at `/opt/chalk-alerts/collector` and the units in `/etc/systemd/system`. The service reuses `/run/chalk/env/api.env` under the existing runtime User, reads `CHALK_DATABASE_URL`, and derives its ingest token and dataset from `OTEL_EXPORTER_OTLP_LOGS_HEADERS`; it changes neither that file nor any app unit. Optional private `/etc/chalk-alerts/collector.env` can override `CHALK_ALERT_AXIOM_TOKEN` and `CHALK_ALERT_LOG_DATASET`. Prefer a dedicated read-only database credential; the transaction forbids writes regardless. Keep credentials out of SSM command bodies and CI output.

Before enabling the timer, run `collector --check` and verify the per-Tenant counts against Postgres, run the service once and confirm the snapshots, heartbeat rows and global rows in Axiom, then enable `chalk-alert-state.timer`. Install only these alert files; never run an application deployment controller for it.

A managed release replaces only the managed runtime files and leaves `/opt/chalk-alerts` and the root alert units intact (the controller regression suite checks this), and the collector is ordered after the runtime restore service so the private environment is back first. There is no managed host-replacement path: a genuinely new host needs this installation repeated, and the freshness monitor detects a missing collector meanwhile.

## Connection-report rules

[connection-reports.apl](connection-reports.apl) joins the first monitor and uses the existing Discord notifier and three-monitor allowance. It covers `join_failed`, `media_start_failed`, `media_recovery_exhausted`, `media_projection_mismatch` and `audio_receive_stuck` reports, grouped by Tenant ID, Episode ID and failure.

- Only accepted `sdk.connection_report` API events count. Rejected uploads, ordinary state changes, connection-loss reports and retries that recover do not, but permission or device failures that stop a join do; do not hide a real class failure as noise.
- Repeated uploads and multiple diagnostics count once per participant. A failed media start is the more specific join-failure category, not a second alert for the same join.
- One affected participant in ten minutes pages, because waiting for several people would miss a single-person class interruption. The window tolerates ingestion delay and deduplicates repeats; it is not a delivery guarantee (an offline client, rate limit, broken exporter or rejected report can still prevent an alert). The monitor checks every minute with one positive run, per-group notifications, no repeat-every-run and no no-data alert.
- `audio_receive_stuck` is sent once per unhealthy episode, at most eight per media session, after a publication stayed unhealthy for over ten seconds, so the rule needs no extra duration. A client that never binds an audio element while bytes flow reports the separate trigger `audio_receive_unbound`, which no rule counts; the stuck event also carries `element` (`none`, `bound` or `playing`). The mismatch predicate matches nothing until the SDK and API emit accepted reports with that trigger, so the rules can deploy first.
- `chat_upload_failed` (trigger `upload_failed`, sent by the SDK when a chat attachment upload fails) is the one rule that waits for a wave: it pages when three distinct participants of one Tenant report the same cause in ten minutes, because a single failed upload is usually one bad network. It groups by Tenant and cause (`initiate_failed`, `finalize_failed`, `storage_rejected`, `storage_unreachable`); `storage_unreachable` across several browsers that otherwise work points at the bucket CORS rule. Like the mismatch rule it matches nothing until the SDK and API emit the trigger.
- Messages carry the sanitized Tenant name and stable ID (the ID alone if no matching snapshot exists), Episode ID, failure, affected-participant count and first report time in **PKT**, the provider (`cloudflare_sfu`, `chalk_sfu`, else `unknown`), and the latest report's `media_error_kind` and `media_error_step` (`unknown` for older SDKs, never a guessed cause). Counts and the evaluation clock stay out of the notification group; a continuing incident can open a new group when the oldest report ages out, the Tenant name changes or the latest cause changes. Threshold closure is not proof anyone recovered.
- Install the collector (which exports `chalk_alert_tenant_name`) before enabling these rules.

## Reconcile the native monitors

Load these privately: `AXIOM_TOKEN` (monitor and notifier management), `AXIOM_ORG_ID`, `LOG_DATASET`, `TRACE_DATASET`, `DISCORD_WEBHOOK_URL`, plus `ONCALL_WEBHOOK_URL` to create or update the Oncall notifier. With the URL unset an existing Oncall notifier stays attached; only `--detach-oncall` removes it. The Discord URL is in 1Password vault `dev`, item **Chalk production alerts Discord webhook**; the Oncall URL is the item **Oncall webhook URL**.

```sh
python3 infrastructure/observability/production-alerts/provision.py
python3 infrastructure/observability/production-alerts/provision.py --apply --disabled
# Enable only after the collector snapshots and Discord destination are verified:
python3 infrastructure/observability/production-alerts/provision.py --apply
```

For a release that keeps existing alerts enabled, validate with the first command, install the updated collector, then run the final `--apply`. Never stage all monitors with `--disabled` during a live class. Confirm the native monitor evaluation and actual Discord receipt after release.

To undo only the connection-report rules, keeping the previous job, traffic and freshness queries enabled, run `provision.py --apply --without-connection-reports` with the same private environment. It leaves the collector's harmless name field in place and does not disable the collector or any app unit.

Only the three exact monitor names and the exact notifier name are reconciled; unrelated configuration is untouched. Provisioning without a webhook is permitted only with `--disabled`, as preparation, not working delivery. The state and traffic monitors notify per rule group and treat no data as not a failure; the third monitor explicitly catches missing state coverage. Exporter health stays with the uptime Worker and existing telemetry checks.

## Prove delivery and reset

All Axiom rules share one route: Axiom monitor, custom webhook notifier, Discord, and (when attached) Slack-type notifier, Oncall. A direct webhook POST proves the endpoint only, not this route.

1. With production monitors enabled, run `collector --test`, which emits a dedicated `delivery-test` group with no database write or induced failure. It reaches every notifier on the monitor and would start an Oncall run, so first run `provision.py --apply --detach-oncall`, and run `provision.py --apply` with `ONCALL_WEBHOOK_URL` again after step 3 so production paging comes back.
2. Wait for the native monitor evaluation, using its history as evidence. Confirm the **TEST: Chalk alert delivery** message in the actual Discord channel, and record the evidence privately.
3. Run `collector --clear-test`, confirm the threshold-closed message, and remove the test notification from the channel when supported. The test events carry no customer data.
4. Query all rule groups and freshness, and confirm the timer remains active.

If the Discord item is absent, finish the code and checks, leave monitors disabled and report delivery as unproved. Never infer receipt from a successful HTTP response from Axiom or a created notifier. Rollback disables the three named monitors and stops only `chalk-alert-state.timer`; it leaves app units alone.

## Discord layout

Axiom's [custom webhook notifier](https://axiom.co/docs/monitor-data/custom-webhook-notifier) exposes Go templates with `Action`, `Value`, `GroupKeys` and `GroupValues`; provisioning sets `Content-Type: application/json`. Axiom joins each result's group columns into one `GroupValues` string, so `GroupKeys` and `GroupValues` are not parallel arrays. The job and connection queries therefore group on one `alert_message` column of newline-delimited Tenant identity, rule, headline, summary, next action and engineer line (the collector strips controls from names; fixed text has no newlines). The template slices at newline byte boundaries and JSON-quotes the message, includes complete messages within a 1,700-byte budget, and adds a counted omission notice pointing to the monitor. That stays under Discord's 2,000-character limit without cutting Unicode or losing a whole batch. Mentions are disabled.

Threshold closure is explicitly **not proof of repair**: the message says the threshold is no longer exceeded and asks an engineer to confirm. The last line is always "For engineers" with a first diagnostic command. A Capture terminal failure does not mean all source is unrecoverable (the completion recovery path can retain source), so no complete video is promised and an engineer checks recoverability immediately. Export messages calculate the earliest source expiry from the Capture completion and the Episode's frozen retention policy; transcripts use their immutable `source_expires_at`; unknown or passed deadlines are stated, never invented.
