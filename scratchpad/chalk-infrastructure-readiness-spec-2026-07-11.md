# Chalk Infrastructure Readiness Spec

Status: Ratified for implementation handoff. The launch target is 20 simultaneous
recorded meetings through reservation-aware native capture, asynchronous
composite rendering, DeepInfra transcription, and Cloudflare ASR fallback. This
document does not by itself authorize provider mutation; mutation authority
comes from the active execution handoff and the approval contract, including
Hasan's 2026-07-12 standing approval for initial production creation and the
first promotion.

Owner: Hasan Shoaib

Last reviewed: 2026-07-13

## Document Map

This file is the shared architecture authority: decisions, contracts,
topology, and gates. Companion documents hold isolated implementation detail
and the execution strategy; a worker reads this file plus the companions its
task names:

| Companion                                               | File                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| Execution strategy: spikes, lanes, milestones, handoff  | `scratchpad/chalk-infra-execution-strategy-2026-07-12.md`   |
| Across-the-board pre-staging readiness                  | `scratchpad/chalk-pre-staging-readiness-spec-2026-07-13.md` |
| Go API requirements source                              | `scratchpad/chalk-api-staging-readiness-spec-2026-07-13.md` |
| Recorder and artifact pipeline                          | `scratchpad/chalk-recorder-pipeline-spec-2026-07-12.md`     |
| Track-aware transcription                               | `scratchpad/chalk-transcription-spec-2026-07-12.md`         |
| Observability, uptime, and status                       | `scratchpad/chalk-observability-uptime-spec-2026-07-12.md`  |
| Cost model, dated prices, and parametric planning model | `scratchpad/chalk-infra-cost-model-2026-07-12.md`           |

The settled decisions, canonical terms, non-goals, source-of-truth rules, and
anti-slop rules in this file bind every companion, and companions carry the
same ratified authority as this file.

## Outcome

Chalk will have a reproducible first-party cloud foundation that can be created,
verified, replaced, and promoted without redesigning the application at launch
time.

The first deployment is deliberately lean:

- Cloudflare owns the public edge, static web delivery, private origin ingress,
  media transport, and object storage.
- AWS owns one always-on Singapore production application node, one staging
  application node created only for a bounded activation window, and
  environment-isolated scale-to-zero transcription dispatch.
- DigitalOcean owns two separate recorder pools. Native capture workers run in
  SGP1 only while reservations or active recordings require them. GPU render
  workers run in TOR1 only while finalization jobs require them. Production
  admits at most 20 simultaneous recorded meetings after capacity acknowledgement.
- PlanetScale owns managed PostgreSQL in Singapore.
- PostgreSQL is the Sync Stateholder. It is the sole durable authority for
  Session control state, ordered event history, command receipts, and lifecycle
  intents. Redis is optional acceleration only.
- GitHub Actions builds immutable release artifacts and uses short-lived AWS
  credentials.
- DigitalOcean provider automation uses environment-scoped, expiring API tokens
  with custom resource scopes; recorder workers never receive those tokens.
- OpenTofu declares infrastructure and stores encrypted, locked remote state.
- Staging is the default destination. Hasan's standing approval of 2026-07-12
  covers initial production creation and the first release promotion; every
  later production action requires his explicit per-action approval.

Infrastructure readiness does not imply product go-live readiness. The current
Elixir sync service, recorder, artifact pipeline, and parts of the release and
observability contracts require application work before the live gate can pass.

## Product Intent

The infrastructure should let Chalk launch quickly without turning the first
release into an accidental permanent architecture. It should also support the
public promise that the core app tier remains portable: API, sync, and standard
PostgreSQL can run outside Chalk's first-party AWS deployment. Redis remains an
optional accelerator.

The managed Chalk deployment optimizes for:

- a short and reviewable path from source to a verified release;
- a small fixed baseline cost;
- strong secret and production controls;
- no public origin services or SSH ingress;
- recovery by replacement rather than manual server repair;
- explicit provider boundaries that preserve later adapters;
- honest single-node availability until demand justifies multi-node state.

## Settled Decisions

| Concern           | Decision                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Primary region    | Singapore for app and live capture; approved temporary composite rendering in DigitalOcean TOR1                                     |
| Compute           | EC2 app tier; DigitalOcean CPU-Optimized capture and RTX 4000 GPU rendering, both scale-to-zero                                     |
| App topology      | One application node per environment; recorder compute remains isolated                                                             |
| Recording         | Native selective capture in SGP1; 20-meeting admission ceiling; asynchronous 720p30 stage-view render in TOR1                       |
| Database          | Separate staging and production PlanetScale PostgreSQL databases in AWS Singapore                                                   |
| Public ingress    | Cloudflare Tunnel with outbound-only origin connections                                                                             |
| Web               | Static SPA on Cloudflare Pages                                                                                                      |
| Media             | Direct Cloudflare Realtime SFU through CloudflareMediaPlaneAdapter                                                                  |
| Transcription     | Track-aware speaker attribution; DeepInfra Whisper large-v3-turbo primary; Cloudflare Workers AI fallback                           |
| Object storage    | Cloudflare R2; preserved resources are adopted safely                                                                               |
| Environments      | Always-on production; persistent staging configuration with app compute scaled to zero; local development                           |
| Promotion         | Staging is default; initial production creation and first promotion run under Hasan's 2026-07-12 standing approval, later actions per-action |
| Rollback          | Exact deployment approval pre-authorizes return only to its named prior stable manifest                                             |
| Staging fidelity  | Same release topology with explicit scale-to-zero and non-HA database exceptions plus temporary rehearsals                          |
| Service domains   | api.chalkmeet.com and sync.chalkmeet.com; no q9labs.ai compatibility aliases                                                        |
| IaC               | OpenTofu as the only CLI allowed to write these states                                                                              |
| Images            | Public, digest-addressed, multi-architecture images in GHCR                                                                         |
| Sync state        | PostgreSQL; node-local state and Redis are disposable accelerators                                                                  |
| Web configuration | One immutable SPA code artifact plus separately digested environment runtime config                                                 |
| Artifact jobs     | PostgreSQL-only leased jobs with retry and dead-letter states                                                                       |
| Recovery          | Balanced launch targets: 2-minute process, 10-minute rollback, 15-minute node, 5-minute PostgreSQL RPO                              |
| Telemetry backend | Separate company-controlled Grafana Cloud Free accounts and stacks, gated on provider permission; 14 days                           |
| Monitoring        | Independent component services per environment on Workers Paid with one operations surface and operator email route per environment |
| Public status     | Dedicated Cloudflare Pages, Worker, and private R2 path; external probes and paging expose Cloudflare loss                          |
| App runtime       | Rootless Podman containers supervised by systemd Quadlet; host watchdog remains outside the containers                              |
| Recorder starts   | Scheduled reservations prewarm capacity; an unscheduled recorded meeting waits for capture acknowledgement                          |
| Recorder budget   | Fixed platform stays below $200; recording, media, storage, and transcription usage is metered separately                           |
| Later options     | AWS recorder fallback, DigitalOceanMediaPlaneAdapter, DurableObjectSyncAdapter, Redis acceleration, and multi-region                |

PostgreSQL is the sole durable Sync authority. It stores Session control state,
the exact ordered event history, command receipts, and lifecycle intents.
Node-local coordinators, SDK replicas, and Redis may accelerate delivery or
recovery, but every durable outcome remains recoverable with Redis absent.

## Non-goals

This baseline does not:

- claim multi-region or multi-node high availability;
- run PostgreSQL on the application node;
- run recording or transcription work on the application node;
- use Cloudflare Stream recording;
- require Redis for Sync correctness;
- introduce Kubernetes, ECS, Nomad, or a service mesh;
- inherit deleted Terraform modules or mutable deployment practices;
- expose a public EC2 origin, SSH port, or permanent deploy key;
- create production resources or inspect production accounts without active
  approval;
- finish missing API, sync, recorder, or observability behavior on behalf of
  their owning application lanes.

## Canonical Terms

Application node means the single EC2 node running the Go API, Elixir sync,
optional Redis acceleration, cloudflared, and the telemetry agent.

Capture worker means independently scaled native WebRTC compute in SGP1 that
joins authorized media sessions, stores bounded encoded tracks and a layout
timeline in R2, and performs no browser rendering or live transcoding.

Render worker means independently scaled GPU compute in TOR1 that reads one
job's encrypted capture bundles, produces the deterministic composite artifact,
writes it to R2, and destroys its temporary media and key material. Neither
recorder role hosts API or sync traffic.

Speaker-turn manifest means the immutable, time-aligned mapping from captured
audio intervals to authenticated SFU participant and track identities. It is
derived from track ownership, audio-level/VAD, mute, join, leave, and overlap
events rather than acoustic speaker inference.

Transcription dispatcher means environment-scoped, scale-to-zero AWS Lambda
compute that claims transcription work through the recorder control API, sends
bounded anonymous audio chunks to the selected provider, normalizes the
response, and receives no PlanetScale or reusable R2 credential.

Release means one immutable manifest containing source revision, image digests,
web code artifact digest, environment-configuration schema, database
compatibility range, protocol contracts, and build provenance.

Promotion means deploying the exact staging-proven release manifest to another
environment. Production never rebuilds source.

Foundation means global or rarely changed resources such as CI identity,
remote state, shared Cloudflare resources, and protected resource adoption.

Environment means an isolated staging or production set of application,
database, Stateholder, media app, storage, DNS, secrets, and monitoring
configuration.

## Target Topology

| Boundary          | Staging                                                           | Production                                          | Ownership and isolation                                                    |
| ----------------- | ----------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------- |
| Web               | Dedicated Cloudflare Pages project                                | Dedicated Cloudflare Pages project                  | Same code artifact; separately digested environment configuration          |
| API domain        | api.staging.chalkmeet.com                                         | api.chalkmeet.com                                   | Cloudflare DNS routes to the environment Tunnel                            |
| Sync domain       | sync.staging.chalkmeet.com                                        | sync.chalkmeet.com                                  | Independent Tunnel route and environment credentials                       |
| Origin ingress    | Environment Cloudflare Tunnel                                     | Environment Cloudflare Tunnel                       | No inbound EC2 security-group rules                                        |
| App compute       | ASG at zero while dormant; one leased node active                 | One always-on node sized by measured gate           | Separate instance, IAM role, storage, health authority, and release ledger |
| PostgreSQL        | Dedicated PlanetScale database with non-HA PS-5                   | Dedicated PlanetScale database with HA branch       | Separate database containers and tokens; same version, schema, and region  |
| Sync Stateholder  | PlanetScale PostgreSQL                                            | PlanetScale PostgreSQL                              | Sole durable authority; node-local and Redis state are disposable          |
| Media app         | Dedicated Cloudflare Realtime SFU app                             | Dedicated Cloudflare Realtime SFU app               | App IDs and secrets never cross environments                               |
| Recording storage | Dedicated private R2 bucket with short retention                  | Protected private R2 bucket with approved retention | Object contents are outside OpenTofu state                                 |
| Capture pool      | SGP1 at zero dormant; same 20-meeting proof profile as production | SGP1 at zero idle; expected six-node peak           | Native selective capture; density and N+1 capacity are staging-qualified   |
| Render pool       | TOR1 at zero dormant; same deadline proof profile as production   | TOR1 at zero idle; expected one to two, max ten     | GPU composite render; temporary cross-region media is encrypted and erased |
| Transcription     | Scale-to-zero Lambda; isolated provider tokens and policy         | Scale-to-zero Lambda; isolated provider tokens      | DeepInfra primary, Cloudflare fallback; no dedicated always-on node        |
| Monitoring        | Independent probes and Free Grafana account                       | Independent probes and Free Grafana account         | Credentials, quotas, data, alerts, and account recovery never cross        |
| Public status     | Dedicated staging status path                                     | status.chalkmeet.com on a dedicated Pages project   | Separate Worker and private R2 state; accepted Cloudflare failure domain   |

