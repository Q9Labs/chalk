# Production user-facing alerts

The local Grafana rules do not run in production. Production has Axiom API logs, API/Sync traces and metrics, Postgres state and an uptime Worker. CloudWatch holds transcription Lambda and deployment logs and does not cover these failures.

The three Axiom monitors evaluate every minute, and the API readiness and the goal check read their state. They can share one delivery target. Three grouped monitors fit the current monitor allowance (the free Axiom plan allows three), so a new rule joins an existing monitor instead of adding a fourth. The runbook for the Chalk SFU alerts, including the DigitalOcean node alerts `do-monitoring.sh` sets, is [sfu-runbook.md](sfu-runbook.md). Keep the live organization, dataset names and monitor IDs in private configuration, never in this repo.

The rules are the `.apl` queries, `monitors.json`, `state.sql` and the thresholds in `provision.py`. Judgment behind them:

- The Capture and Export rules are disjoint: a Render failure only counts as Export.
- API errors are unsampled in the production `errors` request-log mode, and the API threshold is 0.05 errors/second over five minutes, not a percentage of requests. Sync counts only rejected upgrades and closures marked `close_kind=abnormal`; normal leaves, acknowledged class ends and server drains are excluded. Axiom keeps span attributes outside its conventions in `attributes.custom`, so the query reads `['attributes.custom']['close_kind']` (`['attributes.close_kind']` is rejected). Install the Sync instrumentation before switching the monitor.
- The outage rules (`sync-readiness`, `database-unreachable`, `runtime-health` in `readiness.apl`) are judged per rule on the latest sample per minute. They alert on at least three unhealthy minute samples in four minutes while the newest is unhealthy and newer than 90 seconds, so a total outage turns the monitor red about three to four minutes after Sync stops. `database-unreachable` is value 1 when the collector cannot connect to or read the database, so it is the one row that still carries the failure when the database is down. `runtime-health` probes the API and the tunnel the way the host watchdog does. A rule that stays red repeats its message every 30 minutes, because the message carries a 30-minute time bucket that changes the notification group.
- The Chalk SFU state rules take the latest sample per minute and alert on at least four unhealthy minute samples in five minutes while the newest is unhealthy and newer than 90 seconds. That tolerates a short blip and timer jitter (a 24-second failure cannot page, a roughly five-minute outage can) and gives detection after about three to four minutes plus one evaluation interval. A healthy sample clears on the next evaluation. Missing evidence is not proof of continued failure.
- Rules that read the API log (`turn-credentials.apl`, `recovery-refused.apl`, `deadline-scheduler.apl`, `sfu-node-too-old.apl`, `fleet-controller.apl`) have alert text that names no Tenant, node or address. Axiom refuses to save a monitor naming a field its dataset has never received, so `deadline-scheduler.apl` reads `consecutive_failures` and `phase` through `column_ifexists` with defaults that never alert. A `control_busy` skip waits on a publication fence that Sync normally releases in seconds, so it alerts only after sixty passes. Chalk SFU placement outcomes are a metric only, with no rule, because no log line records them.
- All SFU thresholds beyond the readiness shape live in `THRESHOLDS` in `provision.py`; the APL files read placeholders, and `provision.py` refuses a query with an unresolved one.

## Read-only state collector

