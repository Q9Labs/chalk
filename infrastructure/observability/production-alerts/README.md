# Production user-facing alerts

The local Grafana rules do not run in production. Production has Axiom API logs,
API/Sync traces and metrics, Postgres state, and an uptime Worker. CloudWatch
holds transcription Lambda and deployment logs; it does not cover all these
failures. No hosted Grafana was found on the managed runtime host.

Use Axiom's custom webhook notifier with `discord-body.tmpl` aimed directly at the Discord webhook. Three grouped monitors fit the
current monitor allowance. When `ONCALL_WEBHOOK_URL` is set, `provision.py` also reconciles a second
notifier, a free Slack-type one aimed at the Q9 Oncall webhook, and attaches both notifiers to every monitor
(the plan has no custom-webhook feature for a new notifier). The on-call guide for the Chalk SFU alerts,
including the DigitalOcean node-down, CPU, memory and disk alerts that `do-monitoring.sh` sets, is
[sfu-runbook.md](sfu-runbook.md). Keep the live organization, dataset names, monitor
IDs and Discord webhook in private configuration, never in this public repo.

| Rule                          | Production source                        | Evaluation                                                                                                                                                       |
| ----------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recording Capture failed      | `recording_jobs`                         | Terminal failure in the last 15 minutes                                                                                                                          |
| Recording stop stranded       | `sync_recordings`, `recording_pipelines` | Sync still `stopping` more than 2 minutes after capture completed                                                                                                |
| Export failed or overdue      | `recording_jobs`, Render kind            | Terminal failure in 15 minutes, or active for over 14 hours                                                                                                      |
| Transcript failed or overdue  | `transcriptions`                         | Terminal failure in 15 minutes, or active for over 30 minutes                                                                                                    |
| Webhook retries exhausted     | `webhook_deliveries`                     | Exhausted in the last 15 minutes                                                                                                                                 |
| API 5xx rate                  | Axiom API request logs                   | More than 15 server errors in 5 minutes, sustained for 5 evaluations                                                                                             |
| Sync connection failures      | Axiom Sync event spans                   | More than 10 upgrade rejections/abnormal closures in 5 minutes, sustained for 5 evaluations                                                                      |
| Sync stays unready            | Collector HTTP `/readyz` sample          | At least 4 distinct unready minute samples in 5 minutes; latest sample still unready and newer than 90 seconds                                                   |
| Own SFU stays unhealthy       | Collector mutual-TLS `/readyz` samples   | At least 4 distinct unhealthy minute samples in 5 minutes, where a sample is unhealthy when any node is; latest sample still unhealthy and newer than 90 seconds |
| Own SFU retirement debt stuck | Collector read of `sfu_retirement_debts` | Oldest unpaid debt above 15 minutes in at least 4 distinct minute samples in 5 minutes; latest sample still above and newer than 90 seconds                      |
| TURN credentials fail         | Axiom API logs                           | At least 3 `cloudflare_turn.credentials_failed` or `chalk_sfu.turn_credentials_failed` events in 5 minutes                                                       |
| Own SFU recovery refused      | Axiom API logs                           | `chalk_sfu.recovery_refused` logged in at least 3 distinct minutes of the last 5                                                                                 |
| New class left the Chalk SFU  | Axiom API logs                           | At least one `chalk_sfu.overflow` event in the last 2 minutes; the alert names the provider (`cf_sfu` moved, `chalk_sfu` refused) and the placement reason       |

The Capture and Export rules are disjoint: a Render failure only counts as Export. API errors are unsampled in the
production `errors` request-log mode. Sync exports the same named events as spans;
its stdout logs are not required. The API count is the 0.05-errors/second threshold
over a five-minute window, not a percentage of all requests. Sync counts only rejected upgrades and closures explicitly marked `close_kind=abnormal`. Axiom keeps span attributes outside its conventions in the `attributes.custom` map, so the query reads `['attributes.custom']['close_kind']`; `['attributes.close_kind']` is rejected as an invalid field. Normal leaves, acknowledged class ends and server drains are excluded; unclassified older events are not counted. Install the Sync instrumentation before switching the monitor.