The application node runs these supervised services:

| Service         | Responsibility                                                      | Restart and failure boundary                                              |
| --------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| chalk-api       | HTTP control plane and background work that is safe on the app node | Health-gated; a crash must not stop sync or PostgreSQL                    |
| chalk-sync      | WebSocket sync plane and one authoritative Session writer           | Health-gated; restart recovers from PostgreSQL                            |
| redis-ephemeral | Optional API rate limits, OAuth state, and bounded caches           | No public port; explicit TTL/eviction; loss causes bounded retry or reset |
| cloudflared     | Outbound Tunnel connectors for API and sync hostnames               | Running app remains private if Tunnel is down                             |
| telemetry agent | Bounded log, metric, and trace forwarding                           | Export failure cannot fail a meeting                                      |

### Runtime resource count

The baseline keeps Chalk-dedicated compute intentionally small. The following
totals count application and recorder compute instances plus PlanetScale
PostgreSQL instances that can be identified as part of this deployment. They do
not count opaque shared provider fleets.

| Operating condition                                    | App compute | Capture | Render | PlanetScale instances | Identifiable total |
| ------------------------------------------------------ | ----------: | ------: | -----: | --------------------: | -----------------: |
| Production serving; staging dormant; no recording work |           1 |       0 |      0 |                     4 |                  5 |
| Production and staging active; no recording work       |           2 |       0 |      0 |                     4 |                  6 |
| Production at 20 live captures; no render overlap      |           1 |       6 |      0 |                     4 |                 11 |
| Production target-density capture with render burst             |           1 |       6 |      7 |                     4 |                 18 |
| Production fallback-density capture with render burst             |           1 |      11 |     10 |                     4 |                 26 |
| Staging expected 20-way proof plus HA, production idle |           2 |       6 |      7 |                     7 |                 22 |
| Staging fallback 20-way proof plus HA, production idle |           2 |      11 |     10 |                     7 |                 30 |

The production serving path itself is one EC2 application node and a
three-instance PlanetScale HA cluster: one primary and two replicas. The fourth
baseline database instance is staging's persistent non-HA PS-5. Recorder
compute has no idle floor. The expected capture peak assumes four simultaneous
meetings per two-vCPU node, five active nodes for 20 meetings, and one ready
N+1 node. A failed density benchmark may lower density to two and raise the
bounded capture peak to eleven nodes; that changes the dated forecast but not
the 20-meeting admission ceiling. The normal render pool is expected to use one
or two GPU nodes. The worst-case 20-two-hour ending burst cannot be scheduled
from aggregate output hours alone because each recording is an indivisible job.
At a 20x media-processing factor, each job consumes six minutes before measured
per-job overhead and the burst needs at least seven nodes. At the minimum
qualified 15x factor, each job consumes eight minutes and at most two jobs fit
in the 20-minute input-and-render window, so the burst needs ten nodes. Ten is
the pre-approved render infrastructure ceiling. A factor below 15x, a qualified
service time above ten minutes per two-hour job, or a higher count requires a
new plan and architecture approval.

The two fallback rows are hard per-environment sizing bounds. DigitalOcean
recorder compute has a global 21-node controller cap: eleven capture and ten
render. A full staging 20-way or ending-together proof requires zero production
recorder reservations and an approved test window. Ordinary bounded staging
canaries may use remaining slots, but the controller never lets staging consume
capacity reserved for production. The 30-instance row is therefore the largest
permitted identifiable total, and the cost forecast models that drill instead
of assuming it cannot happen.

EventBridge and Lambda reconcile staging without a continuously running
controller node. Transcription dispatch also uses provider-managed Lambda
execution and adds no dedicated node to the table. Cloudflare Pages, Workers,
R2, Realtime SFU, DeepInfra, and Grafana Cloud run on provider-managed fleets
whose physical node counts are neither dedicated to Chalk nor exposed as an
application capacity control. Each live
`cloudflared` process maintains four long-lived connections to two Cloudflare
data centers; those connections are not four additional nodes. The application
ASG never exceeds one node per environment, and terminate-first replacement
prevents old and new app nodes from overlapping.

## Source-of-truth Rules

| Data or control                                                                   | Source of truth                                                  | Derived or runtime copies                                                     |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Tenant, membership, room lifecycle, auth, and audit metadata                      | PostgreSQL                                                       | API caches, SDK state, and web projections                                    |
| Session control state, revisions, ordered events, receipts, and lifecycle intents | PostgreSQL                                                       | Node-local coordinators, Redis acceleration, and connected client projections |
| Connection presence, socket state, and transient fanout                           | Current sync processes and clients                               | Metrics and bounded diagnostics                                               |
| Recording and transcript lifecycle and authorization metadata                     | PostgreSQL                                                       | Worker leases, provider status, and reconciliation views                      |
| Recording and normalized transcript document bytes                                | R2                                                               | Worker temporary objects, CDN cache, and signed URLs                          |
| Speaker-turn identity and timing                                                  | Committed R2 speaker-turn manifest                               | Normalized transcript cues and searchable projections                         |
| Transcription provider policy                                                     | Versioned environment configuration in the release manifest      | Dispatcher cache and per-attempt provider facts                               |
| Capture-bundle envelope keys                                                      | Environment AWS KMS recording KEK plus wrapped DEK in PostgreSQL | Plaintext DEK in current job-process memory only                              |
| Durable operational journey skeleton                                              | PostgreSQL `observability_journey_events`                        | Grafana journey views and correlated telemetry queries                        |
| Metrics, traces, logs, and profiles                                               | Selected environment telemetry backend                           | Dashboards, alerts, and bounded local exporter queues                         |
| Signed component-monitor results                                                  | Selected environment monitoring/status store                     | Alerts, status projection, and SLO reports                                    |
| Infrastructure desired state                                                      | Reviewed OpenTofu configuration                                  | Provider control planes                                                       |
| Infrastructure object identity and generated provider secrets                     | Encrypted remote OpenTofu state                                  | SSM runtime parameters and approved escrow                                    |
| Human-managed provider/bootstrap credentials                                      | 1Password                                                        | Short-lived CI environment or local process only                              |
| AWS app runtime secrets                                                           | AWS SSM SecureString paths scoped per environment                | Root-readable environment files rendered at deploy or boot                    |
| Recorder runtime identity                                                         | Recorder control plane and signed bootstrap exchange             | Short-lived worker certificate and job-scoped signed R2 URLs                  |
| Release identity and state                                                        | Immutable manifest plus environment release ledger               | Running service, Pages, and database deployment projections                   |
| Database schema                                                                   | Versioned SQL migrations and immutable checksums                 | schema.sql remains a checked snapshot                                         |
| Environment promotion evidence                                                    | GitHub deployment record and verification artifact               | Dashboard annotations and session log summary                                 |

The Stateholder contract uses PostgreSQL transactions as the durable decision
boundary. Recovery reads rebuild a coordinator from the Session control row and
the ordered event history; command receipts and lifecycle intents remain
durable in the same authority. Redis may carry rebuildable hints or caches, and
its absence cannot change Sync correctness.

The journey ledger is an append-only operational record, not product room state
or a replacement for traces. Its authenticated intake acknowledges durability
only after the PostgreSQL transaction commits. SDK and service exporters use
bounded queues and never wait for that acknowledgement on a meeting-critical
operation. The intake has its own pool budget, statement timeout, rate limit,
batch and payload bounds, failure metric, and overload behavior so telemetry
cannot exhaust control-plane connections. Production intake remains disabled
until tenant/data-class attribution, operator access, retention, erasure,
volume, index-growth, and time-based cleanup behavior are ratified and tested.

## Environment and Domain Contract

### Local

Local development uses localhost, local PostgreSQL, and local Redis through the
existing OrbStack-compatible scripts. It must never require cloud credentials
for ordinary feature work.

### Staging

Staging configuration is persistent and is the automatic destination for a
release candidate after the full repository gate. Its application compute is
off by default. It uses synthetic or explicitly redacted data and has its own
non-HA PlanetScale PS-5 branch, R2 bucket, SFU app, Tunnel, secrets, alert route,
Grafana Free account and stack, and Pages project. Its PlanetScale branch lives
in a staging-only database container.

Activation is a time-bounded environment lease. Its authoritative DynamoDB
record contains a lease ID, generation, desired state, purpose, owner, release,
start, lease expiry, controller heartbeat, dormant-assertion expiry, and cleanup
phase. All transitions use conditional writes. Eight hours is the maximum
normal window, and an extension creates a new generation.

An EventBridge-scheduled Lambda controller lives outside staging compute. It
runs on activation, on expiry, and every five minutes. Its least-privilege role
can update the staging Auto Scaling group, invoke the constrained staging drain
document, delete only tagged staging root volumes, update the activation
record, and publish staging status. Activation raises desired capacity from
zero to one and verifies a fresh node from the stable release ledger. Synthetic
jobs carry the lease ID and must finish or enter cleanup five minutes before
expiry.

At expiry the controller closes admission, invokes bounded drain and
cancellation, waits at most five minutes, and forces desired capacity to zero.
A failed drain is recorded for reconciliation and cannot extend compute. The
controller retries until the instance is absent, its root volume is deleted,
and cleanup is complete. It then writes `Dormant` with a ten-minute assertion
that every five-minute reconciliation must renew. A controller heartbeat older
than seven minutes, live compute after expiry, a generation mismatch, or
incomplete cleanup alerts through the independent operations path. Production
has no dormant state.

Scaling staging to zero terminates its node and deletes its root volume.
The four staging API-class checks stay scheduled while compute is absent. They
validate the lease, controller heartbeat, `Dormant` projection, and target
absence instead of claiming application health. An expired dormant assertion
or unexpected target response becomes unknown and alerts. The next activation
is a replacement and boot-recovery exercise, not a resume of the prior node.

Staging matches production in:

- operating-system family and CPU architecture for the app node;
- container images and entrypoints;
- service topology, health checks, and restart policy;
- PostgreSQL major version, extensions, parameters, and migration history;
- optional Redis acceleration configuration and Redis-absent correctness proof;
- Cloudflare features and routing;
- secret names and configuration schema;
- release, rollback, monitoring, and verification workflows.

Staging may use smaller instance and database classes. Its single-node database
does not prove production database failover. Before first production activation
and after a material database-topology change, automation creates a dedicated,
isolated HA rehearsal branch from an approved staging recovery point. The
branch must match the production PostgreSQL major version, extensions,
parameters, roles, migration checksums, and synthetic-fixture digest.

The rehearsal has its own conditional lease with an eight-hour maximum and a
plan-time maximum cost. The same application release connects only to the
rehearsal branch while restore, failover, connection-pool, retry, and migration
behavior are tested. Cleanup returns the application to PS-5, verifies its
endpoint, migration, and data digests, revokes rehearsal roles, and deletes the
HA branch. The external lease controller retries cleanup and alerts; a leaked
branch blocks the next staging activation. At the current PS-10 catalog rate,
an eight-hour rehearsal is about $0.52 before storage and transfer. A
capacity-sensitive release also runs a temporary production-sized application
rehearsal or a documented equivalent load test before promotion. Each temporary
resource appears as a separate prorated plan and observed-cost line.

HA rehearsal reconciliation uses a staging-database-scoped PlanetScale service
token held in Secrets Manager. The controller may read only that token. Before
any mutation it must match the immutable database and branch IDs in the
conditional activation record, the generation embedded in the branch name, and
the expected non-default rehearsal state. It has no access on the production
database container. The provider permission remains broader than one staging
branch, so branch-ID mismatch, default-branch status, or missing lease evidence
fails closed and pages an operator.