`collector.go` is a standalone alert-only executable, not an API change. Build it from `apps/api` to reuse the pinned pgx, with Go 1.26.11, targeting the host (`aarch64` is Go's `arm64`):

```sh
GOTOOLCHAIN=go1.26.11 go test ../../infrastructure/observability/production-alerts/collector*.go
GOTOOLCHAIN=go1.26.11 CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o collector $(ls ../../infrastructure/observability/production-alerts/collector*.go | grep -v _test)
```

It uses one connection, a read-only transaction and a five-second SQL timeout. It emits per-Tenant counts (zeros included, so latest-value evaluation clears an old count immediately) plus empty-Tenant heartbeat rows and global rows for Sync readiness, SFU retirement debt and, when enabled, SFU readiness and certificate expiry. A rejected or partial ingest fails the service. The freshness monitor detects missing snapshots within five minutes and counts six rules; it does not count the SFU rows. The SFU readiness row exists only on hosts that enable the probe, so counting it would page every host without an SFU. The debt row comes from the same database read as the others, so a stopped collector is already caught. Only snapshots newer than five minutes drive state alerts.

Install the collector only after the API release that runs the `sfu_retirement_debts` migration and after `provision.py --apply` has updated the first monitor, otherwise the previous query pages any positive debt age as a generic failure. Install the updated collector and monitor definitions together.

Tenant display names and stable IDs are read at run time and exported to the private Axiom dataset; only names appear in alert messages, capped at 80 characters with control and chat formatting characters stripped, and mentions disabled. Names may reveal internal tests but no rule suppresses a Tenant by name. No job IDs, connection strings, error details or customer payloads are exported. API and Sync events have no safe Tenant attribution, so their messages say so rather than guess.

The collector also probes Sync at `http://127.0.0.1:14100/readyz` (override with `CHALK_ALERT_SYNC_READY_URL`): 200 emits zero, anything else one. Redirects are not followed, the HTTP probe is bounded to five seconds and SQL to ten, so readiness is still ingested when SQL fails. Only allowlisted reason codes are exported; no body, endpoint or exception text.

### Certificate expiry

When the collector has a certificate to read (the API's SFU client certificate in `CHALK_ALERT_SFU_CLIENT_CERT`, each SFU node's server certificate via the `sfu-readiness` handshake, and the direct door's when `CHALK_ALERT_DIRECT_DOOR_URL` is set) it emits one global `certificate-expiry` row: 1 when the soonest has 21 days or fewer left, has expired, or the door cannot finish a TLS handshake. The 21-day and 7-day texts differ, so the grouped monitor notifies twice. An unreachable SFU node is `sfu-readiness`'s concern and adds nothing here.

Server certificates last 180 days (`certs <env> server`, then `deploy`); the API's SFU client certificate lasts 365 days and is a separate target (`certs <env> api <key file> <current certificate>`, then install it where the API and collector read it). A chain failing only because of expiry reads as expired; any other failure (unknown authority, wrong name) raises `untrusted` instead of hiding an expiry. Expiry is the earliest NotAfter along the verified chain, with the pinned CA counting for the SFU but a system root not counting for the door. If the CA ends before its leaf, renewing the server certificate does not help: move the old `ca.crt` aside, run `certs <env> ca` (it refuses while one exists, because a new CA orphans everything it issued), reissue the server, API and operator certificates, and give every node and the API the new CA. The direct door's certificate is issued and renewed by its Caddy proxy over TLS-ALPN-01 on port 443, so a warning there means renewal is failing; check the proxy journal. Checks run in parallel (3 s per node, 8 s total), so a slow node never delays another row.

### Chalk SFU readiness

When `CHALK_ALERT_SFU_READY_URL` (one node) or `CHALK_ALERT_SFU_READY_URLS` (comma-separated) is set, the collector emits one global `sfu-readiness` row per run, unhealthy when any node is, with the reason of the first unhealthy node in list order (so a fleet pages for a down or draining standby too). With both unset it emits nothing. All nodes share `CHALK_ALERT_SFU_CLIENT_CERT`, `CHALK_ALERT_SFU_CLIENT_KEY`, `CHALK_ALERT_SFU_CA` and `CHALK_ALERT_SFU_SERVER_NAME` (the SFU name, as `CHALK_SFU_SERVER_NAME`). The SFU's `/readyz` is a mutual-TLS 1.3 listener that answers only a client certificate naming the API's service identity, so the operator reuses the API's SFU client certificate on the same host.

The probe has a five-second bound and follows no redirects. A configured probe fails closed: a missing file pages instead of turning the rule off. Reasons are `ready` (0), `tls_config`, `unreachable`, `draining`, `http_status`, `invalid_response`, the `admission_*` reasons (the node refuses new Episodes) and `packet_budget` (reserved packets at least 90% of budget); only these codes leave the probe, never error text, bodies, endpoints or node identifiers. Live calls continue while only admission is closed, so the message says new calls may fail to start. The alert message points engineers at `/readyz` through the SFU deploy tunnel and the node's `media telemetry` journal lines.

To enable it: place the certificate, key (mode 0600) and CA where the collector's User can read them, never in git or SSM command bodies; add the variables to the private `/etc/chalk-alerts/collector.env`; run `collector --check` and confirm one `sfu-readiness` row with value 0 and reason `ready`; run `provision.py --apply`, since the monitor already contains the branch. Roll the collector out before the SFU carries production traffic. To disable, remove both URL variables and restart the timer: the rows stop and the branch idles. The step-by-step production-host procedure is in [sfu-runbook.md](sfu-runbook.md#the-readiness-probe-on-the-production-host).

### Install

Install the binary at `/opt/chalk-alerts/collector` and the units in `/etc/systemd/system`. The service reuses `/run/chalk/env/api.env` under the existing runtime User, reads `CHALK_DATABASE_URL`, and derives its ingest token and dataset from `OTEL_EXPORTER_OTLP_LOGS_HEADERS`; it changes neither that file nor any app unit. The `runtime-health` row probes the tunnel only when the host has the connector Quadlet (`chalk-cloudflared.container` under the runtime User's `~/.config/containers/systemd`), like `chalk-runtime-health`; `CHALK_ALERT_TUNNEL_QUADLET` names another path. Optional private `/etc/chalk-alerts/collector.env` can override `CHALK_ALERT_AXIOM_TOKEN` and `CHALK_ALERT_LOG_DATASET`. Prefer a dedicated read-only database credential; the transaction forbids writes regardless. Keep credentials out of SSM command bodies and CI output.

Before enabling the timer, run `collector --check` and verify the per-Tenant counts against Postgres, run the service once and confirm the snapshots, heartbeat rows and global rows in Axiom, then enable `chalk-alert-state.timer`. Install only these alert files; never run an application deployment controller for it.

A managed release replaces only the managed runtime files and leaves `/opt/chalk-alerts` and the root alert units intact (the controller regression suite checks this), and the collector is ordered after the runtime restore service so the private environment is back first. There is no managed host-replacement path: a genuinely new host needs this installation repeated, and the freshness monitor detects a missing collector meanwhile.

## Connection-report rules

[connection-reports.apl](connection-reports.apl) joins the first monitor and uses the three-monitor allowance. It covers `join_failed`, `media_start_failed`, `media_recovery_exhausted`, `media_projection_mismatch` and `audio_receive_stuck` reports, grouped by Tenant ID, Episode ID and failure. An SDK from before client telemetry replays earlier events in every report, so a row from the old routes counts only for the failure its report's trigger names.

- Only accepted `sdk.telemetry` API events count, and each one is classified alone from its `type`, `code` and `state` (a report from an older SDK is translated into the same events). Rejected uploads, ordinary state changes, connection-loss reports and retries that recover do not, but permission or device failures that stop a join do; do not hide a real class failure as noise.
- Repeated uploads and multiple diagnostics count once per participant. A failed media start is the more specific join-failure category, not a second alert for the same join.
- One affected participant in ten minutes pages, because waiting for several people would miss a single-person class interruption. The window tolerates ingestion delay and deduplicates repeats; it is not a delivery guarantee (an offline client, rate limit, broken exporter or rejected report can still prevent an alert). The monitor checks every minute with one positive run, per-group notifications, no repeat-every-run and no no-data alert.
- `audio_receive_stuck` is sent once per unhealthy episode, at most eight per media session, after a publication stayed unhealthy for over ten seconds, so the rule needs no extra duration. The mismatch predicate matches nothing until the SDK and API emit accepted reports with that trigger, so the rules can deploy first.
- `chat_upload_failed` (the `chat_upload_failed` event, sent by the SDK when a chat attachment upload fails) is the one rule that waits for a wave: it pages when three distinct participants of one Tenant report the same cause in ten minutes, because a single failed upload is usually one bad network. It groups by Tenant and cause (`initiate_failed`, `finalize_failed`, `storage_rejected`, `storage_unreachable`); `storage_unreachable` across several browsers that otherwise work points at the bucket CORS rule. Like the mismatch rule it matches nothing until the SDK and API emit the trigger.
- Messages carry the sanitized Tenant name and stable ID (the ID alone if no matching snapshot exists), Episode ID, failure, affected-participant count and first report time in **PKT**, the provider (`cloudflare_sfu`, `chalk_sfu`, else `unknown`), and the latest report's `media_error_kind` and `media_error_step` (`unknown` for older SDKs, never a guessed cause). Counts and the evaluation clock stay out of the notification group; a continuing incident can open a new group when the oldest report ages out, the Tenant name changes or the latest cause changes. Threshold closure is not proof anyone recovered.
- Install the collector (which exports `chalk_alert_tenant_name`) before enabling these rules.

## Reconcile the native monitors

Load these privately: `AXIOM_TOKEN` (monitor management and notifier read access), `AXIOM_ORG_ID`, `LOG_DATASET` and `TRACE_DATASET`. Before applying to production, create the custom webhook notifier named **Chalk alert triage** in Axiom. Store the webhook URL in 1Password and in the Axiom notifier, never in this repo or the provisioner's environment.

```sh
python3 infrastructure/observability/production-alerts/provision.py
python3 infrastructure/observability/production-alerts/provision.py --apply --disabled
# Enable only after the collector snapshots are verified:
python3 infrastructure/observability/production-alerts/provision.py --apply
# Read the live monitors and list every difference from this folder (exit 1 on any); run it after every apply and on a schedule:
python3 infrastructure/observability/production-alerts/provision.py --check
```

This folder is the only source of the monitors. A change made in the Axiom console shows up as `DRIFT` in `--check`; put it here or undo it there. `--check` compares the query text (whitespace collapsed), thresholds, intervals, flags and notifier assignments. Both apply and check resolve the named notifier in Axiom, so all three monitors must have exactly that notifier without a machine-specific ID. A missing, ambiguous or wrong-type notifier stops reconciliation before any monitor is changed. To detach delivery without disabling evaluation, run `--apply --without-notifier` and verify with `--check --without-notifier`. Normal apply reattaches the notifier if it exists.

Install the collector that writes `database-unreachable` and `runtime-health` before the first `--apply` of these queries. The staleness monitor watches both rules, so applying it first turns the monitor red once per missing rule.

For a release that keeps existing alerts enabled, validate with the first command, install the updated collector, then run the final `--apply`. Never stage all monitors with `--disabled` during a live class. Confirm the native monitor evaluation after release.

To undo only the connection-report rules, keeping the previous job, traffic and freshness queries enabled, run `provision.py --apply --without-connection-reports` with the same private environment. It leaves the collector's harmless name field in place and does not disable the collector or any app unit.

Only the three exact monitor names are reconciled; unrelated configuration is untouched. The fleet-controller rule is part of the first monitor. The state and traffic monitors group per rule and treat no data as not a failure; the third monitor lists the rules that wrote no row in three minutes and alerts for each one on its own, so one stopped probe cannot hide behind the others. A lost host writes no rows, so this is the signal for a lost Sync host. Exporter health stays with the uptime Worker and existing telemetry checks.

## Check the monitors and the collector

Run `provision.py --check` after every apply and on a schedule: it reads the live monitors and exits 1 on any difference. Confirm the monitor evaluation from its history in Axiom, and query every rule group and its freshness. Run `collector --test` and `collector --clear-test` to write a `delivery-test` group with no database write or induced failure. With the notifier attached, verify that the test reaches the Captain thread; without it, the test only proves the rows reach the dataset and the monitors read them. To roll back monitor evaluation, disable the three named monitors and stop only `chalk-alert-state.timer`; leave app units alone.
