# Chalk Observability, Uptime, and Status Spec

Status: Ratified companion to the infrastructure readiness spec.

Parent: `scratchpad/chalk-infrastructure-readiness-spec-2026-07-11.md`. Its
settled decisions, canonical terms, and anti-slop rules bind this document.
The telemetry rows of the data-lifecycle matrix and the failure-behavior
table remain in the parent.

Owner: Hasan Shoaib

## Purpose and scope

This spec defines the telemetry contract and its ownership boundary, the
component uptime services and their probe topology, the Grafana Cloud backend
and its environment isolation, signed monitor-result ingestion, the public
status projection, alerting severities and delivery, the component state
machine with its freshness budgets, and the drills that prove
monitoring-of-monitoring before staging can pass.

## Telemetry contract and lane boundary

The observability lane supplies the application telemetry contract and its local
end-to-end proof. It standardizes a stable `journey_id`, W3C trace context,
client/API/sync/RTC/monitor/webhook signals, the durable PostgreSQL
`observability_journey_events` ledger, OpenTelemetry export, and a reproducible
Grafana operations surface across metrics, traces, logs, profiles, and journey
events. The same reviewed definitions create one surface in each environment
account. Its telemetry-pipeline canary emits and reads back metric, trace, and
log paths; the application gates verify the durable journey ledger.

The checked-in `grafana/otel-lgtm` stack is development and verification
infrastructure. It must not run on an application node or be promoted as a
production backend. Production credentials, collector routing, backend choice,
retention, volume limits, alerts, and notification delivery belong to this
infrastructure lane.

| Boundary                    | Application and observability ownership                       | Infrastructure ownership                                                     |
| --------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Signal creation             | Semantic fields, `journey_id`, spans, metrics, logs, profiles | Release/environment/resource attributes and cardinality budgets              |
| Durable operational events  | Journey-ledger schema and writes                              | Database role, migration gate, retention, backup, and deletion policy        |
| Signal transport            | Bounded OTLP exporters and application backpressure behavior  | Collector deployment, credentials, egress, queues, sampling, and drop alerts |
| Operational interpretation  | Journey and subsystem semantics                               | Backend, dashboards, recording rules, SLO reports, and deploy annotations    |
| Availability verification   | Safe canary APIs and deterministic expected outcomes          | Schedules, runners, synthetic identities, isolation, alerting, and drills    |
| Public incident information | Public-safe component vocabulary                              | Sanitized status projection, incident controls, hosting, and freshness       |

## Component uptime services

One Grafana surface per environment is that environment's correlation boundary.
It is not the uptime failure boundary. Production and staging use independently
scheduled component services so one broken monitor, credential, deployment, or
fallback buffer cannot mark unrelated components healthy or suppress their
checks. Operators switch between equivalent staging and production surfaces;
the Free accounts do not provide a cross-account federated view.

| Uptime service      | Required outcome                                                                                              | Suitable probe path                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Web edge            | DNS, TLS, Pages shell, runtime-config schema/digest, asset, and live release identity                         | External HTTP plus a lightweight browser navigation                 |
| API control plane   | Liveness and a safe authenticated create/read/delete canary with full journey correlation                     | External scripted HTTP using a dedicated synthetic tenant           |
| Sync realtime       | TLS/WebSocket upgrade, signed auth, join, heartbeat, snapshot revision, and bounded reconnect                 | External scripted WebSocket client                                  |
| Media               | Two clients publish and receive a playable remote track with transport and provider attribution               | Scheduled real-browser/WebRTC runner outside the app node           |
| Artifacts           | A canary recording/transcript reaches its terminal state and its object is authorized and cleaned             | Launch-required recorder/browser workflow                           |
| Telemetry pipeline  | Metric, trace, log, and journey-ledger paths are fresh and queryable; enabled profiles have a freshness check | The observability canary plus application ledger and profile checks |
| Status and alerting | Component projection, monitor heartbeats, and notification delivery remain fresh                              | External status check plus a synthetic alert-delivery drill         |