### Production

Production uses chalkmeet.com service domains and isolated provider resources.
No workflow creates, applies, deploys, rotates, imports, or destroys production
state without:

1. an exact production target and state identifier;
2. a reviewed plan or release manifest;
3. a successful staging deployment of the same release manifest and web code,
   with a compatible environment-configuration schema;
4. fresh staging verification evidence;
5. the required production approval — the 2026-07-12 standing approval for the
   initial creation and first promotion, or Hasan's explicit per-action
   approval afterward — and the protected GitHub production environment.

After the first promotion, approval for one action does not authorize later
production actions.

### Preview deployments

Pull-request web previews may use Cloudflare Pages preview deployments. They
must not receive production secrets or production API access. A preview that
needs a backend uses staging through an explicit allowlist and synthetic test
identity, or uses a local/ephemeral test backend.

## AWS Compute and Access

The first-party app tier uses an immutable launch template and one Auto Scaling
Group per environment. Production desired, minimum, and maximum capacity is one.
Staging desired and minimum capacity is zero while dormant and one during a
valid activation lease; its maximum is always one. Maintenance policy cannot
raise either environment above one. Replacement is terminate-first: the old
instance reaches the terminated state before the new instance may activate
Tunnel credentials or serve sync. PostgreSQL serializes durable Session
decisions, so replacement does not depend on node-local Stateholder data.

Initial benchmark candidates:

| Environment | App node candidate                                                 | Storage candidate                 | Purpose                        |
| ----------- | ------------------------------------------------------------------ | --------------------------------- | ------------------------------ |
| Staging     | t4g.small if measured memory headroom passes; otherwise t4g.medium | Encrypted gp3 root sized by proof | Functional and release proof   |
| Production  | t4g.medium                                                         | Encrypted gp3 root sized by proof | Initial combined app-node load |

The root volume is deleted with the instance. It is not a backup or a
reattachable data volume. This keeps the baseline inexpensive and makes the
selected node-loss behavior explicit.

Sizing remains a measured input. Before apply, the release packaging work must
record idle and exercised CPU, resident memory, disk, file descriptor, and
network use for every service. The app node must retain at least 30 percent
memory and disk headroom during the staging load profile. Swapping under normal
load fails the gate.

The current `t4g.medium` production candidate has two vCPUs, 4 GiB of memory,
and burstable network performance up to 5 Gbps. T4g small and medium instances
earn enough CPU credits for a 20 percent baseline per vCPU and launch in
Unlimited mode by default. Capacity evidence must report `CPUCreditBalance`,
`CPUSurplusCreditBalance`, and `CPUSurplusCreditsCharged`; it cannot rely on a
finite starting credit balance. If the steady-state profile exceeds the credit
baseline, the dated cost model must include surplus credits and compare a
fixed-performance Graviton instance before the final node class is recorded.

## Capacity Qualification and Admission

No production concurrency or request-rate claim is valid until the complete
staging path has been exercised on the selected instance class, production
release, database tier, Tunnel, sync adapter, and observability configuration.
Redis acceleration, when enabled, must be proven absent from correctness.
Recorder concurrency is measured and admitted
separately so media processing cannot consume app-node headroom.

The launch qualification uses a staging `t4g.medium` and the leased staging HA
PS-10 so compute and database topology match production. A result from the
smaller staging node or persistent PS-5 is useful for regression detection but
cannot establish the production ceiling. The PS-10 tier supplies only one-eighth
of a vCPU and 1 GiB of memory per PostgreSQL instance. Its two replicas provide
failover and optional read capacity; they do not multiply primary write capacity
by three. Database capacity is therefore treated as a likely first constraint.

The existing Go API reports are encouraging implementation evidence, not a
deployment benchmark. On a local development host with local HTTP and local
PostgreSQL, the tested health, region, and tenant routes sustained about 10,700
to 12,800 requests per second for 15-second phases with no reported request
errors. Those runs omit the Graviton target, Cloudflare and TLS, PlanetScale,
the production route mix, Elixir sync, PostgreSQL recovery, telemetry, long-lived
connections, and a long soak. They establish that the measured Go handlers are
unlikely to be the first launch bottleneck; they establish no production RPS
or participant limit.

The first capacity qualification target is 100 concurrent meeting
participants. This is a workload to prove, not a promised ceiling. The staging
suite exercises at least these shapes separately:

- 50 two-participant rooms;
- 10 ten-participant rooms;
- four 25-participant rooms;
- one 25-participant hot room with the remaining participants distributed
  across smaller rooms.

At the 100-participant target, the minimum control-plane profile is:

- 100 persistent sync WebSockets;
- 25 sustained API requests per second with a 100 requests-per-second burst;
- 100 accepted sync commands per second sustained, including resulting room
  fanout, with a bounded burst at five commands per participant per second;
- 10 participant joins per second during the join burst;
- a six-hour steady soak followed by a ten-minute 150-participant burst.

Each shape must use realistic authenticated payloads, database reads and
writes, room joins and leaves, reconnects, PostgreSQL recovery, telemetry, and
Cloudflare media signaling. Media packets travel directly between clients and
Cloudflare Realtime SFU and do not traverse the EC2 application node. The test
still opens real media tracks so SFU signaling, browser, and session behavior
are represented.

Cloudflare currently publishes no Realtime API rate limit across an entire app.
It does publish a limit of 50 API calls per second for each SFU session and 64
tracks in one API call. The largest-room test records those per-session rates
and fails before relying on provider throttling.

The 100-participant target passes only when all of the following remain true:

- no lost or duplicated committed sync command, split brain, invariant breach,
  unexpected disconnect or database correctness error occurs;
- API latency is at most 250 ms at p95 and 750 ms at p99, excluding explicitly
  asynchronous work;
- participant join completion is at most 2 seconds at p95;
- sync commit through delivery to the last room subscriber is at most 250 ms at
  p95 and 750 ms at p99;
- application errors remain below 0.1 percent and every retry is bounded and
  attributed;
- the app node retains at least 30 percent steady CPU, memory, disk, network,
  and file-descriptor headroom, does not swap, and has no unbounded BEAM
  mailbox, exporter queue, or optional Redis cache growth;
- optional Redis acceleration remains bounded and its loss leaves Sync correct;
- PlanetScale pool wait, query latency, CPU, storage, locks, replication lag,
  and connection use retain at least 30 percent measured headroom;
- T4g credit equilibrium and any surplus-credit charge are included in the
  cost result.

After the target passes, staging increases the same workload in steps until the
first latency, correctness, dependency, or resource threshold fails. The
candidate admission ceiling is 70 percent of that first failing load and must
itself pass the six-hour soak. Production rejects new joins above the resulting
participant and per-room limits with a retryable capacity response; it does not
continue accepting work until the node collapses. The release ledger records
the tested room shapes, workload, instance and database classes, result
artifact, admission limits, and expiry conditions. A material release, runtime,
provider, topology, or workload-shape change invalidates the old result until a
bounded requalification passes.

Vertical app-node or PlanetScale resizing is the first scale response. A second
application node requires cross-node fanout, reconnect proof, and a new failure
and capacity gate. PostgreSQL remains the shared durable Stateholder authority.

The node lives in a public subnet only to obtain outbound Internet connectivity
without a NAT Gateway. Its security group has no inbound rules. A non-static
public address may be used for outbound connectivity; it is not a service
endpoint and is never published in DNS. The cost model includes AWS public IPv4
charges until IPv6-only operation is proven against Cloudflare, SSM, GHCR,
PlanetScale, and every required application dependency.

Administration and deployment use AWS Systems Manager:

- no SSH ingress, bastion, or checked-in SSH key;
- least-privilege instance profile for SSM, environment SSM reads, and required
  telemetry;
- Session Manager activity logging where supported;
- SSM Agent updates and node patch policy;
- deployment through a constrained Run Command document rather than arbitrary
  root shell in CI.

The node boot path reads the last verified release from the environment release
ledger, renders environment configuration from SSM, verifies artifact
signatures and digests, starts the supervised runtime, and enters service only
after local and external readiness pass. A replacement node must reach that
state without a human repairing it.

The canonical boot state machine is:

1. boot the pinned machine image and verify the expected instance identity;
2. read the last verified stable manifest from the environment release ledger;
3. fetch environment configuration and secret references from SSM;
4. pull every OCI image by digest and verify its signature, issuer, provenance,
   architecture, and release identity;
5. render root-owned runtime configuration without writing secret values to the
   image, journal, or release ledger;
6. start dependency and application Quadlet units in their declared order;
7. pass local liveness, dependency-aware readiness, release, and ownership
   checks;
8. activate the environment Tunnel routes only after the local gate passes;
9. publish the authenticated environment-health signal; and
10. pass external API, sync, and terminal-room verification before the node is
    considered ready.

Failure at any step is terminal for that boot attempt. The node remains out of
service, records a redacted reason, alerts, and enters the bounded replacement
policy rather than falling back to an older image tag or partially starting the
release.

EC2 reachability alone is not application health. Each environment therefore
has an explicit health authority:

- a host watchdog outside the application containers checks process liveness,
  dependency-aware readiness, disk pressure, memory pressure, and stale release
  state;
- the watchdog publishes a signed or IAM-authenticated environment health
  signal and cannot be satisfied by the process it is checking;
- a bounded alarm triggers the ratified replacement controller after a
  sustained unhealthy interval, while transient dependency outages remain
  visible without causing a replacement loop;
- launch lifecycle gating keeps a new node out of service until API, sync,
  Tunnel, release identity, and Stateholder ownership checks pass;
- the controller stops or terminates the old node and confirms Tunnel and sync
  are inactive before replacement boot;
- staging proves process restart, wedged-process detection, node replacement,
  replacement during a deploy, and replacement-controller failure.

Replacement and instance refresh are terminate-then-start. In-place application
deploys stop sync and cloudflared, start the new digest, verify it, and then
reactivate ingress. PostgreSQL preserves durable Sync state across process and
node replacement; reconnect recovers it through the authoritative history.

## Cloudflare Edge, Tunnel, and WebSockets

Each environment gets its own remotely managed Tunnel and credentials.
cloudflared creates outbound-only connections to Cloudflare. API and sync are
reachable only through their public hostnames and Tunnel routes.

The direct Cloudflare Tunnel subscription delta is currently zero. Public
application publishing is available on all Cloudflare plans and does not
require paid Access seats. The free plan has no paid availability or support
commitment, so any launch SLA that depends on one must price and ratify the
required Cloudflare plan. The cost model still includes:

- cloudflared CPU and memory on each app node;
- AWS public-address and network egress charges;
- any future paid Cloudflare zone, logging, load-balancing, or support plan;
- an explicit recheck of provider pricing before apply.

Cloudflare supports proxied WebSockets, but may close idle connections or
terminate connections during edge restarts. Therefore:

- the sync protocol must use bounded heartbeat and liveness timeouts;
- clients must reconnect with jitter and restore from an authoritative
  snapshot/revision;
- infrastructure tests must restart cloudflared and the sync process during a
  two-client session;
- the origin trusts Cloudflare client-IP headers only on the local
  cloudflared-to-service path;
- rate limiting must not collapse all users to the Tunnel connector address.

There is no automatic public-origin fallback. A Tunnel outage is visible,
alerted, and recovered through the Tunnel path rather than by opening the
origin.

## Cloudflare Pages

The web app's executable code is built once as a static SPA and archived with a
content digest. Staging and production need different service origins, so the
release cannot claim byte-identical complete deployments unless environment
selection happens outside the build. The recommended contract is one immutable
code artifact plus a separately generated, schema-validated, non-secret runtime
configuration artifact per environment:

1. build and test the environment-neutral SPA in CI;
2. archive its code output and record its digest;
3. generate an environment configuration containing the release ID, API
   origin, sync origin, and approved public feature settings;
4. record the configuration digest in the environment deployment record;
5. deploy code plus staging configuration to the staging Pages project;
6. verify routes, assets, origins, CSP, CORS, config/code compatibility, and
   build identity;
7. after approval, deploy the same code digest plus reviewed production
   configuration to the production Pages project.

The browser validates the configuration schema before starting. The runtime
configuration contains no credential, private provider ID, or server-only
setting. A config digest mismatch, stale domain, unknown field, or incompatible
schema blocks deployment and app startup. Environment-specific builds remain an
alternative only if Hasan chooses them explicitly; that option promotes source
and tests rather than byte-identical web output.

The runtime configuration is a static file in each Pages deployment. App
delivery does not require a Cloudflare Worker or Pages Function. Staging and
production use separate Pages projects, but consume the same code digest and
receive their own reviewed configuration artifact.

Cloudflare's Git integration is not the release authority. GitHub Actions owns
the build and provides the deployment evidence. Pages configuration and custom
domains are declared where the Cloudflare provider supports them; unsupported
settings use a versioned, idempotent API script with drift checks.

## Cloudflare Realtime SFU

Staging and production use separate Realtime SFU applications. The current
Cloudflare provider exposes the calls_sfu_app resource, including the generated
secret, but does not support importing an existing SFU app. The clean baseline
therefore creates new environment-specific apps unless an approved preflight
finds a supported adoption path.

The app ID and secret are sensitive release-independent runtime configuration.
They are stored in encrypted state and mirrored to environment SSM parameters.
The API and sync/media adapter receive only their environment's credentials.

CloudflareMediaPlaneAdapter remains the application boundary. OpenTofu naming,
outputs, and runtime configuration must not leak Cloudflare-specific concepts
into generic room, session, participant, or SDK contracts.

RealtimeKit remains a transitional adapter where the product still needs it.
Its app, credentials, probes, and costs are isolated from the direct SFU app.

Each native capture process joins the direct SFU as a hidden, receive-only,
session-scoped participant. It publishes no media and receives only the
qualified audio and simulcast layers selected by the stage policy. Recorder
control calls are rate-limited within Cloudflare's per-session API boundary and
are included in the load test. Cloudflare's WebSocket media adapter is excluded
from video capture because its video egress is a low-frame-rate JPEG sequence;
the recorder uses the native WebRTC/RTP path.

## R2 Storage

R2 buckets have separate purposes and policies:

| Bucket class                | Access                        | State and deletion policy                                                                                    |
| --------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Public asset bucket         | assets.chalkmeet.com          | Existing bucket is imported, protected from destroy, and verified before management                          |
| Staging recording bucket    | Private                       | Synthetic artifacts; uncommitted objects expire in 24 hours and finalized canaries in 7 days                 |
| Production recording bucket | Private                       | Preserved data is adopted safely; immutable keys, tenant retention jobs, and bucket deletion protection      |
| Component uptime buffers    | Private Worker bindings       | Separate bucket per component and environment; bounded 7-day replay and expiry                               |
| Status projection bucket    | Private status-Worker binding | Separate per environment; current sanitized projection plus result and incident history retained for 90 days |

Each resource has exactly one state owner:

| Resource                                                     | Canonical OpenTofu state |
| ------------------------------------------------------------ | ------------------------ |
| Public asset bucket and asset custom domain                  | foundation               |
| Staging recording bucket and attached policy                 | staging                  |
| Production recording bucket and attached policy              | production               |
| Staging component buffers and status bucket                  | staging                  |
| Production component buffers and status bucket               | production               |
| Staging and production SFU apps, Tunnels, and Pages projects | their environment state  |

An existing production recording bucket is adopted into production state. It
must never be imported into foundation first or represented by two states.
Account, environment, provider alias, resource address, and state key are
recorded in the private inventory before import.

OpenTofu manages bucket configuration, domains, CORS, and lifecycle through the
current Cloudflare provider. The bucket resource supports import. The current
CORS, lifecycle, and custom-domain resources do not, so production adoption
must first read and record their exact live configuration, prove the provider's
idempotent write behavior against a disposable bucket, and then perform an
approved no-behavior-change write. The implementation pins and tests the
provider rather than adding an unnecessary S3-compatible AWS provider or
leaving dashboard-only drift.

Object bodies are never imported into state. Before adopting an existing
bucket:

1. perform an approved read-only inventory outside the public repo;
2. declare the exact current configuration;
3. add prevent-destroy and replacement guards;
4. import the bucket identity into the correct state;
5. require a no-delete, no-replacement plan;
6. verify representative objects, hashes, CORS, content types, cache headers,
   signed downloads, and lifecycle behavior.

Production recordings remain private. Tenant ownership is encoded in storage
keys, enforced by the API, and verified before a signed download URL is issued.
Provider-managed encryption at rest is the baseline for finalized artifacts.
Temporary capture bundles use mandatory application-layer envelope encryption
because the selected render path processes them in TOR1. Per-recording data-key
custody, job-scoped distribution, authenticated object metadata, memory-only
decryption, key destruction, and failed-job recovery follow the recorder
contract. R2 API tokens are scoped by environment and bucket, rotated through
the secret workflow, and separated between configuration management and object
access. Extending application-layer encryption to finalized customer artifacts
is a separate product change that requires restore and key-loss behavior.

Each environment has a dedicated recording key-encryption key in AWS KMS
Singapore. Before capture assignment, the control API generates a unique data
key with encryption context bound to environment, tenant, session, recording
job, and bundle-schema version; it commits only the wrapped data key to
PostgreSQL. The control-plane runtime role is the only decrypt principal and
must supply the exact context. App-node restart recovers the plaintext data key
from the wrapped value and distributes it only through a job-scoped mTLS
channel. KMS rotation keeps prior key material decryptable for the bounded
retry window; new jobs use current material. The wrapped key is deleted after
verified bundle deletion or terminal expiry, while a content-free tombstone
retains only the deletion outcome. Request count and rotation cost are explicit
forecast inputs.

The application issues short-lived, method- and key-scoped presigned upload or
multipart URLs. Recorder nodes do not receive a reusable bucket credential.
Signed downloads have a bounded TTL, safe content disposition, expected content
type, and authorization check performed immediately before issuance.

Final artifacts use immutable object IDs and cannot be overwritten. Upload
authority has no read or delete permission. A separate deletion identity acts
only after a PostgreSQL tombstone and is never present on recorder compute.
PostgreSQL schedules each tenant-configured 1–365-day expiry and verifies R2
deletion. R2 lifecycle rules independently clean temporary, incomplete, and
orphaned objects. User-deletable artifact prefixes have no bucket lock because
hard delete must override retention.

## PlanetScale PostgreSQL

PlanetScale PostgreSQL runs in AWS ap-southeast-1 so the application and
database share a region. Staging and production use separate PlanetScale
database containers, branches, connection roles, backup policies, and service
tokens, even if both containers live in one organization. They use the same
PostgreSQL major version, required extensions, parameters, and migration
history. This boundary is required because PlanetScale service-token branch
permissions are database-scoped; a staging cleanup credential must have no
authority over the production database.

The PlanetScale Terraform provider does not create the database container
itself. Each environment workflow must therefore create or adopt its own
database container through an explicit, idempotent API or CLI step bound to that
environment's state and approval boundary, then let OpenTofu manage branches,
roles, backup policy, parameters, and supported extensions. Staging can perform
that step only for the staging database. Production performs it only as part of
an exact approved database-bootstrap action. That one-time action stops after
recording and verifying the immutable database ID. A fresh OpenTofu plan and a
second explicit production approval are required before any branch or other
production resource is created.

Credentials are separated:

- runtime role: least-privilege application reads and writes;
- migrator role: schema ownership and DDL, available only to the migration job;
- operator/read-only role: diagnostics without application writes, if needed.

The preferred application path is PlanetScale's local PgBouncer on port 6432
after transaction-pooling behavior is explicitly tested with pgx and every
runtime query pattern. A bounded direct pool is allowed only for a recorded
incompatibility. Migrations and administrative DDL always use the direct primary
connection on port 5432, never a pooled endpoint. The workflow reads the
cluster's current `max_connections` parameter and reserves operator and
migration capacity instead of assuming a tier-wide constant. Every connection
uses certificate-authority validation and hostname verification. A transport
mode that encrypts without verifying the server does not pass.

The connection contract assigns a measured budget to API, sync, workers,
migrator, and operator reserve. It defines connect, statement, transaction, and
idle timeouts; jittered connection lifetime; retry bounds; and rotation overlap.
Base-tier staging proves credential rotation, pool exhaustion, and the chosen
direct-or-PgBouncer behavior without exceeding the PlanetScale branch limit. A
temporary HA staging rehearsal proves database failover before production is
activated and after a material topology change.

### Migration contract

Every migration has an immutable ordered identifier and checksum recorded in a
database migration ledger. A changed checksum, duplicate identifier, dirty
ledger, schema version outside the release compatibility range, or concurrent
migrator blocks the release. The migrator obtains a PostgreSQL advisory lock
before any DDL and records the release and workflow identity that applied each
version.

Production migrations follow expand-and-contract:

- additive schema lands before code depends on it;
- old and new application releases remain compatible throughout the deploy and
  rollback window;
- backfills are resumable, observable, rate-limited jobs rather than one
  unbounded transaction;
- indexes use the lowest-locking supported operation and are monitored;
- explicit lock and statement timeouts prevent indefinite production stalls;
- a destructive step requires a later release, proof that old code and data no
  longer depend on it, and separate production approval;
- a failed migration leaves a visible terminal deployment state and is
  reconciled before retry. Automatic down migrations are prohibited.

The launch migration defaults are a 5-second lock timeout, a 15-minute
statement timeout for bounded DDL, and a 30-minute workflow deadline. A
migration that cannot fit those limits must be split or present separately
reviewed limits and impact in the exact release approval. The migrator reserves
the measured operator and recovery connection budget before starting and stops
when PlanetScale reports an availability, storage, replication, or connection
saturation condition. Backfills run outside the DDL transaction in resumable
batches whose size, rate, pause threshold, progress cursor, and maximum runtime
are recorded in the release manifest after staging measurement. A threshold
breach fails the deployment and alerts; it never silently raises a limit.

Only the exact approved production workflow may authorize a forward repair.
The release ledger remains terminally failed until the schema facts, migration
ledger, running release, and recovery action reconcile. No later deployment may
overwrite or bypass that state.

The promotion preview includes the exact migrator image digest, ordered
migration IDs and checksums, estimated lock/write impact, backup or restore
point, compatibility range, and recovery procedure.

Production protection requires:

- branch deletion protection in configuration and provider policy;
- automated backups and point-in-time recovery;
- the ratified included two-day backup and PITR window, with no longer custom
  schedule at launch;
- pre-migration backup or verified restore point for risky schema changes;
- quarterly restore into an isolated branch followed by application checks;
- alerts for connection saturation, storage, backup failure, replication or
  availability events exposed by the provider;
- a documented credential-rotation and application-reconnect test.

The included PlanetScale schedule runs every 12 hours and retains backups and
WAL for two days. Chalk accepts that as its launch recovery window. Corruption
or accidental change discovered after two days has no database restore point.
A longer window is a future cost-and-deletion-policy change requiring approval.

Production data never populates staging unless a separate redaction workflow is
specified and approved.

## Sync Stateholder and Redis