## Read-only state collector

`collector.go` is a standalone alert-only executable, not an API service change.
Build from `apps/api` to reuse its pinned pgx version. This standalone Go build
can run locally. Use Go 1.26.10 and target the production host's architecture:
`uname -m` on the host reports `aarch64`, which Go calls `arm64`.

```sh
GOTOOLCHAIN=go1.26.10 go test ../../infrastructure/observability/production-alerts/collector.go ../../infrastructure/observability/production-alerts/collector_test.go
GOTOOLCHAIN=go1.26.10 CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o collector ../../infrastructure/observability/production-alerts/collector.go
file collector
shasum -a 256 collector
```

The collector uses one connection, a read-only transaction and a five-second SQL
timeout. It emits five counts per Tenant plus five empty-Tenant heartbeat rows, including zero values to clear earlier failures. The global Sync readiness row brings coverage to six rules. The global `sfu-retirement-debt` row reads the table `sfu_retirement_debts` in the same read-only transaction, so install the collector only after the API release that runs that migration and after `provision.py --apply` has updated the first monitor (the previous query would page any positive debt age as a generic failure). A failed debt read keeps the other rows but fails the service. When the own SFU probe is enabled, one more global row is emitted (see below), but the freshness monitor does not count it either. Tenant display names and stable Tenant IDs are read at run time and exported to the private Axiom dataset; only names appear in Discord. No job IDs, connection strings, error details or customer payloads are exported. This deliberately reverses the former no-Tenant-data policy; keep attribution in its separate commit for privacy review. A rejected or
partial ingest fails the service. The freshness monitor detects missing snapshots
within five minutes. Latest values, not sums of repeated snapshots, drive alerts. Only snapshots newer than five minutes drive state alerts. The `recording-stop` rule counts completed captures even when the capture job succeeded. It clears when Sync no longer reports `stopping`.

The collector also emits one global `sync-readiness` row per minute from
`http://127.0.0.1:14100/readyz` (override with `CHALK_ALERT_SYNC_READY_URL` in the
private collector environment). HTTP 200 emits zero; other statuses and transport
failures emit one. Redirects are not followed. The HTTP probe is bounded to five
seconds and SQL collection to ten seconds, leaving time to ingest readiness even
when SQL fails; the service still exits unsuccessfully for a failed SQL snapshot.
Only allowlisted reason codes from `dependencies.reason` or the top-level `reason`
are exported. Unknown/malformed responses use `http_<status>`; transport failures
use `unreachable`. No response body, endpoint or exception text is exported.

`sync-readiness.apl` joins the first grouped monitor without adding a fourth
monitor. It takes the latest sample per minute, then alerts on at least four
unready minute samples in the last five minutes while the newest sample remains
unready and is newer than 90 seconds. This minute cadence tolerates a short blip
and timer jitter: the observed 24-second failure cannot page, while the roughly
five-minute outage can. Expect detection after roughly three to four minutes of
unreadiness plus up to one evaluation interval. A healthy sample clears on the
next evaluation, regardless of earlier failed samples. Missing evidence is not
proof of continued unreadiness; the freshness monitor now requires six rules.
Install the updated collector and monitor definitions together. The independent
uptime Worker remains separate and may report individual failed checks.

### Certificate expiry

The collector also emits one global `certificate-expiry` row per run when it has a
certificate to read: the API's SFU client certificate (`CHALK_ALERT_SFU_CLIENT_CERT`, a
file), each node's server certificate (read from a TLS handshake with the same probe as
`sfu-readiness`), and the direct door's certificate when `CHALK_ALERT_DIRECT_DOOR_URL`
(`https://<door host>`, private configuration) is set. With none of these set it emits
no row. The row is 1 when the soonest certificate has 21 days or fewer left, has
expired, or the door cannot finish a TLS handshake; otherwise 0. The 21-day and the
7-day text differ, so the grouped monitor notifies twice, once at each stage. An SFU
node that cannot be reached is the `sfu-readiness` row's concern, so an unreachable
node adds nothing here.