Common probe libraries and result schemas are encouraged. Each service retains
its own schedule, deployment identity, minimum credentials, timeout budget,
last-success heartbeat, fallback buffer, and alert labels. Staging and
production instances never share synthetic users, secrets, state, targets, or
deployment permissions. A dependency map correlates shared failures such as
DNS, Tunnel, database, SFU, or telemetry-backend outages while preserving every
component result. Aggregate state cannot be green when a required component or
its monitor heartbeat is failed or stale.

## Environment isolation

Telemetry ingestion is isolated by an environment trust boundary, not by a
caller-supplied label. Staging and production use separate company-controlled
Grafana Cloud accounts and Free stacks. Account- and stack-scoped credentials
derive and overwrite environment and monitor identity and reject
cross-environment labels. No organization access policy, service account,
synthetic identity, recovery factor, or automation token spans the accounts.
One environment can never write another environment's telemetry, alerts,
journey records, or status.

## Probe release rollout

Shared probe releases roll out to staging, then one production component, then
the remaining production components. Result schemas remain backward compatible
across the rollout window, and each service pins its own verified version. A bad
shared library or ingestion schema must turn affected monitor state to unknown
or stale rather than leaving the last green result current.

## Synthetic monitoring topology

The selected launch topology uses an external managed synthetic provider as
the primary black-box path outside both Cloudflare and the Chalk AWS account.
Small Cloudflare Worker services provide a second vantage for protocols they can
exercise faithfully. Web, API, sync, and status Workers are separate services
per environment and share only tested library code. Chalk uses Workers Paid so
all eight minimum services own independent Cron Triggers; the design never packs
component checks back into one scheduled handler to avoid the plan fee. Media
and artifact checks use a real-browser runner because an HTTP-only Worker cannot
prove a remote WebRTC outcome. The selected runner must prove two coordinated
clients, fake or controlled media input, a playable remote track, cleanup, and
its actual billed execution unit before its cadence or cost is accepted. At
least one notification route remains usable during a Cloudflare account or
app-node failure. The launch route is email delivered by Grafana Alerting to an
environment-specific operator address. The address is a private provider
binding held outside the public repository; staging and production contact
points, credentials, and notification-policy state remain isolated. Discord is
not a launch dependency.

## Grafana Cloud backend

Grafana Cloud is the selected managed telemetry and external-synthetic backend
because it accepts the branch's OTLP contract and avoids operating Tempo, Loki,
Prometheus, Pyroscope, and Grafana on new compute. Chalk uses two
company-controlled Free accounts, each with one stack: one for staging and one
for production. Both keep 14 days of metrics, logs, traces, and profiles and
have independent users, MFA, recovery material, access policies, quotas, alerts,
and synthetic allowances. Dashboard, alert, and recording-rule definitions are
promoted from staging to production as reviewed code, while their state and
credentials remain separate.

Grafana's public documentation states that each Free account is limited to one
stack but does not expressly confirm or forbid one company owning separate Free
accounts for isolated environments. Before either account becomes an
infrastructure dependency, the provisioning gate records Grafana's then-current
terms or written confirmation that this arrangement is permitted. Permission is
a hard dependency. If the arrangement is not permitted, the M0 de-risk
milestone blocks and this spec returns to discussion for a newly ratified
telemetry backend. No workflow shares production credentials, combines the
environments, weakens staging parity, or upgrades to Pro automatically.

## Replacing the existing uptime Worker

The existing uptime Worker is not deploy-ready. It combines all checks into one
HTTP-only schedule, uses pre-canonical targets, depends on an ingest route that
does not exist in the current application, and shares one run summary and
fallback stream. The current status route is also blank. The implementation
replaces this contract with the component services above and proves signed
result ingestion, replay, freshness, and independent failure before staging can
pass.

## Signed monitor results

Every monitor result uses a bounded signed envelope containing the credential-
derived monitor ID, environment, component, unique result ID, issued and expiry
times, target release, payload digest, outcome, and check timing. Ingestion
rejects oversized, expired, future-dated, duplicate, revoked, cross-environment,
and unauthorized-component envelopes. Signing-key rotation overlaps only for a
bounded window; revocation, delayed replay, duplicate delivery, and fallback
replay are staging tests.