PostgreSQL is the sole durable authority for Session control state, exact
ordered event history, command receipts, and lifecycle intents. The Sync
Stateholder commits those facts transactionally and rebuilds node-local
coordinators from authoritative recovery reads after process or node loss.

Redis is optional acceleration. It may carry bounded caches, fanout hints,
rate-limit windows, or OAuth state, and every such use has explicit expiry,
bounds, and loss behavior. Redis has no authoritative Sync keys, persistence
requirement, or readiness dependency. Sync must preserve the same durable
outcomes when Redis is unavailable, flushed, or removed.

Optional Redis deployments require no public endpoint, least-privilege network
access, TTL and eviction policies for every key, bounded resource use, and
metrics for memory, command latency, evictions, blocked clients, and
connections. Redis failure can trigger a bounded retry or cache reset; it
cannot cause loss of an acknowledged Sync outcome.

## Recorder and Artifact Pipeline

Recording is a launch capability and an independent failure and scaling domain.
It has separate capture and render modules, provider identities, images,
desired-capacity calculations, alerts, and cost lines. Both pools scale to zero
when they have no reserved or active work. Recording cannot be enabled in
production until the complete 20-meeting artifact gate passes in staging.
Transcription is a third isolated artifact stage with scale-to-zero dispatch,
separate credentials, and its own provider fallback and terminal state.

The full pipeline contract — admission and reservation, native selective
capture, asynchronous composite rendering, worker identity and
reconciliation, considered alternatives, the recording state machines, and
PostgreSQL artifact jobs — is specified in
`scratchpad/chalk-recorder-pipeline-spec-2026-07-12.md`. Track-aware
transcription and speaker attribution is specified in
`scratchpad/chalk-transcription-spec-2026-07-12.md`. Both companions are
bound by this file's settled decisions, admission ceilings, R2 and KMS
storage contract, and anti-slop rules.

## OpenTofu Layout and State

Expected public layout:

    infrastructure/opentofu/bootstrap
    infrastructure/opentofu/foundation
    infrastructure/opentofu/environments/staging
    infrastructure/opentofu/environments/production
    infrastructure/opentofu/modules/app-node
    infrastructure/opentofu/modules/cloudflare-environment
    infrastructure/opentofu/modules/planetscale-environment
    infrastructure/opentofu/modules/digitalocean-recorder-capture
    infrastructure/opentofu/modules/digitalocean-recorder-render
    infrastructure/opentofu/modules/aws-transcription-dispatcher
    infrastructure/runtime
    infrastructure/uptime-worker

State boundaries:

| State      | Contains                                                                                                          | Apply authority                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| bootstrap  | S3 state bucket, KMS key, native lockfile support, GitHub OIDC provider and base roles                            | Manual, rare, explicit          |
| foundation | Shared Pages/asset resources, protected adoption, global CI configuration that belongs in IaC                     | Protected workflow              |
| staging    | All staging AWS, DigitalOcean, Cloudflare, PlanetScale, Grafana, release-ledger, and environment configuration    | Default trusted apply path      |
| production | All production AWS, DigitalOcean, Cloudflare, PlanetScale, Grafana, release-ledger, and environment configuration | Recorded plan; 2026-07-12 standing approval for initial creation, then manual Hasan approval |

Remote state uses:

- S3 bucket versioning and public-access blocking;
- SSE-KMS and OpenTofu state/plan encryption;
- native S3 lockfiles rather than the deprecated DynamoDB locking path;
- separate IAM permissions per state prefix;
- no backend credentials in configuration or plan artifacts;
- retention and tested recovery of an earlier state version;
- one canonical pinned OpenTofu version and lock files;
- no Terraform/OpenTofu alternation against the same state.

Generated provider secrets can appear in encrypted state. State is therefore
treated as a secret store for access control, logging, backup, and incident
response purposes. Sensitive outputs are never printed in CI or copied into
public session logs.

## Secrets and Configuration

1Password stores human-managed provider and bootstrap credentials. GitHub uses:

- GitHub OIDC for short-lived AWS roles;
- protected environment secrets or a bounded 1Password load step for
  Cloudflare, DigitalOcean, and PlanetScale tokens that do not support the same
  OIDC path;
- no production secrets in pull-request workflows;
- no reusable secret passed to forked code.

AWS SSM Parameter Store is the runtime configuration source. Each environment
has a separate path and KMS scope. OpenTofu declares names and permissions.
Secret values are synced by a dedicated rotation workflow or generated
provider resources, not committed tfvars.

DeepInfra and Cloudflare transcription credentials use separate
environment-scoped SSM SecureString parameters and rotation histories. Only the
transcription Lambda execution role can read them. The application node,
capture workers, render workers, staging controller, and CI plan role cannot.
Provider account controls enforce a dated spending limit and alert; a token is
revoked independently without changing recording access or R2 authority.

The node renders a root-owned environment file atomically, starts containers,
and removes temporary material. Values must not appear in process arguments,
cloud-init logs, GitHub logs, OpenTofu plan text, or application diagnostics.

Every runtime variable has:

- an owner;
- secret or non-secret classification;
- environment scope;
- required/optional status;
- validation rule;
- rotation method;
- restart or reload behavior;
- redacted diagnostic representation.

Production access uses distinct plan, apply, deploy, and runtime roles. The
plan role is read-only. The apply role can mutate only the approved production
state and resources. The deploy role can write only the release ledger, invoke
the constrained deployment document, and deploy to the production Pages
project. Runtime roles cannot mutate infrastructure or retrieve provider
bootstrap credentials.

## Container and Release Contract

GHCR holds multi-architecture OCI images for:

- chalk-api;
- chalk-sync;
- recorder-capture;
- recorder-render;
- any first-party telemetry gateway or worker that needs a container.

The transcription dispatcher is not pulled from GHCR. It ships as a
deterministic, signed, digest-addressed Lambda ZIP with an SBOM, provenance, and
code checksum in a private versioned AWS release-artifact bucket. The release
manifest names the exact object version and checksum; Lambda never resolves a
mutable object key.

Each release:

- is tagged with a unique source revision and release identifier;
- is deployed by immutable digest, never latest;
- includes linux/arm64 and linux/amd64 where supported;
- includes an SBOM, vulnerability scan, provenance, and signature/attestation;
- runs as a non-root user with a read-only filesystem where practical;
- has explicit CPU, memory, file-descriptor, temporary-storage, and shutdown
  settings;
- exposes liveness and readiness separately;
- embeds the same release identifier used by logs, source maps, diagnostics,
  and deployment markers.

All third-party GitHub Actions are pinned to full commit SHAs. Build provenance
binds the source revision, workflow identity, runner environment, lock files,
and artifact digest. CI signs artifacts with a GitHub OIDC-backed identity. The
node verifies the digest, signature identity, issuer, and provenance policy
before it starts an artifact. Verification failure is terminal; the node never
falls back to a mutable tag.

GHCR images are public. Image contents contain no runtime configuration,
environment identity, credentials, customer data, or private operational
material. Public visibility removes a long-lived registry pull credential from
the node while digest, signature, provenance, and vulnerability policies remain
mandatory.

Host and container policy requires:

- a pinned, supported OS image owner and image family with a documented patch
  and emergency replacement window;
- encrypted volumes, IMDSv2-only metadata, hop limit one, and no application
  container access to instance credentials;
- no privileged containers, host PID namespace, reusable shell deployment, or
  mounted container-runtime socket;
- read-only filesystems and dropped Linux capabilities except for a documented
  service-specific need;
- explicit role-specific egress for DNS, time, HTTPS, PlanetScale, Tunnel,
  Stateholder, and recorder media traffic, with denied traffic observable;
- separate capture and render network/provider identities because their media,
  cross-region R2, and GPU access are broader than the app node's.

Application nodes run the OCI images with rootless Podman supervised by systemd
Quadlet. Quadlet definitions are versioned release inputs and pin image digests,
users, mounts, networks, resources, dependencies, restart limits, and graceful
shutdown behavior. systemd owns boot ordering and bounded per-service restart;
the independent host watchdog owns sustained-unhealthy detection and node
replacement. The Podman API socket is disabled unless a separately reviewed
host-only operation requires it, and it is never mounted into an application
container.

The pinned host image records the supported Podman and systemd versions. Image
pull, signature verification, stale-image garbage collection, journal
retention, log forwarding, host patching, and emergency runtime replacement are
automated and exercised in staging. Local development may use Podman or a
Docker-compatible OCI workflow, but the production supervisor and behavior are
systemd Quadlet rather than Compose.

The capture image must support linux/amd64 and linux/arm64. The render image is
linux/amd64 while the selected NVIDIA runtime requires it; the manifest records
that explicit hardware-bound exception and pins the driver, CUDA, Video Codec
SDK, GStreamer/FFmpeg, and codec compatibility set.

The release manifest records all service and web digests plus the minimum and
maximum compatible database and protocol versions. Staging and production
consume the same manifest.

### Environment release ledger

Each environment has an isolated, on-demand DynamoDB release-ledger table with
35-day point-in-time recovery enabled. The single environment record contains a
monotonically increasing generation, last
verified stable manifest digest, pending manifest digest, deployment phase,
database schema before and after, web code and configuration digests, app-node
deployment identity, Pages deployment identity, GitHub deployment ID, evidence
location, and failure reason. Immutable release manifests themselves are stored
as signed OCI artifacts in GHCR.

Every write uses a conditional expression on the generation and expected phase.
Only one deployment may be active. GitHub workflow concurrency is a convenience;
the ledger is the authority. App-node boot reads only the last verified stable
manifest. A deploy operation names the pending manifest explicitly.

The release state machine is:

    stable -> preparing -> migrated -> app_deployed -> web_deployed
      -> verifying -> stable
      -> failed -> rolling_back -> stable

The stable pointer changes only after all live verification passes. If
infrastructure apply fails, no application phase starts. If an expand-only
migration succeeds and a later phase fails, the compatible schema remains and
the app and Pages return to the prior stable manifest. If app or Pages rollback
fails, the deployment remains failed, alerts, and cannot be superseded by a new
release. If a ledger write is ambiguous, component deployment IDs and digests
are reconciled before another conditional transition. No operator infers
success from workflow completion.

## Deployment and Promotion

### Pull requests

Untrusted pull requests run no cloud-authenticated operation. They run:

- OpenTofu format and validation;
- provider lock-file checks;
- lint, policy, secret, and IaC security scans;
- module tests and static runtime configuration tests;
- container build tests without publishing privileged artifacts.

Trusted plans use read-only provider credentials and publish redacted plan
summaries. A plan containing delete or replacement actions on protected data,
DNS, state, or production resources fails automatically.

### Staging release

After the canonical repository gate passes:

1. build and publish immutable images and the web code artifact;
2. create, sign, and publish the release manifest and provenance;
3. produce and review the staging infrastructure plan if it changed;
4. apply staging infrastructure;
5. conditionally acquire a bounded staging activation record and have the
   external controller set desired capacity to one and verify the stable node
   boot;
6. create the pending ledger generation using compare-and-set;
7. verify a fresh database backup/restore point and migration preconditions;
8. run the exact migration set through the dedicated direct connection and
   advance the ledger;
9. deploy the pending manifest to the app node and advance the ledger;
10. deploy the same web code plus staging configuration and advance the ledger;
11. wait for API and sync readiness;
12. run HTTP, WebSocket, browser, two-client media, dependency, and rollback
    checks;
13. conditionally commit the verified stable pointer and record the evidence;
14. let the external controller drain and scale to zero when the requested
    window or eight-hour lease expires, then verify root-volume deletion,
    cleanup completion, and `Dormant` status.

### Production promotion