The row needs no monitor change: the grouped monitor already matches every rule that is
not excluded by name. The own SFU certificates are issued by `features/media/sfu/deploy/certs`. The server
certificate lasts 180 days: renew it with `certs <env> server`, then `deploy`. The API's
SFU client certificate lasts 365 days and is a separate target: renew it with
`certs <env> api <key file> <current certificate>`, then install it where the API and
the collector read it. Each handshake verifies normally against the configured CA (the system roots for the door) and the name. A chain that fails only
because a certificate has expired reads as expired, using that certificate's NotAfter; a chain
that fails for any other reason (unknown authority, wrong name) raises an
`untrusted` finding instead of hiding an expiry. A certificate's expiry is the earliest NotAfter along its verified chain: the pinned CA counts for the SFU, a system root does not for the door, so a CA that ends before its leaf sets the date and the finding names the CA, not the server certificate. Renewing the server certificate does not help then. Rotate the service CA instead: move the old `ca.crt` aside and run `certs <env> ca` (the script refuses while one exists, because a new CA orphans every certificate it issued), then reissue the server, API and operator certificates from it and give every node and the API the new client CA and CA file. An intermediate named for the direct door is Let's Encrypt's to rotate; check that Caddy still renews. The checks run in parallel on their
own clock (3 s per node, 8 s in all), so a slow node never delays another alert row.
The direct door's certificate is issued and renewed by its Caddy proxy
over TLS-ALPN-01 on port 443; a warning there means renewal is failing or the chain does not verify, so check the
proxy journal.

### Own SFU readiness

When `CHALK_ALERT_SFU_READY_URL` (one node) or `CHALK_ALERT_SFU_READY_URLS` (a
comma-separated list of nodes) is set, the collector also emits one global
`sfu-readiness` row per run. When both are unset, the collector emits no SFU row,
so a host that has no SFU node behaves exactly as before. The collector probes
every node at once and folds them into that one row: it is unhealthy when any
node is, with the reason of the first unhealthy node in list order. A fleet
therefore pages for a down, draining or admission-closed standby as well as a
primary. Blank entries and a node named in both variables count once; one node
gives exactly the row it gave before the list existed. All nodes share the
certificate, key, CA and server name below. The SFU's `/readyz`
sits on a mutual-TLS (TLS 1.3) listener and answers only to a client certificate
that names the API's service identity. The collector reads that certificate, its
key and the CA from files, so the operator reuses the API's SFU client
certificate on the same host:

| Variable                      | Meaning                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `CHALK_ALERT_SFU_READY_URL`   | Full `https://` URL of one node's `/readyz`; leave unset to disable.                          |
| `CHALK_ALERT_SFU_READY_URLS`  | Comma-separated `https://` URLs, one per node. Use it for a fleet; it adds to the single URL. |
| `CHALK_ALERT_SFU_CLIENT_CERT` | PEM file with the API's SFU client certificate.                                               |
| `CHALK_ALERT_SFU_CLIENT_KEY`  | PEM file with its private key.                                                                |
| `CHALK_ALERT_SFU_CA`          | PEM file with the CA that signed the SFU's server certificate.                                |
| `CHALK_ALERT_SFU_SERVER_NAME` | Name in the SFU's certificate, `chalk-sfu`, as `CHALK_SFU_SERVER_NAME` for the API.           |

The probe has the same five-second bound as the Sync probe and does not follow
redirects. HTTP 200 with admission open and spare budget emits zero with reason
`ready`. Everything else emits one, with the first matching reason of
`tls_config` (the URL is not `https://`, or a certificate, key or CA file is unset, unreadable or invalid),
`unreachable` (connect, handshake or timeout failure), `draining` (503),
`http_status` (any other non-200), `invalid_response` (body is not the expected
shape), `admission_cpu_steal`, `admission_cpu_busy`, `admission_scheduler_latency`,
`admission_pacer_drops` or `admission_udp_buffer_errors` (the node refuses
new Episodes), and `packet_budget` (reserved packets are at least 90% of the
packet budget). A configured probe therefore fails closed: a missing file pages
instead of silently turning the rule off. Only these reason codes are exported.
No TLS or HTTP error text, response body, endpoint, node incarnation or other
identifier leaves the probe.