## Public status projection

The public status projection reads a sanitized monitoring store rather than the
product API or raw telemetry backend. It exposes component state, incident
state, last successful check time, and planned maintenance without customer,
credential, internal-host, or raw-error data. Manual incident changes require
strong authentication, an audit event, and expiry. The status renderer and data
path survive an app-node or API outage, and an external check detects stale
status data.

The selected public path uses `status.chalkmeet.com` on a dedicated Cloudflare
Pages project, a dedicated status Worker, and a private status R2 bucket. The
Worker owns signed-result ingestion and manual incident mutation; the bucket
holds only the sanitized current projection and append-only public-safe incident
audit objects. This path survives a product Pages deploy, API outage, and
app-node loss. Its DNS, ingestion, store, mutation, and renderer share the
accepted Cloudflare failure domain. During a Cloudflare-wide outage the public
status page may be unreachable. External Grafana probes and a non-Cloudflare
paging destination remain the operator signal and explicitly report the shared
provider failure.

## Alerting and notifications

Production notifications use three severities. Critical means the production
user path is unavailable, acknowledged data is at risk, recording is being
lost, or an automated recovery has exhausted its bound; Grafana emails
immediately and repeats every 15 minutes while the alert remains unacknowledged.
Warning means capacity, dependency, deadline, cleanup, drift, or cost headroom
is degraded; Grafana emails on transition and repeats after one hour if it
remains unresolved. Informational transitions remain in the dashboard and
deployment evidence and do not email by default. Staging alerts email for gate
failures, leaked paid resources, broken monitoring, and security or data-safety
conditions; ordinary synthetic failures remain in the staging operations
surface unless they repeat.

Every actionable email includes the environment, component, severity,
customer-visible effect, first and latest observation, current release,
automated recovery already attempted, dashboard or evidence link, and the
versioned runbook reference. The runbook names the owning operator, safe first
actions, replacement or rollback boundary, silence duration and authority, and
the evidence required to resolve the alert. Acknowledgement and silencing never
change the public component state. With one launch operator, an unacknowledged
email remains visibly unacknowledged; the system does not claim that a backup
human responded.

M0 verifies that Grafana can deliver to the selected mailbox without a
Cloudflare dependency and records any provider cost. Staging proves initial,
repeat, recovery, and test notifications by observing receipt in that mailbox.
Production activation requires a fresh synthetic notification received at the
private production address. Email is an accepted lean-launch limitation: it is
not guaranteed to interrupt a sleeping or offline operator, so a later
push/SMS/phone escalation is a reviewed availability improvement rather than a
claim made by this baseline.

## Component state machine and freshness budgets

Initial component state and freshness budgets are:

| Component class                  | Production check budget                           | Public and alert transition                                                                              |
| -------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Web, API, sync, and status       | Every 5 minutes; result within 30 seconds         | One explicit failure is degraded; two are outage; missing heartbeat after 7 minutes is unknown/stale     |
| Media                            | Every 15 minutes; result within 3 minutes         | One explicit failure is degraded; two are outage; missing heartbeat after 20 minutes is unknown/stale    |
| Artifacts                        | Daily and after every relevant deploy             | One failed terminal workflow is degraded; two are outage; no result within 26 hours is unknown/stale     |
| Metric, trace, and log pipelines | Canary every minute; each path fresh in 5 minutes | A stale path is degraded immediately and outage after 10 minutes; healthy sibling signals cannot mask it |

Staging uses the same state machine with lower-cost cadence where noted in the
dated cost sheet. `Operational` requires two consecutive successes. `Degraded`
means a target explicitly failed once or only one external location failed.
`Outage` means the target explicitly failed its confirmation threshold.
`Unknown` means the monitor, ingestion, or projection heartbeat is stale, so
the last green result is no longer evidence. Planned maintenance is separate
and expires automatically. Recovery requires two consecutive successes. An
accepted monitor result reaches alert evaluation and the public projection
within 2 minutes; status data shows its observed time and freshness.