Approval contract: Hasan's standing approval, granted 2026-07-12, satisfies
the production approvals in this section for exactly two actions — the
initial database-container bootstrap manifest and the first production
plan-apply-and-promotion. Each action still emits its full approval payload;
under the standing approval that payload is recorded in the execution ledger
immediately before execution instead of pausing for review. Every later
production action requires Hasan's explicit per-action approval.

The first production database container uses a two-approval bootstrap because
the selected PlanetScale provider can read but cannot create that container.
Before any mutation, automation emits a signed action manifest containing the
organization and target environment, expected absent state or exact adopted
database ID, database name digest, PostgreSQL kind, Singapore region, API
operation, idempotency key, workflow and script digests, projected cost, and a
no-delete policy. The first required approval authorizes only that manifest.
The workflow creates or adopts the container, verifies the immutable ID, kind,
region, and manifest-declared branch/default state, records redacted evidence,
and stops. A
different observed resource fails closed. The workflow then produces a fresh
OpenTofu plan against that fixed ID; applying the plan and promoting a release
requires the second required approval.

Production promotion starts only after its required approval. It accepts the exact
staging release manifest, not a branch name or mutable tag.

The approval request binds and shows:

- production account, environment, PlanetScale database ID, OpenTofu state key,
  and current state serial;
- source commit, workflow file SHA, GitHub run and deployment IDs;
- current and proposed release-manifest, image, web-code, web-config, and
  migrator digests;
- ordered migration IDs, checksums, compatibility range, and expected impact;
- staging evidence and age;
- provider lock digest, redacted plan summary, encrypted binary plan digest, and
  configuration digest;
- expected cost delta;
- rollback release;
- known user impact, including sync reconnects;
- approval expiry.

After approval it applies only the hashed binary plan and release inputs, then
uses the same release-ledger state machine as staging. A state serial, provider
lock, configuration, artifact, workflow, cost, target, or approval-expiry
change invalidates the approval and requires a fresh plan. The workflow waits
for readiness, runs live verification, and conditionally records the stable
revision. Any mismatch between approved and applied inputs stops the workflow.

### Rollback

Application rollback selects a previously verified release manifest by digest.
It never rebuilds an old commit. Database rollback is not automatic: migrations
must be backward compatible across the deploy window, use a safe down migration
when explicitly proven, or use a forward repair. A failed migration blocks the
application rollout.

Single-node sync deploys may disconnect WebSockets. The release must declare
that impact and the clients must prove bounded reconnect and state restoration.
The first baseline does not claim zero-downtime sync deploys.

## Failure and Recovery Behavior

| Failure                            | Required behavior                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| App process crash                  | Supervisor restarts only that service; health and alert state show the failure                                                |
| Wedged app service                 | Independent watchdog detects sustained failure and invokes the bounded restart or replacement policy                          |
| App node loss                      | ASG terminates the old node, boots the last stable release, and recovers durable Sync state from PostgreSQL                   |
| Recorder control API/app loss      | From healthy state, jobs retain 20–30 minutes of fenced authority; admission stops; recovery reconciles before reassignment   |
| Stateholder process restart        | Sync restores the Session control state, ordered history, receipts, and lifecycle intents from PostgreSQL                     |
| Redis acceleration loss            | Redis caches and hints reset or retry within bounds; acknowledged Sync outcomes remain recoverable from PostgreSQL            |
| Tunnel loss                        | Public API/sync become unavailable and independent monitoring alerts; origin remains closed                                   |
| Cloudflare edge WebSocket restart  | Clients reconnect with jitter, heartbeat, revision, and Stateholder-backed snapshot recovery                                  |
| PlanetScale outage                 | Durable writes stop safely; health distinguishes dependency failure from process death; media is not falsely declared durable |
| R2 outage                          | Live control/media continue where possible; recording/transcription work retries and reconciles                               |
| SFU outage                         | Media outcome fails visibly while control-plane state remains diagnosable                                                     |
| Capture process failure            | Sibling meeting processes continue; the fenced job resumes on available capacity and records its measured gap                 |
| Capture node loss                  | At most its qualified density is affected; the N+1 node accepts fenced replacements while a new spare is created              |
| Render process or node loss        | The lease expires, encrypted inputs remain in R2, and another qualified slot retries within the deadline budget               |
| TOR1 GPU capacity or region loss   | Existing inputs remain encrypted and retryable; new recording admission closes before the render deadline becomes impossible  |
| DigitalOcean control API loss      | Active capture/render processes continue; reconciliation and new admission stop until inventory is authoritative              |
| Transcription dispatcher loss      | Its lease expires and a fresh Lambda attempt resumes; the committed recording remains available                               |
| DeepInfra retryable failure        | Bounded retry opens the circuit and sends each still-fenced chunk once to the Cloudflare fallback                             |
| Both ASR providers unavailable     | Transcript work retries to its budget, then fails visibly without changing committed recording state                          |
| Pinned DeepInfra model unavailable | The primary adapter blocks and opens the circuit; an automatic forwarded replacement is never accepted silently               |
| GHCR outage                        | Running containers continue; new deploy or replacement blocks rather than using a mutable fallback                            |
| SSM outage                         | Running services continue with rendered config; deploy and replacement alert or block                                         |
| Telemetry outage                   | Meetings continue; bounded buffers/drop policy and monitoring-of-monitoring expose blindness                                  |
| OpenTofu state issue               | Applies stop; locked/versioned state is recovered before any provider mutation                                                |
| Partial release                    | Ledger records the failed phase; compatible schema remains; app and Pages return to the last stable manifest                  |
| Bad release                        | Readiness prevents stable-pointer commit; rollback selects the prior verified manifest                                        |
| Migration failure                  | Release blocks; ledger and schema are reconciled before retry                                                                 |

The balanced launch recovery objectives are:

| Recovery path                         | Launch objective                                                        |
| ------------------------------------- | ----------------------------------------------------------------------- |
| API or sync process restart           | RTO at or below 2 minutes                                               |
| Stateholder recovery                  | No acknowledged-outcome loss; RTO at or below 2 minutes                 |
| Verified application release rollback | RTO at or below 10 minutes                                              |
| Full app-node replacement             | RTO at or below 15 minutes; durable Sync state recovers from PostgreSQL |
| PlanetScale PostgreSQL PITR           | RPO at or below 5 minutes; RTO at or below 2 hours                      |
| Single capture-node replacement       | First decodable resumed bundle within 45 seconds; any gap is explicit   |
| Composite artifact finalization       | Verified final artifact within 30 minutes after capture completion      |

The RTO clocks are testable and do not hide execution time:

| Recovery path                  | Clock starts                                                | Clock stops                                                                  |
| ------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Process or Stateholder restart | The injected or first externally observable failure         | Service readiness passes and the affected protocol succeeds externally       |
| Full app-node replacement      | The injected or first externally observable node failure    | Fresh-node readiness and an external API, sync, and terminal-room check pass |
| Release rollback               | An authorized rollback transition enters the release ledger | The prior manifest is live and its complete verification suite passes        |
| PostgreSQL restore             | An authorized restore request is submitted                  | Schema, tombstone replay, application read/write, and integrity checks pass  |
| Capture resume                 | The injected or first missed capture heartbeat              | A fenced replacement commits its first decodable verified bundle             |
| Render finalization            | The final capture attempt enters `capture_complete`         | The authorized final artifact passes media and manifest verification         |

Rollback and restore detection, diagnosis, decision, and human-authorization
latency are reported separately and are not included in their execution RTOs.
An already approved deployment may authorize automatic return to its named prior
stable manifest when verification fails; any later rollback needs a fresh exact
production approval. Reports also measure user-visible incident duration from
the first failed outcome through final recovery so the execution-only target
cannot disguise a slow operational response.

Initial sub-budgets allocate the ratified totals:

| Path                | Detection and fencing        | Recovery action                    | Readiness and live proof | Total  |
| ------------------- | ---------------------------- | ---------------------------------- | ------------------------ | ------ |
| Required process    | At most 30 seconds           | At most 60 seconds restart         | At most 30 seconds       | 2 min  |
| Full app node       | At most 3 minutes            | At most 10 minutes terminate/boot  | At most 2 minutes        | 15 min |
| Release rollback    | Ledger transition authorized | At most 7 minutes deploy           | At most 3 minutes        | 10 min |
| PostgreSQL restore  | Authorization complete       | At most 105 minutes restore        | At most 15 minutes       | 2 hr   |
| Capture resume      | At most 10 seconds           | At most 25 seconds rejoin/keyframe | At most 10 seconds       | 45 sec |
| Render finalization | Queue admission is immediate | Measured bounded GPU render        | Manifest/media proof     | 30 min |

Internal required-service checks run often enough to satisfy the 30-second
process detection budget. Controller and boot timeouts enforce the node budget.
A failed sub-budget fails the parent objective even when the final total happens
to pass.

PostgreSQL recovery covers every acknowledged Sync outcome. Staging measures
process and node recovery end to end, including authoritative replay and
client-visible recovery. Optional Redis acceleration loss must produce the same
durable result. Tighter objectives can be ratified after launch evidence;
provider claims alone do not pass the gate.

The internal watchdog detects required process, Stateholder, and Tunnel failures
between external probes. Each recovery drill records time spent in detection,
fencing, restart or replacement, readiness, and external verification. External
five-minute checks validate the user-visible result; they are not the sole
health authority for a two-minute process objective.

## Data Lifecycle and Recovery Contract

Launch uses the following ratified data-class matrix. Retention starts at the
terminal event for a session, artifact, job, or incident unless the row says
otherwise.