`sfu-readiness.apl` has the same shape as `sync-readiness.apl` and joins the
first grouped monitor through `${SFU_READINESS_BRANCH}`, so the three-monitor
allowance is unchanged. It alerts on at least four unhealthy minute samples in
five minutes while the newest sample is unhealthy and newer than 90 seconds. That
is the intent of alerting when admission has been closed for more than five
minutes, or when a node sits above 90% of its packet budget. Live calls continue
while only admission is closed, so the message says new calls may fail to start.

`sfu-retirement-debt.apl` has the same shape. The collector emits the age in
seconds of the oldest unpaid retirement debt (0 when none is owed), so a debt
the API pays within seconds never rises near the limit. The API `/readyz` body
carries the same number as `sfu_retirement_debts.oldest_age_seconds`, per replica.

`turn-credentials.apl` and `recovery-refused.apl` read the API log, like the
deadline scheduler rule, and join the first grouped monitor. The first counts
`cloudflare_turn.credentials_failed` and `chalk_sfu.turn_credentials_failed`
together (after the Cloudflare SFU is retired only the second remains), because
either one means a join fell back to STUN only. The second counts distinct
minutes with `chalk_sfu.recovery_refused`, because each retrying caller logs
one refusal and a sustained outage matters more than one burst. Their alert text
names no Tenant, Episode, node or address. The own SFU's placement outcomes
(`no_capacity`, `overflow_*`) are a metric only and have no rule here: no log line
records them, so a log twin is a separate change.

All thresholds of the SFU rules beyond the readiness shape live in `THRESHOLDS`
in `provision.py`, each with the documented number it comes from. The APL files
read them as placeholders, and `provision.py` refuses a query with an unresolved
placeholder.

`deadline-scheduler.apl` reads the API log, not the collector. Each skipped
Episode logs `episode.deadline_scheduler.failed` with `tenant_id`, `episode_id`,
`phase`, `reason` and `consecutive_failures`, and the rule joins the first grouped
monitor through `${DEADLINE_SCHEDULER_BRANCH}`. It alerts when the same Episode
fails more than five passes in a row. A `control_busy` skip waits for another
operation's publication fence, which Sync normally releases within seconds, so
that reason alerts only after sixty passes. A failure of a whole pass has no
Episode and uses `reason=cycle_error`. Axiom refuses to save a monitor that names
a field its dataset has never received, and `consecutive_failures` and `phase`
exist only once the API that logs them is deployed, so the query reads those two
through `column_ifexists` with defaults that never alert.

The freshness monitor still expects six rules and does not list
`sfu-readiness` or `sfu-retirement-debt`. The SFU readiness row exists only on hosts that enable the
probe, so counting it would page every host without an SFU; the debt row is written by the same
database read as the other rows, so a stopped collector is already caught. Once enabled, the probe always
emits a row (a failure is a value of one, never a missing row), so a stopped
collector is still caught by the six existing rules and the SFU needs no
freshness entry of its own.

To enable it on the collector host:

1. Copy or reference the API's SFU client certificate, key and CA at paths the
   collector's User can read, with the key mode `0600`. Do not commit them or put
   them in SSM command bodies.
2. Add the variables to the private `/etc/chalk-alerts/collector.env`: the URL of
   the node (`CHALK_ALERT_SFU_READY_URL`) or of every node
   (`CHALK_ALERT_SFU_READY_URLS`), plus the certificate, key, CA and server name.
3. Run `collector --check` and confirm one `sfu-readiness` row with value 0 and
   reason `ready`, however many nodes are listed.
4. Run `provision.py --apply` to reconcile the monitor, which already contains the
   SFU branch. Until a row exists, the branch matches nothing and cannot alert.