`Dormant` is available only to staging. It is valid only while a signed
activation record says desired capacity is zero, cleanup is complete, and its
short-lived dormant assertion is still current. The target checks remain
scheduled during that state and report `Dormant` only after validating the
lease generation, controller heartbeat, cleanup state, assertion expiry, and
target absence. An unexpected target response, stale controller, cleanup
failure, or expired assertion changes the environment to unknown and alerts on
lease drift. Activation clears `Dormant` before readiness evaluation begins.

## Monitoring drills

Staging drills disable each component monitor, the Cloudflare-hosted probe path,
the external path, the telemetry backend, and an alert destination separately.
The drill also injects a shared-library and result-schema regression across
multiple monitors. It proves monitoring-of-monitoring, bounded replay, component
attribution, fail-unknown behavior, expected public-status unavailability during
a Cloudflare-wide failure, and external delivery through the surviving route.

## Availability target

The observability lane's 99.95 percent availability target remains a candidate,
not a launch commitment. A single-node topology and reconnecting deploys must
first demonstrate that planned and unplanned interruption fits the ratified
error budget. Reports separate edge, API, sync, media, artifacts, telemetry, and
status availability rather than averaging them into a healthy-looking number.

## Launch readiness dependencies

Before staging can pass:

- the observability lane is merged and its repository gate remains green;
- the `observability_journey_events` migration is applied and verified through
  the same migration ledger as every other schema change;
- production journey intake has tenant/data-class attribution, operator-only
  read authorization, ratified retention/erasure, and an isolated connection
  budget; the current unattributed v1 intake cannot be enabled by configuration
  alone;
- web, client SDK, API, sync, monitor, and webhook telemetry carries the same
  release, environment, and journey contract without unbounded cardinality;
- deployment configuration points OTLP exporters at the selected managed
  collector path and never at the local proof stack;
- staging and production Grafana accounts, stacks, recovery material, and
  backend credentials enforce distinct write tenants and server-derived
  environment identity;
- every component uptime service has a deterministic canary, dedicated
  synthetic identity where needed, cleanup behavior, and an owner;
- signed monitor result ingestion and fallback replay work without depending on
  the monitored application API;
- the public status projection implements the public-safe component contract;
- telemetry sampling, retention, notification routes, and volume ceilings are
  configured and tested for staging.

This spec is done when every item above has recorded evidence in the
execution ledger, and work stops there. Accepted as good enough for launch:
email-only operator notification, no cross-account federated view, and
expected public-status unavailability during a Cloudflare-wide outage.
Deliberately out of scope until separately approved: push/SMS/phone
escalation, paid Grafana tiers, and committing to the 99.95 percent
availability target.

## References

- Grafana Cloud pricing and included telemetry/synthetic allowances:
  https://grafana.com/pricing/
- Grafana Cloud Free and paid stack-count limits:
  https://grafana.com/docs/grafana-cloud/security-and-account-management/cloud-stacks/stack-pricing-tiers/
- Grafana Cloud staging and production stack guidance:
  https://grafana.com/docs/grafana-cloud/security-and-account-management/cloud-stacks/stack-architecture-guidance/
- Grafana Cloud stack-scoped access policies:
  https://grafana.com/docs/grafana-cloud/security-and-account-management/authentication-and-permissions/access-policies/
- Grafana Cloud governing agreement for Free-service validation:
  https://grafana.com/legal/msa/
- Grafana Cloud OTLP ingestion:
  https://grafana.com/docs/grafana-cloud/send-data/otlp/otlp-format-considerations/
- Grafana Synthetic Monitoring protocols and public probes:
  https://grafana.com/docs/grafana-cloud/testing/synthetic-monitoring/introduction/
- Grafana k6 WebSocket testing:
  https://grafana.com/docs/k6/latest/using-k6/protocols/websockets/
- Grafana k6 browser checks:
  https://grafana.com/docs/grafana-cloud/testing/synthetic-monitoring/create-checks/checks/k6-browser/
- Grafana alert grouping and notification policies:
  https://grafana.com/docs/grafana-cloud/alerting-and-irm/alerting/fundamentals/