| Data class                                                     | Authority                             | Launch retention and deletion                                                                                                                                                                                                                                                                                                                                                                   | Backup and recovery contract                                                                                                                                                       |
| -------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant, user, membership, and identity                         | PostgreSQL                            | Tenant lifetime. Valid user deletion removes identity/auth and pseudonymizes retained participant history within 24 hours. Valid tenant deletion purges all tenant-scoped active rows within 24 hours.                                                                                                                                                                                          | Included two-day PITR; PostgreSQL RPO at most 5 minutes and RTO at most 2 hours.                                                                                                   |
| Sessions, keys, and integrations                               | PostgreSQL plus selected provider     | Active until expiry/revocation. Credentials revoke immediately; inactive metadata expires in 30 days while its minimal audit event follows the 90-day audit policy. Provider revocation and deletion complete within 24 hours.                                                                                                                                                                  | PostgreSQL PITR covers metadata for two days; secret values are never restored as active after revocation.                                                                         |
| Rooms, meeting sessions, and participants                      | PostgreSQL                            | Tenant lifetime. Reusable rooms remain until explicit or tenant deletion. User deletion removes direct identity while preserving pseudonymous meeting history.                                                                                                                                                                                                                                  | Included two-day PITR; the standard PostgreSQL RPO/RTO applies.                                                                                                                    |
| Session control state, events, receipts, and lifecycle intents | PostgreSQL                            | Retention follows the governed Session lifecycle and retention checkpoints. Redis holds only bounded rebuildable acceleration data.                                                                                                                                                                                                                                                             | PostgreSQL recovery covers acknowledged outcomes; process and node recovery meet the measured Sync RTO.                                                                            |
| Recording and transcript metadata                              | PostgreSQL                            | Tenant-configurable 1–365 days, default 30 days. Hard delete overrides retention and removes active metadata within 24 hours.                                                                                                                                                                                                                                                                   | Included two-day PITR; tombstones replay before restored data can be served.                                                                                                       |
| Final recording and transcript bytes                           | Private R2                            | Tenant-configurable 1–365 days, default 30 days. Authorization revokes immediately and object deletion verifies within 24 hours.                                                                                                                                                                                                                                                                | R2-only. A verified write uses R2 durability; accidental, malicious, or authorized deletion has no restore path.                                                                   |
| Temporary artifact objects and jobs                            | R2 plus PostgreSQL                    | Encrypted capture bundles delete normally within one hour of verified finalization and expire within 24 hours; render retry terminalizes by hour 23; transcription chunks delete within one hour of transcript commit and expire within 24 hours; raw provider responses are memory-only; incomplete multipart uploads within seven days; terminal job and dead-letter evidence within 90 days. | Reconciliation rebuilds job state from PostgreSQL/object facts. Capture bundles and transcription inputs survive only their bounded retries and have no backup or restore promise. |
| Tenant audit events                                            | PostgreSQL                            | 90 days. No content or reusable secret. User deletion pseudonymizes the actor while preserving the security event until expiry.                                                                                                                                                                                                                                                                 | Included two-day PITR; PostgreSQL RPO/RTO applies.                                                                                                                                 |
| Operational journey events                                     | PostgreSQL                            | 90 days. Tenant/data-class attributed, operator-only, bounded, and content-free.                                                                                                                                                                                                                                                                                                                | Included two-day PITR; PostgreSQL RPO/RTO applies.                                                                                                                                 |
| Metrics                                                        | Environment Grafana Cloud Free stack  | 14 days; only low-cardinality operational dimensions and opaque correlation identifiers.                                                                                                                                                                                                                                                                                                        | Managed backend. Loss beyond the bounded exporter queue is accepted and alerted; pipeline RTO target 4 hours.                                                                      |
| Logs, traces, and profiles                                     | Environment Grafana Cloud Free stack  | 14 days. No message/media content, email, credential, raw customer identifier, or unrestricted attributes.                                                                                                                                                                                                                                                                                      | Managed backend. Loss beyond the bounded exporter queue is accepted and alerted; pipeline RTO target 4 hours.                                                                      |
| Monitor results and public incidents                           | Private status R2 bucket              | Current projection until replaced; signed results and public-safe incident/audit objects expire after 90 days.                                                                                                                                                                                                                                                                                  | Rebuilt from surviving probes and incident objects; RPO one check interval and RTO at most 30 minutes.                                                                             |
| PlanetScale backups and WAL                                    | PlanetScale in the database region    | Included backups every 12 hours, WAL, and PITR retained for two days. Deleted data leaves Chalk's customer-restorable window at expiry; provider terms govern physical media.                                                                                                                                                                                                                   | Restore to an isolated branch, replay tombstones, verify, then promote; RPO at most 5 minutes and RTO at most 2 hours.                                                             |
| OpenTofu state and state-key material                          | Versioned encrypted S3 plus 1Password | Current state for environment lifetime; superseded encrypted versions for 90 days; key versions retained at least as long.                                                                                                                                                                                                                                                                      | RPO is the last successful state write; RTO at most 1 hour through an observed decrypt-and-restore drill.                                                                          |
| Release manifests and environment ledger                       | GHCR plus DynamoDB                    | Signed manifests are public and retained indefinitely; environment ledger lives for the environment plus 90 days.                                                                                                                                                                                                                                                                               | DynamoDB PITR/backups retain 35 days; ledger RPO at most 5 minutes and RTO at most 2 hours.                                                                                        |
| Staging activation and rehearsal records                       | DynamoDB                              | Current controller record plus 90 days of redacted lease, cleanup, heartbeat, and cost evidence. No customer or meeting content.                                                                                                                                                                                                                                                                | DynamoDB PITR retains 35 days; conditional reconciliation rebuilds current state from provider facts.                                                                              |
| CI plans, logs, and deployment evidence                        | GitHub plus approved evidence store   | 90 days for redacted plans/logs/evidence; immutable release identity remains in the manifest and ledger.                                                                                                                                                                                                                                                                                        | Reproducible from signed manifests where possible; no customer content or secret values are permitted.                                                                             |

Telemetry retention is 14 days at launch because both environments use Grafana
Cloud Free. Increasing it is a reviewed plan, cost, and privacy change; no
workflow silently upgrades either account. Tenant-configurable launch retention
applies only to recording and transcript artifacts. Meeting history remains for
the tenant's lifetime and must therefore appear as an unbounded storage driver
in forecasts.

Legal hold is unavailable at launch. The API, admin UI, terms, and sales
material must say so and must not represent ordinary retention as a compliance
hold. A tenant requiring deletion prevention cannot be onboarded until the
later enterprise feature defines privilege, notice, expiry, audit, and conflict
behavior. No R2 bucket lock applies to user-deletable artifact prefixes because
it would violate the hard-delete contract.

Deletion is an idempotent workflow rather than a direct object delete. It:

1. authenticates the request and records its unique deletion ID;
2. immediately revokes sessions, artifact authorization, cached access, and
   future signed URLs;
3. writes a tombstone before deleting PostgreSQL, R2, and external-processor
   data;
4. pseudonymizes the minimum 90-day security audit proof;
5. retries and verifies every provider outcome within the 24-hour active-store
   deadline;
6. reports the two-day PlanetScale backup aging window separately from active
   deletion.

A database restore replays deletion tombstones before serving traffic, so a
restore cannot resurrect accessible customer data. R2 direct deletion is
strongly consistent; lifecycle rules remain a safety net for expiry and orphan
cleanup and may take up to 24 hours. Hard delete never waits for a lifecycle
rule.

The current privacy and terms routes are blank. Reviewed public terms and
privacy text that matches this matrix is a production gate. Production remains
blocked until the recording and transcription delete APIs, retention scheduler,
R2 object deletion, transcript-content migration, failed-upload cleanup, and
provider-deletion behavior pass staging. Production infrastructure creation
also requires observed PostgreSQL, Stateholder, state, ledger, status, and
telemetry recovery evidence.

## Observability and Operations Boundary

The observability lane supplies the application telemetry contract: a stable
`journey_id`, W3C trace context, the durable PostgreSQL
`observability_journey_events` ledger, OpenTelemetry export, and a
reproducible Grafana operations surface per environment. Staging and
production use separate company-controlled Grafana Cloud Free accounts,
independently scheduled component uptime services, signed monitor results,
and a dedicated public status path on `status.chalkmeet.com`; email through
Grafana Alerting is the launch notification route.

The complete contract — ownership boundaries, component uptime services,
monitor-result envelopes, account isolation, status projection, notification
severities, freshness budgets, drills, and readiness dependencies — is
specified in `scratchpad/chalk-observability-uptime-spec-2026-07-12.md`.

## Cost Contract

Before any staging or production apply, CI produces a dated monthly estimate
using current provider prices and measured resource choices. The ratified
guardrails, summarized here with normative detail in the cost model: the
production-plus-shared-foundation fixed forecast warns above $110/month;
dormant and fixed staging warns above $15/month; the combined fixed forecast
has a $200/month hard ceiling; an automatic staging plan adding more than
$10/month over its last approved forecast pauses for Hasan's explicit
approval, except that the 2026-07-12 standing approval covers initial
build-out staging deltas up to the ratified staging warning and combined
ceiling; every production plan remains approval-only, with the initial
creation and first promotion approved by that same standing approval. The
fixed ceiling is a
platform-idle control, never an all-in bill: recording, media, storage, and
transcription usage is metered separately and requires a funded allocation
before admission.

The full cost model — dated price sheets, recorder usage envelopes, the
1,000- and 2,000-hour planning cases, synthetic-monitoring execution budgets,
and usage-ledger controls — is specified in
`scratchpad/chalk-infra-cost-model-2026-07-12.md`.

## Application Readiness Dependencies

### Go API

The across-the-board implementation boundary and the separation between local
work and later staging verification are specified in
`scratchpad/chalk-pre-staging-readiness-spec-2026-07-13.md`. The detailed API
requirements remain in `scratchpad/chalk-api-staging-readiness-spec-2026-07-13.md`
as a source document; where it mixes implementation with live staging actions,
the pre-staging boundary controls. Recording and transcription continue to use
their companion state machine and artifact-job contracts.

### Elixir sync

The sync service is currently not production-ready. Its lane must provide:

- a real signed per-tenant/session token verifier;
- session-scoped room identity and authorization;
- PostgreSQL Stateholder transactions for control decisions, ordered events,
  command receipts, lifecycle intents, and authoritative recovery;
- liveness, readiness, structured telemetry, and runtime metrics;
- a production release and non-root multi-architecture image;
- bounded connection, frame, mailbox, memory, and rate limits;
- heartbeat, graceful shutdown, reconnect, revision, replay, and snapshot
  recovery;
- bounded retention and expiry for durable Session control data;
- load, restart, Redis-loss, node-replacement, and soak proof showing Redis is
  absent from correctness.

### Web and mobile clients

Before the domain cutover:

- production API and WebSocket origins become api.chalkmeet.com and
  sync.chalkmeet.com;
- q9labs.ai production constants are removed;
- release builds fail if local or stale origins remain;
- the static runtime-config contract validates release, schema, and origin
  digests before app startup;
- CORS, cookies, OAuth callbacks, deep links, and mobile environment contracts
  use the canonical domains;
- the currently blank privacy and terms routes contain reviewed language that
  matches the retention, backup-aging, R2-only recovery, telemetry, and absent
  legal-hold contracts;
- clients prove Cloudflare WebSocket reconnect and session restoration.

### Recorder, transcription, and observability

Recorder and transcription launch readiness dependencies are specified in
`scratchpad/chalk-recorder-pipeline-spec-2026-07-12.md` and
`scratchpad/chalk-transcription-spec-2026-07-12.md`; observability, uptime,
and status dependencies in
`scratchpad/chalk-observability-uptime-spec-2026-07-12.md`. Staging cannot
pass while any of them is unmet.

## Execution

The execution handoff contract, de-risk spikes, lane and milestone plan,
execution checklist, and execution ledger convention live in
`scratchpad/chalk-infra-execution-strategy-2026-07-12.md`. Production
retains the two-approval database bootstrap, fresh OpenTofu plan, exact
release approval, and live-verification gates defined in this file and the
execution strategy; the 2026-07-12 standing approval satisfies those
approvals for the initial creation and first promotion only.

## Verification Matrix

| Area               | Required proof                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| IaC                | Format, validate, lint, policy/security scan, provider lock, redacted plan, idempotent second plan             |
| State              | Concurrent lock rejection, encrypted state, earlier-version recovery, least-privilege state access             |
| Protected adoption | Existing R2 plan has no delete/replacement; live object/header/hash checks pass                                |
| Compute            | Fresh boot, health authority, wedged service, measured headroom, lease expiry, controller-driven replacement   |
| Secrets            | No log leakage, least-privilege reads, rotation, revoked old credential, fresh-node boot                       |
| Database           | Checksums/lock/timeouts, migrate, backup/restore, HA failover, PS-5 return, rehearsal leak cleanup             |
| Journey ledger     | Attribution, auth, bounds, pool isolation, retention, erasure, overload, and failed-PostgreSQL behavior        |
| Stateholder        | PostgreSQL recovery, exact ordered history, receipts, lifecycle intents, Redis-absent correctness, and RPO/RTO |
| Tunnel             | Normal routing, no direct origin, cloudflared restart, client IP/rate-limit correctness                        |
| Web                | Exact code/config digests, SPA fallback, assets, CSP/CORS, canonical origins, live build identity              |
| Sync               | Signed auth, two clients, heartbeat, reconnect, replay/snapshot, graceful deploy, load and soak                |
| Media              | Direct SFU publish/subscribe, remote playable outcome, failure classification, usage visibility                |
| Release            | Ledger CAS, partial failures, exact approval inputs, rollback, stable live revision proof                      |
| Recorder           | Reservation, 20-way capture, density/N+1 loss, encrypted bundles, 30-minute GPU render, erasure, usage cost    |
| Transcription      | Track attribution, overlap, schema/quality corpus, pinned DeepInfra, forced Cloudflare fallback, billed audio  |
| Monitoring         | Component and lease heartbeats, external/Cloudflare failures, replay, alerts, status, pipeline canary          |
| Cost               | Dated fixed/usage ranges, 1,000/2,000-hour cases, quotas, uncertainty, alerts, ceiling, expected apply delta   |