Roll out the collector before the SFU carries production traffic, and set the
variables when the first production node is deployed. To disable the alert, remove
`CHALK_ALERT_SFU_READY_URL` and `CHALK_ALERT_SFU_READY_URLS` and restart the timer: the rows stop and the branch
stays idle. For engineers, the alert message points at `/readyz` through the SFU
deploy tunnel and the node's `media telemetry` journal lines.

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
confirm all per-Tenant snapshots, five heartbeat rows, the global Sync readiness row (and the SFU row when enabled) in Axiom, and enable `chalk-alert-state.timer`.
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

| Failure                     | Accepted report                                                                                                                                | Threshold                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `join_failed`               | Trigger `join_failed`, without a `media_start_failed` diagnostic                                                                               | At least one affected participant in ten minutes |
| `media_start_failed`        | Trigger `join_failed`, with a `media_start_failed` diagnostic                                                                                  | At least one affected participant in ten minutes |
| `media_recovery_exhausted`  | Trigger `recovery_exhausted`, with a `media_recovery_exhausted` diagnostic                                                                     | At least one affected participant in ten minutes |
| `media_projection_mismatch` | Trigger and diagnostic event `media_projection_mismatch`, source `microphone` or `camera`, publication/projection states opposite (`on`/`off`) | At least one affected participant in ten minutes |
| `audio_receive_stuck`       | Trigger and diagnostic event `audio_receive_stuck`, source `microphone` or `screen_audio`                                                      | At least one affected participant in ten minutes |

Each rule groups by Tenant ID, Episode ID and failure. Repeated uploads and
multiple matching diagnostics count once per participant within that group.
Mismatch reports also group by source, so camera and microphone details stay
separate; opposite mismatch directions still count once per participant/source.
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

Messages name the provider (`cloudflare_sfu` or `chalk_sfu`) from the participant's
media credential, so a page says which provider failed. Anything else, including
logs written before the field existed, shows `unknown`. An `audio_receive_stuck`
message shows the source and the furthest receive state the SDK reached. The SDK
sends that report only after a publication stayed unhealthy for more than ten
seconds, once per unhealthy episode and at most eight per media session, so the
rule needs no extra duration.

Messages also show `media_error_kind` and `media_error_step` from the latest
affected participant report, selecting that report's last diagnostic with either
cause field. Missing fields in older SDK reports display `unknown`, not a guessed
permission or network cause. Causes do not split the affected-participant count;
a changed latest cause can open a new notification group.

Mismatch messages show the latest affected report's source, `publication_state`
and `projection_state` as publication/projection on or off, `duration_ms` in
milliseconds and `attempt`. Missing optional duration/attempt fields display
`unknown`. The first-report time remains PKT. The explicit mismatch event is the
SDK's persistent-mismatch signal; transient `media_state` diagnostics, matching
states and a local mic icon alone do not page. These rules can deploy before the
mismatch-report contract: the mismatch predicate simply matches nothing until
the SDK/API emit accepted reports with that trigger and diagnostic event.

## Reconcile the native monitors

Load these values privately: `AXIOM_TOKEN` (monitor/notifier management),
`AXIOM_ORG_ID`, `LOG_DATASET`, `TRACE_DATASET`, and `DISCORD_WEBHOOK_URL`, plus
`ONCALL_WEBHOOK_URL` to attach the Oncall notifier (leave it unset to reconcile Discord only).
The Discord URL lives in 1Password vault `dev`, item
**Chalk production alerts Discord webhook**; the Oncall URL is the item **Oncall webhook URL**.

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

All Axiom rules share one route: Axiom monitor → custom webhook notifier → Discord, and, when attached, Axiom monitor → Slack-type notifier → Oncall.
A direct webhook POST proves the endpoint only, not this route.

1. With production monitors enabled, run `collector --test`. This emits a dedicated
   `delivery-test` group, with no database write or induced user failure. The test
   reaches every notifier on the monitor, so it would also start an Oncall run. To keep
   Oncall out, first run `provision.py --apply` without `ONCALL_WEBHOOK_URL` (that
   detaches the Oncall notifier), and run it again with the URL after step 3.
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