## Anti-slop Rules

- No latest tags, mutable artifacts, or rebuild-on-production.
- No production-only manual dashboard step without an idempotent documented
  automation boundary and drift check.
- No secret values in tracked files, plan summaries, outputs, logs, screenshots,
  or session logs.
- No production resource IDs or private account topology in the public repo.
- No wildcard production CORS or public storage bucket for recordings.
- No Redis dependency for durable Sync correctness.
- No loss of acknowledged Sync outcomes after node-local or Redis loss.
- No recorder process on the app node.
- No PlanetScale, R2 account, or compute-provider control credential on a
  recorder worker.
- No shared reusable worker bootstrap assertion or unbounded recorder scale-out.
- No Chromium or web-UI renderer in the production artifact path.
- No acoustic diarization pass for an ordinary recording whose authenticated
  isolated SFU tracks already identify speakers.
- No full-duration transcription of every participant track; duplicate billed
  audio is limited to measured overlap, deterministic context, and retries.
- No display name, email, tenant ID, room title, or customer object URL in an
  ASR provider request.
- No unpinned DeepInfra model, unqualified Cloudflare model-contract change,
  silent provider replacement, request racing, bulk inference, or provider
  webhook in the launch transcript path.
- No DeepInfra production default before its privacy, token, quota, quality,
  output-contract, and cost gates pass; Cloudflare remains the qualified
  fallback.
- No plaintext capture bundle leaves memory or crosses the Singapore-to-TOR1
  boundary without per-recording envelope encryption.
- No accepted recording reservation without capture capacity, render-deadline
  capacity, and funded usage quota reserved atomically.
- No claim of 20 simultaneous recordings before the full direct-SFU capture,
  node-loss, ending-together render, and deletion gates pass.
- No database migration hidden inside API startup.
- No automatic schema rollback.
- No public origin fallback that silently bypasses Cloudflare controls.
- No claim of high availability while desired app-node capacity is one.
- No deploy success based only on CI completion; verify the live revision and
  user flow.
- No release is stable until the conditional ledger transition records its live
  evidence.
- No production plan while retention, erasure, RPO/RTO, or legal-hold behavior
  is still marked TBD for an enabled data class.
- No production mutation inferred from spec approval or staging approval.
- No telemetry write may block or exhaust the meeting-critical control path.
- No caller-supplied environment or monitor label may cross a backend trust
  boundary.
- No stale monitor result remains green after its freshness budget expires.
- No free-plan workaround may collapse independent component probes into one
  failure boundary.

## Evidence-driven Implementation Outputs

The launch policy choices for application topology, environments, monitoring,
rollback, data lifecycle, recorder method, render region, admission semantics,
transcription provider policy, speaker attribution, and fixed-versus-usage
budget are closed. The recorder launch contract is 20
simultaneous selective captures, zero-idle pools, scheduled prewarm, bounded
unscheduled start hold, segmented resume, and an asynchronous 720p30 stage
artifact committed within 30 minutes.

DigitalOcean SGP1 is the live-capture region and TOR1 is the approved temporary
render region. The $110 production and $15 staging warnings plus the $200
combined ceiling apply to fixed planned resources. Recording and media usage is
metered and funded separately. All launch policy choices in this spec are
closed. Grafana Free account permission, DigitalOcean GPU access/quota,
DeepInfra privacy acceptance, provider inventory, application readiness,
benchmark results, and live plan prices are verification gates.

Track-aware speaker attribution is the launch default. DeepInfra's pinned
Whisper large-v3-turbo version is the gated primary, Cloudflare's equivalent
model is the qualified fallback, and the scale-to-zero dispatcher adds no
dedicated node. The current 2,000-hour all-in planning range is $435–$720, with
$850 internal and $1,000 conservative external envelopes until staging
measurement replaces it.

Root-volume size, final app-node size, capture density of two or four, measured
GPU real-time factor, one- or two-node normal render pool, and telemetry
capacity remain evidence-driven outputs. The 20-meeting admission ceiling,
ten-render-node infrastructure ceiling, output profile, and data-region
contract are fixed.

## Definition of Done

Infrastructure readiness is done when:

- the full public configuration, workflows, and runbooks exist;
- staging can be created from an empty account foundation and reaches a complete
  browser/mobile, API, sync, direct-SFU, and remote-media outcome;
- a fresh app node reconstructs the stable release and recovers acknowledged
  Sync outcomes from PostgreSQL without manual repair;
- database migration, backup, restore, secret rotation, Tunnel restart,
  optional Redis acceleration loss, deploy rollback, and monitoring failure have been
  exercised;
- the selected recorder pools prove scheduled and unscheduled admission, 20-way
  selective capture, bounded scale-out, full-node loss and fenced resume,
  encrypted cross-region bundles, 30-minute GPU finalization, authorization,
  track-aware transcription, DeepInfra primary and forced Cloudflare fallback,
  retention, erasure, reconciliation, and cost per recorded and billed audio
  minute;
- every component uptime service identifies its own failure, its heartbeat is
  monitored, and one service failure does not suppress another result;
- preserved R2 data remains intact and protected;
- the dated cost model and alerts exist;
- production protections reject an unapproved or stale apply or promotion;
- the exact production plan, cost, policies, artifacts, and approval payload are
  ready without mutating production.

Production activation is a separate done state. After its required approval, the
approved production revision must be live and verified end to end before that
state is done.

Until every applicable item has observed evidence, status is not done.

## Primary References

- Chalk architecture decision:
  `scratchpad/chalk-architecture-decision-2026-06-16.md`
- Current Sync Stateholder contract:
  `apps/sync/README.md`
- Local Go API performance reports:
  `apps/api/scratchpad/api-performance-pool*.md`
- Observability journey and telemetry contract:
  `docs/observability.md`
- Local-only observability proof stack:
  `infrastructure/observability/README.md`
- Cloudflare Tunnel overview:
  https://developers.cloudflare.com/tunnel/
- Cloudflare published applications and Access-plan requirement:
  https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/
- Cloudflare plan and support/SLA comparison:
  https://www.cloudflare.com/plans/
- Cloudflare WebSocket behavior:
  https://developers.cloudflare.com/network/websockets/
- Cloudflare Tunnel Terraform guide:
  https://developers.cloudflare.com/tunnel/deployment-guides/terraform/
- Cloudflare Pages Direct Upload with CI:
  https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/
- Cloudflare Pages static Direct Upload:
  https://developers.cloudflare.com/pages/get-started/direct-upload/
- Cloudflare Workers environment isolation:
  https://developers.cloudflare.com/workers/wrangler/environments/
- Cloudflare Workers plan, Worker, request, and Cron Trigger limits:
  https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Workers pricing and paid-plan minimum:
  https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare R2 Terraform behavior:
  https://developers.cloudflare.com/r2/examples/terraform/
- Cloudflare R2 bucket resource and import behavior:
  https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/r2_bucket
- Cloudflare R2 CORS resource:
  https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/r2_bucket_cors
- Cloudflare R2 lifecycle resource:
  https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/r2_bucket_lifecycle
- Cloudflare R2 durability and deletion limitations:
  https://developers.cloudflare.com/r2/reference/durability/
- Cloudflare R2 strong consistency, including direct deletion:
  https://developers.cloudflare.com/r2/reference/consistency/
- Cloudflare R2 lifecycle timing:
  https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- Cloudflare R2 bucket locks:
  https://developers.cloudflare.com/r2/buckets/bucket-locks/
- Cloudflare R2 pricing:
  https://developers.cloudflare.com/r2/pricing/
- Cloudflare R2 custom-domain resource:
  https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/r2_custom_domain
- Cloudflare resource import:
  https://developers.cloudflare.com/terraform/advanced-topics/import-cloudflare-resources/
- Cloudflare Realtime SFU quickstart:
  https://developers.cloudflare.com/realtime/sfu/get-started/
- Cloudflare Realtime SFU limits:
  https://developers.cloudflare.com/realtime/sfu/limits/
- Cloudflare Realtime SFU pricing:
  https://developers.cloudflare.com/realtime/sfu/pricing/
- Cloudflare Realtime SFU session and track API:
  https://developers.cloudflare.com/realtime/sfu/sessions-tracks/
- Cloudflare SFU provider resource:
  https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/calls_sfu_app
- PlanetScale regions:
  https://planetscale.com/docs/plans/regions
- PlanetScale Singapore generated price sheet:
  https://planetscale.com/pricing.md?region=ap-southeast
- PlanetScale PostgreSQL architecture:
  https://planetscale.com/docs/postgres/postgres-architecture
- PlanetScale PostgreSQL branching and isolated branch behavior:
  https://planetscale.com/docs/postgres/branching
- PlanetScale PostgreSQL compatibility and non-inherited branch configuration:
  https://planetscale.com/docs/postgres/postgres-compatibility
- PlanetScale PostgreSQL connection and PgBouncer behavior:
  https://planetscale.com/docs/postgres/connecting
- PlanetScale PostgreSQL branch-based pricing:
  https://planetscale.com/docs/postgres/pricing
- PlanetScale backups and recovery:
  https://planetscale.com/docs/postgres/backups
- PlanetScale point-in-time recovery:
  https://planetscale.com/docs/postgres/backups/point-in-time-recovery
- PlanetScale database-scoped service-token permissions:
  https://planetscale.com/docs/api/reference/service-tokens
- PlanetScale restore/create-branch API:
  https://planetscale.com/docs/api/reference/create_branch
- PlanetScale Terraform provider:
  https://planetscale.com/docs/terraform
- AWS GitHub-compatible OIDC federation:
  https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_oidc.html
- AWS EC2 on-demand pricing:
  https://aws.amazon.com/ec2/pricing/on-demand/
- AWS data-transfer pricing:
  https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer
- AWS burstable-instance CPU credit baselines:
  https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-credits-baseline-concepts.html
- AWS Unlimited-mode behavior and credit monitoring:
  https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-performance-instances-unlimited-mode-concepts.html
- AWS EBS pricing:
  https://aws.amazon.com/ebs/pricing/
- AWS public IPv4 pricing:
  https://aws.amazon.com/vpc/pricing/
- AWS KMS pricing:
  https://aws.amazon.com/kms/pricing/
- AWS Systems Manager Session Manager:
  https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html
- AWS EventBridge Scheduler invoking Lambda:
  https://docs.aws.amazon.com/lambda/latest/dg/with-eventbridge-scheduler.html
- AWS Lambda pricing:
  https://aws.amazon.com/lambda/pricing/
- AWS DynamoDB on-demand pricing:
  https://aws.amazon.com/dynamodb/pricing/
- AWS DynamoDB condition expressions:
  https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html
- AWS DynamoDB point-in-time recovery:
  https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Point-in-time-recovery.html
- AWS ElastiCache replication and durability:
  https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Replication.html
- AWS EC2 instance metadata controls:
  https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html
- GitHub artifact attestations:
  https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations
- OpenTofu S3 backend and native lockfile behavior:
  https://opentofu.org/docs/language/settings/backends/s3/
- OpenTofu state locking:
  https://opentofu.org/docs/language/state/locking/
- OpenTofu state and plan encryption:
  https://opentofu.org/docs/language/state/encryption/
