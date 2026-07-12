# Chalk Infrastructure Readiness Spec

Status: Ratified for implementation handoff, including the recorder capacity
and track-aware transcription amendments. The launch target is 20 simultaneous
recorded meetings through reservation-aware native capture, asynchronous
composite rendering, DeepInfra transcription, and Cloudflare ASR fallback. This
document does not authorize provider mutation or production access.

Owner: Hasan Shoaib

Last reviewed: 2026-07-12

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
- Staging is the default destination. Production creation and every production
  promotion require Hasan's explicit approval.

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

| Concern           | Decision                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Primary region    | Singapore for app and live capture; approved temporary composite rendering in DigitalOcean TOR1                |
| Compute           | EC2 app tier; DigitalOcean CPU-Optimized capture and RTX 4000 GPU rendering, both scale-to-zero                |
| App topology      | One application node per environment; recorder compute remains isolated                                        |
| Recording         | Native selective capture in SGP1; 20-meeting admission ceiling; asynchronous 720p30 stage-view render in TOR1  |
| Database          | Separate staging and production PlanetScale PostgreSQL databases in AWS Singapore                              |
| Public ingress    | Cloudflare Tunnel with outbound-only origin connections                                                        |
| Web               | Static SPA on Cloudflare Pages                                                                                 |
| Media             | Direct Cloudflare Realtime SFU through CloudflareMediaPlaneAdapter                                             |
| Transcription     | Track-aware speaker attribution; DeepInfra Whisper large-v3-turbo primary; Cloudflare Workers AI fallback      |
| Object storage    | Cloudflare R2; preserved resources are adopted safely                                                          |
| Environments      | Always-on production; persistent staging configuration with app compute scaled to zero; local development      |
| Promotion         | Staging is default; production requires Hasan's explicit approval                                              |
| Rollback          | Exact deployment approval pre-authorizes return only to its named prior stable manifest                        |
| Staging fidelity  | Same release topology with explicit scale-to-zero and non-HA database exceptions plus temporary rehearsals     |
| Service domains   | api.chalkmeet.com and sync.chalkmeet.com; no q9labs.ai compatibility aliases                                   |
| IaC               | OpenTofu as the only CLI allowed to write these states                                                         |
| Images            | Public, digest-addressed, multi-architecture images in GHCR                                                    |
| Sync state        | PostgreSQL; node-local state and Redis are disposable accelerators                                               |
| Web configuration | One immutable SPA code artifact plus separately digested environment runtime config                            |
| Artifact jobs     | PostgreSQL-only leased jobs with retry and dead-letter states                                                  |
| Recovery          | Balanced launch targets: 2-minute process, 10-minute rollback, 15-minute node, 5-minute PostgreSQL RPO         |
| Telemetry backend | Separate company-controlled Grafana Cloud Free accounts and stacks, gated on provider permission; 14 days      |
| Monitoring        | Independent component services per environment on Workers Paid with one operations surface per environment     |
| Public status     | Dedicated Cloudflare Pages, Worker, and private R2 path; external probes and paging expose Cloudflare loss     |
| Recorder starts   | Scheduled reservations prewarm capacity; an unscheduled recorded meeting waits for capture acknowledgement     |
| Recorder budget   | Fixed platform stays below $200; recording, media, storage, and transcription usage is metered separately      |
| Later options     | AWS recorder fallback, DigitalOceanMediaPlaneAdapter, DurableObjectSyncAdapter, Redis acceleration, and multi-region |

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
| Production expected capture/render overlap             |           1 |       6 |      7 |                     4 |                 18 |
| Production fallback capture/render overlap             |           1 |      11 |     10 |                     4 |                 26 |
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

| Data or control                                               | Source of truth                                                  | Derived or runtime copies                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| Tenant, membership, room lifecycle, auth, and audit metadata  | PostgreSQL                                                       | API caches, SDK state, and web projections                   |
| Session control state, revisions, ordered events, receipts, and lifecycle intents | PostgreSQL                                         | Node-local coordinators, Redis acceleration, and connected client projections |
| Connection presence, socket state, and transient fanout       | Current sync processes and clients                               | Metrics and bounded diagnostics                              |
| Recording and transcript lifecycle and authorization metadata | PostgreSQL                                                       | Worker leases, provider status, and reconciliation views     |
| Recording and normalized transcript document bytes            | R2                                                               | Worker temporary objects, CDN cache, and signed URLs         |
| Speaker-turn identity and timing                              | Committed R2 speaker-turn manifest                               | Normalized transcript cues and searchable projections        |
| Transcription provider policy                                 | Versioned environment configuration in the release manifest      | Dispatcher cache and per-attempt provider facts              |
| Capture-bundle envelope keys                                  | Environment AWS KMS recording KEK plus wrapped DEK in PostgreSQL | Plaintext DEK in current job-process memory only             |
| Durable operational journey skeleton                          | PostgreSQL `observability_journey_events`                        | Grafana journey views and correlated telemetry queries       |
| Metrics, traces, logs, and profiles                           | Selected environment telemetry backend                           | Dashboards, alerts, and bounded local exporter queues        |
| Signed component-monitor results                              | Selected environment monitoring/status store                     | Alerts, status projection, and SLO reports                   |
| Infrastructure desired state                                  | Reviewed OpenTofu configuration                                  | Provider control planes                                      |
| Infrastructure object identity and generated provider secrets | Encrypted remote OpenTofu state                                  | SSM runtime parameters and approved escrow                   |
| Human-managed provider/bootstrap credentials                  | 1Password                                                        | Short-lived CI environment or local process only             |
| AWS app runtime secrets                                       | AWS SSM SecureString paths scoped per environment                | Root-readable environment files rendered at deploy or boot   |
| Recorder runtime identity                                     | Recorder control plane and signed bootstrap exchange             | Short-lived worker certificate and job-scoped signed R2 URLs |
| Release identity and state                                    | Immutable manifest plus environment release ledger               | Running service, Pages, and database deployment projections  |
| Database schema                                               | Versioned SQL migrations and immutable checksums                 | schema.sql remains a checked snapshot                        |
| Environment promotion evidence                                | GitHub deployment record and verification artifact               | Dashboard annotations and session log summary                |

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
5. Hasan's explicit approval in the active thread and the protected GitHub
   production environment.

Approval for one action does not authorize later production actions.

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

### Admission and reservation

The production admission ceiling is 20 simultaneous captured meetings within a
100-participant global launch profile. A recorded meeting may reserve one to
ten participants. The qualification mix represents Hasan's expected traffic:
20 three-person meetings normally, plus a stress shape of five ten-person
meetings and fifteen three-person meetings, or 95 participants across all 20.
A meeting above ten participants or a system load above the qualified global
participant ceiling is rejected or admitted without recording according to an
explicit product policy.

The launch recording duration limit is 120 minutes. A scheduled reservation
declares a shorter or equal maximum; an unscheduled recording reserves the full
120 minutes before its meeting opens. Extending a shorter reservation must
atomically reserve its additional capture time, render-deadline capacity, and
usage exposure, and can never extend beyond 120 minutes. The recorder warns at
ten and two minutes before the limit, stops capture visibly at the limit, and
lets the meeting continue unrecorded. The 20-ending-together render proof is
therefore bounded at 40 output-hours.

Scheduled recording reservations prewarm capture nodes five minutes before the
meeting and require the requested slots to be ready two minutes before start.
An accepted reservation consumes its meeting, participant, bitrate, duration,
render, and tenant usage allocations for the bounded window. No-show capacity
drains after ten minutes. An unscheduled
recorded meeting holds its opening until a capture process acknowledges its
lease; the initial maximum wait is 120 seconds and is replaced by the measured
cold-start bound if staging proves a lower value. Expiry fails visibly as
`recording_capacity_unavailable`. The meeting never starts under a promise that
its missing opening minutes were recorded, and it never silently falls back to
client-side capture.

Capture placement reserves meetings, participant/audio tracks, and input
bitrate together. The initial two-vCPU node target is four meetings, 40
participants, and 16 Mbps of captured media; the permitted fallback is two
meetings, 20 participants, and 8 Mbps. The scaler uses the maximum need across
all three dimensions:

    desired_capture_nodes = max(
      ceil(meetings / meetings_per_node),
      ceil(participants / participants_per_node),
      ceil(input_mbps / input_mbps_per_node)
    ) + ready_spare

`ready_spare` is one while work is reserved or active and zero otherwise. The
controller clamps active leases to 20 meetings and 100 participants. At the
target density, either qualified 20-room profile uses five active nodes plus one
ready spare. At the fallback density, it uses ten active nodes plus one spare.
A lower proven density, a provider quota below eleven nodes, or a cold-start
miss blocks production recording enablement. Each meeting runs in its own
supervised process or container with its own lease and job authority, so one
process failure does not terminate sibling captures.

### Native selective capture

The capture pool uses DigitalOcean SGP1 CPU-Optimized 2-vCPU/4-GiB Droplets and
a native WebRTC implementation such as Pion. It does not run Chromium, decode
video for layout, or encode the final composite. It subscribes only to the
tracks needed to reproduce the selected stage view:

- every audible Opus track within the qualified participant bound;
- the current screen share at the legibility-qualified layer;
- the active speaker at the qualified stage layer when no screen share is
  dominant, or at a bounded secondary layer while screen share is dominant;
- low simulcast layers for a deterministic strip of at most six participants;
- active-speaker, screen-share, mute, join, leave, track, and layout events on
  one monotonic timeline.

Each job pins a versioned layout policy. Screen share wins the primary stage;
simultaneous shares use stable start-time and participant-ID tie-breaking.
Without screen share, a bounded RTP audio-level window and hysteresis select the
active speaker. The strip excludes the primary stage and orders remaining
participants by join time then opaque participant ID. Labels use the
authorization-time display-name snapshot. The event timeline records every
decision so render retry cannot produce a different composition.

The same timeline records the authenticated owner, track class, and active
intervals for every audible audio track. Capture never infers identity from a
voiceprint. RTP audio levels, a deterministic VAD policy, mute state, and
track/join/leave events produce candidate speech intervals and explicit overlap
intervals. Track replacement and reconnection create a new track epoch tied to
the same authorized participant only when the control plane proves that
mapping.

The capture target is 3 Mbps and the initial admission budget is 4 Mbps per
recorded meeting, including audio. Layer selection degrades thumbnails before
screen-share legibility. Staging must prove the budget across the supported
participant shapes; an unqualified shape cannot consume an unbounded set of
tracks. This contract intentionally does not promise an arbitrary post-meeting
gallery edit because tracks outside the selected stage view are not retained.

Each capture process writes one independently verifiable, versioned capture
bundle every 10–15 seconds. A bundle contains codec-native encoded track
fragments plus the corresponding timeline slice; it is not a pre-rendered
video. Track-set changes may close a bundle early. Every object uses a random
tenant-scoped temporary key, sequence number, monotonic and media timestamps,
codec and layer facts, byte size, cryptographic checksum, and attempt fencing.
A committed bundle is never overwritten.

Capture-worker loss preserves every committed bundle. A fenced replacement
rejoins the SFU, requests fresh keyframes, and resumes under a new attempt. The
manifest records the observed gap instead of fabricating continuity. The
recovery clock includes detection, fencing, replacement assignment, media
rejoin, first decodable keyframe, first new bundle, and manifest reconciliation.

### Asynchronous composite rendering

Capture completion queues a separate render job. The primary render pool uses
scale-to-zero DigitalOcean TOR1 RTX 4000 GPU Droplets and native
GStreamer/FFmpeg processing with hardware decode and encode. Chromium and the
web meeting UI are not part of the artifact path. The renderer follows the
recorded timeline and produces one deterministic stage artifact with screen
share priority, active speaker, a strip of at most six participants, stable
name labels, and mixed audio.

The launch output contract is MP4 with H.264 video and AAC-LC audio, 1280x720 at
30 frames per second, a 2 Mbps video target with a 3 Mbps maximum, 128 kbps
audio, seekable metadata, and a verified playable duration. Source frames are
never invented to conceal a capture gap. The final artifact must become
authorized and committed within 30 minutes after capture ends. A missed
deadline remains visible, keeps the capture bundles for retry, and pages the
artifact owner.

The same render attempt decodes the retained Opus tracks once and emits an
immutable speaker-turn manifest plus bounded transcription-ready mono 16-kHz
MP3 chunks. A non-overlapping speech interval is emitted once from its owning
track. Each overlapping interval is emitted once per audible participant so no
speaker is discarded. Deterministic leading/trailing context, silence handling,
maximum request duration, source checksums, and the mapping from chunk-local
time to meeting time are versioned in the manifest. The renderer neither sends
audio to an ASR provider nor multiplies every participant track across the full
meeting duration.

Render admission uses an earliest-deadline, discrete bin-packing simulation.
Each recording is one non-preemptive job. Its qualified service time includes
input opening and transfer, media processing at the measured real-time factor,
container finalization, and measured per-job overhead. The controller finds the
smallest node count at or below ten for which every job can be assigned to one
node and every node's assigned service time fits within the remaining
input-and-render sub-budget. Aggregate output-hours division is not an
admission algorithm because it hides rounding at the job boundary.

The 30-minute deadline reserves at most three minutes for node readiness and
queue assignment, 20 minutes for input transfer and first-pass rendering, four
minutes for upload, media verification, and authorization, and three minutes
for bounded recovery. For the 20-two-hour ending burst, a 20x media-processing
factor gives a six-minute base service time and requires at least seven nodes
when three qualified jobs fit per node. The minimum 15x factor gives an
eight-minute base service time; ten nodes are required, and staging must prove
that two jobs including all measured overhead fit within 20 minutes on every
node. The expected pool is one or two GPU nodes for staggered work. OpenTofu and
the scaler permit at most ten. A factor below 15x, a qualified two-hour job over
ten minutes, a sub-budget miss, or exhausted recovery reserve fails
qualification rather than borrowing verification time. Production recording
admission closes before the discrete schedule can miss the deadline. A provider
capacity failure preserves the encrypted inputs and blocks new recording
admission; it does not silently substitute an unqualified renderer or affect
live unrecorded meetings.

TOR1 is an approved, render-only data-processing region. Before leaving
Singapore, every capture bundle is envelope-encrypted with an independent
per-recording data key and authenticated metadata. The control API distributes
the plaintext key only over the job-scoped mTLS channel; workers receive no KMS
credential. A renderer decrypts into memory, uses no persistent media cache,
uploads through job-scoped URLs, clears key material, and destroys the Droplet
after its bounded drain. Normal capture-bundle deletion completes within one
hour of verified finalization; a 24-hour lifecycle rule is the orphan safety
net. Logs, snapshots, images, crash dumps, and telemetry contain no media or
plaintext key material.

A missed 30-minute objective may retry only while its inputs and wrapped data
key remain inside the bounded temporary window. By 23 hours after capture
completion, reconciliation must either commit the artifact or enter a terminal
render failure and schedule the bundles and wrapped key for deletion. No retry
or operator hold extends raw-media retention beyond the 24-hour lifecycle.

### Track-aware transcription and speaker attribution

The launch transcript uses authenticated SFU track ownership as its speaker
authority. This is track-aware attribution, not acoustic diarization: the
system already knows which authorized participant published each isolated
audio track. The normalized transcript maps provider timing through the
speaker-turn manifest and adds the authorization-time display-name snapshot
locally. DeepInfra and Cloudflare receive only opaque job/chunk IDs and audio;
they receive no display name, tenant identifier, email address, room title, or
customer-supplied object URL.

One physical microphone or mixed input published as one SFU track remains one
speaker device in the transcript. Chalk does not claim it can distinguish
multiple humans behind that track. A future acoustic
`PyannoteDiarizationAdapter` may be qualified for imported mixed recordings or
shared-microphone recovery, but it is not in the launch path and cannot replace
authenticated track identity when that identity exists.

Screen-share or system audio retains its authenticated track class and is
labeled as shared audio, not silently assigned to the participant's microphone
identity. A participant track without provable ownership remains an explicit
unknown track and cannot borrow the current active-speaker label.

Transcription sits behind a provider-neutral `TranscriptionProvider` port:

| Role     | Provider and model                             | Runtime policy                                                                |
| -------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Primary  | DeepInfra `openai/whisper-large-v3-turbo`      | Default service tier; exact release-approved model version; standard API only |
| Fallback | Cloudflare `@cf/openai/whisper-large-v3-turbo` | Release-qualified model contract; activated only after the circuit breaker    |

The environment-scoped transcription dispatcher is scale-to-zero AWS Lambda,
not an application-node process or a dedicated always-on node. It claims a
fenced PostgreSQL job through the recorder control API, fetches only the
attempt's bounded private R2 chunks through short-lived job authority, invokes
the configured adapter synchronously, validates the response, normalizes it,
and uploads the result through a conditional job-scoped URL. It receives no
PlanetScale credential, recorder provider token, bucket-wide R2 credential, or
infrastructure mutation authority. Its signed, digest-addressed release
artifact and environment configuration are part of the same Chalk release.

After the database transaction commits a transcript job, the control API sends
an asynchronous Lambda wake-up hint. A one-minute EventBridge reconciliation
schedule wakes pending work if that hint is lost. Neither trigger owns job
state: duplicate or missing invocations are safe because only the control API's
compare-and-set lease grants work. One invocation claims a bounded batch, stops
claiming before its timeout reserve, and lets leases expire for anything it did
not conditionally commit. Chunk duration and provider timeouts must leave at
least 60 seconds for response validation, result upload, and lease completion
inside the configured Lambda timeout.

DeepInfra is the default because its listed 2026-07-12 price for Whisper
large-v3-turbo is $0.00020 per audio minute, versus Cloudflare's listed
$0.00051. Production enablement is nevertheless gated on all of the following:

- vendor DPA, subprocessor, processing-location, request-logging, deletion, and
  incident terms are accepted for recorded meeting audio;
- an environment-isolated token, spending limit, rotation procedure, revocation
  drill, and least-privilege egress policy are in place;
- the exact DeepInfra model version is pinned, execution identity is observable,
  and its segment/word timing, languages, file bounds, error taxonomy, and
  normalized output pass the conformance corpus;
- quota and load proof cover the launch burst below an internal concurrency cap
  of 50, leaving headroom under DeepInfra's documented 200 concurrent requests
  per model; and
- measured quality and total billed audio remain inside the ratified quality
  and cost gates.

The deterministic staging corpus covers the launch languages, accents, short
turns, long monologues, silence, background noise, reconnects, crosstalk, and
the qualified room shapes. DeepInfra may become primary only when every adapter
conforms to the same normalized schema, non-overlap speaker-time attribution
error is at most 2 percent, every labeled overlap interval is retained and
flagged, and its word-error rate is no more than two absolute percentage points
worse than Cloudflare's result in any ratified language/noise bucket. A failed
bucket makes Cloudflare active until a new model/version passes; it is not
hidden by an aggregate average.

DeepInfra documents that standard inference inputs and outputs are normally
memory-only, but reserves limited request-content logging for debugging or
security. Chalk therefore uses only direct standard request/response inference;
the DeepInfra bulk API and provider webhooks are prohibited at launch. If the
privacy gate is not accepted, DeepInfra cannot be enabled in that environment
and Cloudflare becomes the active provider without changing the transcript
contract.

There is no request racing or dual-success billing. The dispatcher retries
DeepInfra only for classified retryable failures with bounded exponential
backoff and jitter, then opens a circuit and submits that fenced chunk to
Cloudflare. A conditional commit accepts exactly one provider result per chunk;
late or duplicate results cannot overwrite it. Every normalized cue records
meeting-relative start/end, opaque participant and track epoch, locally joined
display-name snapshot, text, language, overlap state, provider, model, pinned
DeepInfra version or release-qualified Cloudflare contract version, attempt,
and available quality metadata. Provider/model/version-contract and billed
audio are observable per attempt.

Cloudflare exposes the model slug but no ASR model-version pin in its published
contract. The release therefore records that slug, the adapter/schema version,
the last passing corpus digest, and the provider response identity when
available. A daily no-content canary and changelog watcher disable fallback on
schema or quality drift. DeepInfra's documented automatic deprecation forwarding
is also treated as a model change: an unobservable or mismatched execution
identity fails the primary gate instead of accepting the replacement silently.

Temporary transcription chunks stay private in R2. Raw provider responses
exist only in Lambda memory until normalization and are never stored as objects
or logs. Chunks are deleted within one hour after the normalized transcript is
committed; a 24-hour lifecycle rule removes orphans. Provider failure never
invalidates a committed recording. Transcription retries or falls back
independently and eventually reaches a visible terminal transcript outcome.

### Worker identity and reconciliation

Both worker roles:

- receive an immutable job ID, tenant ID, session ID, attempt number, expected
  artifact class, and short-lived authorization;
- receive no PlanetScale credential, infrastructure-control credential, or
  reusable R2 object credential;
- poll and report through the authenticated recorder control API, which owns
  PostgreSQL lease transitions on the worker's behalf;
- use method-, size-, expiry-, and key-scoped R2 URLs;
- report heartbeat, progress, terminal outcome, and measured resource use;
- cannot choose the final object owner or overwrite a committed artifact;
- clean up partial objects and media sessions after failure;
- cannot make API or sync unavailable when they crash or saturate.

An accepted capture job receives a rolling 30-minute autonomy envelope: its
fenced capture epoch, SFU session authority, and conditional-create presigned
URLs for the next bounded bundle keys. Renewal begins when 22 minutes remain
and must complete before 20 minutes remain; failure at that boundary stops
admission and further replenishment. An outage can therefore begin at any point
after a successful renewal and still leave at least 20 minutes of authority for
the 15-minute app-node replacement objective and five minutes of reconciliation
headroom. The envelope grants at most 30 minutes of forward authority and no
reusable bucket credential. During recorder-control API or app-node loss, an
assigned worker keeps its existing media session and uploads only within that
envelope; it accepts no new job or changed layout policy. If authority expires
first, it closes the current bundle, stops capture, and later reports
`capture_authority_expired` with the exact gap.

A render assignment receives all input URLs, one conditional final-output URL,
and key authority for its bounded attempt before work starts, so control-plane
loss does not corrupt an in-flight render. After recovery, the control API
reconciles immutable object facts and the capture epoch before extending a
lease or issuing a replacement. It never overlaps attempts until the prior node
certificate is revoked or provider inventory proves the node terminated.
Billing settlement uses accepted reservations, provider node time, immutable
objects, and reconciled terminal outcomes, so a missing heartbeat cannot erase
cost or create duplicate billable work.

DigitalOcean Droplets use immutable rebuilds, outbound-only workload traffic,
per-node health, bounded scaling, and stateless roots. Routine deploys never use
SSH. Because Droplets do not use AWS workload identity, each pool uses a
one-time, five-minute bootstrap assertion created outside OpenTofu state. The
assertion is bound to environment, role, release, intended Droplet, region, and
boot generation; the control plane verifies live DigitalOcean inventory before
issuing a short-lived node certificate, consumes the assertion once, and
revokes the certificate when the node leaves the pool. Each job subprocess then
receives narrower job authority.

DigitalOcean API tokens never reach a worker. Capture and render scalers use
separate environment- and role-scoped tokens with only the Droplet, firewall,
tag, image, action, and inventory scopes they require. Tokens have explicit
expiry, rotation overlap, and last-used monitoring. Policy enforces the
20-meeting admission ceiling, the staging-qualified capture-node bound, the
ten-render-node ceiling, and the 21-node global recorder-compute cap across
environments. A bounded external reconciler compares reservations, desired
capacity, provider inventory, node certificates, job processes, leases, render
deadlines, and the usage ledger. Scaler failure preserves active nodes and
closes new admission rather than affecting live meetings.

### Considered recording methods

The selected split pipeline is deliberate:

- Browser-based live composition reproduces the product UI closely, but a
  comparable room-composite worker commonly needs about four dedicated CPUs.
  Twenty concurrent jobs would make the browser fleet the dominant fixed and
  burst cost.
- Native live composition removes Chromium but still decodes, lays out, mixes,
  and encodes every meeting in real time. It couples capture survival to render
  load and cannot batch post-meeting work.
- Cloudflare RealtimeKit managed recording is outside the direct-SFU adapter
  contract. Its published composite export price is $0.010 per minute, or $600
  for 1,000 recorded hours, before participant usage.
- Client-side MediaRecorder capture cannot satisfy the artifact contract across
  tab closure, sleep, mobile backgrounding, weak uplinks, and host departure.
- Full-duration transcription of every participant track would turn a
  three-person one-hour meeting into roughly three billable audio hours. The
  selected speaker-turn manifest transcribes each non-overlapping interval once
  and duplicates only actual overlap plus bounded context.
- Acoustic diarization guesses speaker boundaries from a mixed waveform even
  though Chalk already has authenticated isolated tracks. It remains a future
  adapter for shared microphones and imported mixed media, not a paid launch
  stage for ordinary SFU recordings.
- A self-hosted SFU packet tap can eventually remove the extra managed-SFU
  subscriber path. It remains the named `DigitalOceanMediaPlaneAdapter` option,
  evaluated when three trailing months of Cloudflare media and recorder egress
  exceed the dated cost of a redundant Singapore SFU plus its operational
  reserve. It is a media-plane migration, not a recorder-only optimization.

The durable recording state machine is:

    requested -> reserved -> capture_leased -> capturing_segmented
      -> capture_complete -> render_queued -> rendering -> verifying -> committed
      -> retryable_failure | terminal_failure | deleted

The committed recording owns an independent transcript child state:

    not_requested -> preparing -> transcribing -> verifying -> complete
      -> retryable_failure | terminal_failure | deleted

Transitions use compare-and-set database updates keyed by immutable job and
attempt IDs. Bundle verification checks sequence, object existence, size,
checksum, content type, encryption metadata, decodable keyframe boundaries, and
timestamp continuity. Finalization verifies the complete capture manifest and
rendered-media facts before an idempotent final-key transition marks the
artifact committed. Lease expiry makes abandoned work reconcilable. A periodic
reconciler detects expired leases, missing or overlapping bundles, orphaned
temporary objects, database/object mismatches, expired provider attempts, and work
stranded beyond its retry budget. A transcript failure never changes a
committed recording's availability or integrity state.

Transcription consumes only the committed speaker-turn manifest and its
temporary audio chunks. Provider responses are normalized in memory; normalized
transcript document bytes use the final private R2 path. PostgreSQL owns
lifecycle, authorization, object keys, checksums, sizes, language, per-chunk
provider/model/version/attempt facts, billed audio, and terminal outcome. The
job model provides retry, backoff, lease expiry, deduplication, conditional
single-result commit, terminal failure, dead-letter inspection, and
reconciliation. No launch provider callback or webhook is trusted or required.

### PostgreSQL artifact jobs

Recording and transcription use PostgreSQL-only leased job tables. Creating an
artifact or transition that requires work inserts its job in the same database
transaction, so there is no database-to-queue dual-write. No SQS or external
broker is introduced. The launch infrastructure includes the bounded recorder
fleet and scale-to-zero Lambda transcription dispatcher after their staging
gates pass.

Each job stores an immutable ID and idempotency key, tenant/session/artifact
references, payload schema version, state, priority, `available_at`, attempt
count and limit, lease token/owner/expiry, bounded error code and redacted
detail, and created/updated/terminal timestamps. Large media, transcript bodies,
credentials, and unbounded provider payloads never live in the job row.

The recorder control API claims jobs in a short transaction with `FOR UPDATE
SKIP LOCKED`, commits the lease, and returns one job-scoped assignment to an
authenticated ready recorder worker or transcription dispatcher. Work happens
outside the transaction and the executor never connects to PostgreSQL.
Heartbeat, completion, retry, cancellation, and lease recovery enter through
the control API and use compare-and-set on the attempt and lease token. Polling
is jittered and bounded; the API's dispatcher pool remains inside the
PlanetScale connection budget. Exhausted work enters a terminal dead-letter
state with an audited operator requeue action. A reconciler recovers expired
leases and detects terminal artifacts with missing or extra work.

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
| production | All production AWS, DigitalOcean, Cloudflare, PlanetScale, Grafana, release-ledger, and environment configuration | Manual plan plus Hasan approval |

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

The first production database container uses a two-approval bootstrap because
the selected PlanetScale provider can read but cannot create that container.
Before any mutation, automation emits a signed action manifest containing the
organization and target environment, expected absent state or exact adopted
database ID, database name digest, PostgreSQL kind, Singapore region, API
operation, idempotency key, workflow and script digests, projected cost, and a
no-delete policy. Hasan's first explicit approval authorizes only that manifest.
The workflow creates or adopts the container, verifies the immutable ID, kind,
region, and manifest-declared branch/default state, records redacted evidence,
and stops. A
different observed resource fails closed. The workflow then produces a fresh
OpenTofu plan against that fixed ID; applying the plan and promoting a release
requires a second explicit approval.

Production promotion starts only after explicit approval. It accepts the exact
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

| Recovery path                         | Launch objective                                                      |
| ------------------------------------- | --------------------------------------------------------------------- |
| API or sync process restart           | RTO at or below 2 minutes                                             |
| Stateholder recovery                  | No acknowledged-outcome loss; RTO at or below 2 minutes                |
| Verified application release rollback | RTO at or below 10 minutes                                             |
| Full app-node replacement             | RTO at or below 15 minutes; durable Sync state recovers from PostgreSQL |
| PlanetScale PostgreSQL PITR           | RPO at or below 5 minutes; RTO at or below 2 hours                    |
| Single capture-node replacement       | First decodable resumed bundle within 45 seconds; any gap is explicit |
| Composite artifact finalization       | Verified final artifact within 30 minutes after capture completion    |

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

| Data class                                | Authority                             | Launch retention and deletion                                                                                                                                                                                                                                                                                                                                                                   | Backup and recovery contract                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant, user, membership, and identity    | PostgreSQL                            | Tenant lifetime. Valid user deletion removes identity/auth and pseudonymizes retained participant history within 24 hours. Valid tenant deletion purges all tenant-scoped active rows within 24 hours.                                                                                                                                                                                          | Included two-day PITR; PostgreSQL RPO at most 5 minutes and RTO at most 2 hours.                                                                                                   |
| Sessions, keys, and integrations          | PostgreSQL plus selected provider     | Active until expiry/revocation. Credentials revoke immediately; inactive metadata expires in 30 days while its minimal audit event follows the 90-day audit policy. Provider revocation and deletion complete within 24 hours.                                                                                                                                                                  | PostgreSQL PITR covers metadata for two days; secret values are never restored as active after revocation.                                                                         |
| Rooms, meeting sessions, and participants | PostgreSQL                            | Tenant lifetime. Reusable rooms remain until explicit or tenant deletion. User deletion removes direct identity while preserving pseudonymous meeting history.                                                                                                                                                                                                                                  | Included two-day PITR; the standard PostgreSQL RPO/RTO applies.                                                                                                                    |
| Session control state, events, receipts, and lifecycle intents | PostgreSQL                  | Retention follows the governed Session lifecycle and retention checkpoints. Redis holds only bounded rebuildable acceleration data.                                                                                                                                                                                                                             | PostgreSQL recovery covers acknowledged outcomes; process and node recovery meet the measured Sync RTO.                                                                            |
| Recording and transcript metadata         | PostgreSQL                            | Tenant-configurable 1–365 days, default 30 days. Hard delete overrides retention and removes active metadata within 24 hours.                                                                                                                                                                                                                                                                   | Included two-day PITR; tombstones replay before restored data can be served.                                                                                                       |
| Final recording and transcript bytes      | Private R2                            | Tenant-configurable 1–365 days, default 30 days. Authorization revokes immediately and object deletion verifies within 24 hours.                                                                                                                                                                                                                                                                | R2-only. A verified write uses R2 durability; accidental, malicious, or authorized deletion has no restore path.                                                                   |
| Temporary artifact objects and jobs       | R2 plus PostgreSQL                    | Encrypted capture bundles delete normally within one hour of verified finalization and expire within 24 hours; render retry terminalizes by hour 23; transcription chunks delete within one hour of transcript commit and expire within 24 hours; raw provider responses are memory-only; incomplete multipart uploads within seven days; terminal job and dead-letter evidence within 90 days. | Reconciliation rebuilds job state from PostgreSQL/object facts. Capture bundles and transcription inputs survive only their bounded retries and have no backup or restore promise. |
| Tenant audit events                       | PostgreSQL                            | 90 days. No content or reusable secret. User deletion pseudonymizes the actor while preserving the security event until expiry.                                                                                                                                                                                                                                                                 | Included two-day PITR; PostgreSQL RPO/RTO applies.                                                                                                                                 |
| Operational journey events                | PostgreSQL                            | 90 days. Tenant/data-class attributed, operator-only, bounded, and content-free.                                                                                                                                                                                                                                                                                                                | Included two-day PITR; PostgreSQL RPO/RTO applies.                                                                                                                                 |
| Metrics                                   | Environment Grafana Cloud Free stack  | 14 days; only low-cardinality operational dimensions and opaque correlation identifiers.                                                                                                                                                                                                                                                                                                        | Managed backend. Loss beyond the bounded exporter queue is accepted and alerted; pipeline RTO target 4 hours.                                                                      |
| Logs, traces, and profiles                | Environment Grafana Cloud Free stack  | 14 days. No message/media content, email, credential, raw customer identifier, or unrestricted attributes.                                                                                                                                                                                                                                                                                      | Managed backend. Loss beyond the bounded exporter queue is accepted and alerted; pipeline RTO target 4 hours.                                                                      |
| Monitor results and public incidents      | Private status R2 bucket              | Current projection until replaced; signed results and public-safe incident/audit objects expire after 90 days.                                                                                                                                                                                                                                                                                  | Rebuilt from surviving probes and incident objects; RPO one check interval and RTO at most 30 minutes.                                                                             |
| PlanetScale backups and WAL               | PlanetScale in the database region    | Included backups every 12 hours, WAL, and PITR retained for two days. Deleted data leaves Chalk's customer-restorable window at expiry; provider terms govern physical media.                                                                                                                                                                                                                   | Restore to an isolated branch, replay tombstones, verify, then promote; RPO at most 5 minutes and RTO at most 2 hours.                                                             |
| OpenTofu state and state-key material     | Versioned encrypted S3 plus 1Password | Current state for environment lifetime; superseded encrypted versions for 90 days; key versions retained at least as long.                                                                                                                                                                                                                                                                      | RPO is the last successful state write; RTO at most 1 hour through an observed decrypt-and-restore drill.                                                                          |
| Release manifests and environment ledger  | GHCR plus DynamoDB                    | Signed manifests are public and retained indefinitely; environment ledger lives for the environment plus 90 days.                                                                                                                                                                                                                                                                               | DynamoDB PITR/backups retain 35 days; ledger RPO at most 5 minutes and RTO at most 2 hours.                                                                                        |
| Staging activation and rehearsal records  | DynamoDB                              | Current controller record plus 90 days of redacted lease, cleanup, heartbeat, and cost evidence. No customer or meeting content.                                                                                                                                                                                                                                                                | DynamoDB PITR retains 35 days; conditional reconciliation rebuilds current state from provider facts.                                                                              |
| CI plans, logs, and deployment evidence   | GitHub plus approved evidence store   | 90 days for redacted plans/logs/evidence; immutable release identity remains in the manifest and ledger.                                                                                                                                                                                                                                                                                        | Reproducible from signed manifests where possible; no customer content or secret values are permitted.                                                                             |

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

Telemetry ingestion is isolated by an environment trust boundary, not by a
caller-supplied label. Staging and production use separate company-controlled
Grafana Cloud accounts and Free stacks. Account- and stack-scoped credentials
derive and overwrite environment and monitor identity and reject
cross-environment labels. No organization access policy, service account,
synthetic identity, recovery factor, or automation token spans the accounts.
One environment can never write another environment's telemetry, alerts,
journey records, or status.

Shared probe releases roll out to staging, then one production component, then
the remaining production components. Result schemas remain backward compatible
across the rollout window, and each service pins its own verified version. A bad
shared library or ingestion schema must turn affected monitor state to unknown
or stale rather than leaving the last green result current.

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
least one paging route remains usable during a Cloudflare account or app-node
failure.

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
a hard dependency. If the arrangement is not permitted, Phase 0 blocks and this
spec returns to discussion for a newly ratified telemetry backend. No workflow
shares production credentials, combines the environments, weakens staging
parity, or upgrades to Pro automatically.

The existing uptime Worker is not deploy-ready. It combines all checks into one
HTTP-only schedule, uses pre-canonical targets, depends on an ingest route that
does not exist in the current application, and shares one run summary and
fallback stream. The current status route is also blank. The implementation
replaces this contract with the component services above and proves signed
result ingestion, replay, freshness, and independent failure before staging can
pass.

Every monitor result uses a bounded signed envelope containing the credential-
derived monitor ID, environment, component, unique result ID, issued and expiry
times, target release, payload digest, outcome, and check timing. Ingestion
rejects oversized, expired, future-dated, duplicate, revoked, cross-environment,
and unauthorized-component envelopes. Signing-key rotation overlaps only for a
bounded window; revocation, delayed replay, duplicate delivery, and fallback
replay are staging tests.

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

Staging drills disable each component monitor, the Cloudflare-hosted probe path,
the external path, the telemetry backend, and an alert destination separately.
The drill also injects a shared-library and result-schema regression across
multiple monitors. It proves monitoring-of-monitoring, bounded replay, component
attribution, fail-unknown behavior, expected public-status unavailability during
a Cloudflare-wide failure, and external delivery through the surviving route.

The observability lane's 99.95 percent availability target remains a candidate,
not a launch commitment. A single-node topology and reconnecting deploys must
first demonstrate that planned and unplanned interruption fits the ratified
error budget. Reports separate edge, API, sync, media, artifacts, telemetry, and
status availability rather than averaging them into a healthy-looking number.

## Cost Contract

Before any staging or production apply, CI produces a dated monthly estimate
using current provider prices and measured resource choices.

The estimate separates:

- EC2, EBS, public IPv4, backup, and AWS data transfer;
- PlanetScale staging and production compute, storage, backups, and egress;
- Cloudflare zone plan, Pages, Tunnel, R2 operations/storage, SFU egress, and
  observability/logging add-ons;
- GHCR storage and transfer if charged;
- recorder fixed/active compute and transfer;
- telemetry, incident delivery, and third-party provider costs;
- staging baseline and production baseline;
- fixed minimum, expected, high, and provider-price uncertainty;
- variable cost per meeting minute, recorded minute, transcription minute,
  stored GiB-month, 1,000 API calls, and peak concurrent room;
- taxes and credits as separate lines rather than hidden assumptions;
- usage-driven costs at expected 50, 80, and 100 percent of the ratified launch
  workload.

Known current fact: Cloudflare Tunnel adds zero direct subscription dollars for
public application publishing. It may avoid a static Elastic IP, but it does
not erase the AWS outbound/public-address or node-capacity cost.

Cloudflare's limits checked on 2026-07-11 allow 100 Workers but only five Cron
Triggers per account on Workers Free. The minimum web, API, sync, and status
services across staging and production need eight schedules. Workers Paid has a
$5 monthly account minimum, 250 Cron Triggers, and usage allowances. The cost
model includes the $5 plan; it never assumes eight free triggers.

The first dated catalog hypothesis uses 730 hours per month and prices checked
on 2026-07-11 and 2026-07-12. AWS's live Price List reports Singapore Linux
on-demand rates of $0.0212/hour for `t4g.small`, $0.0424/hour for
`t4g.medium`, $0.005/hour for an in-use public IPv4 address, and $0.096 per
gp3 GB-month. T4g Unlimited surplus CPU is $0.04 per vCPU-hour in every AWS
region. AWS supplies a shared 100 GB monthly Internet-egress allowance; its live
Price List reports $0.12/GB for the first 10 TB from Singapore after that
allowance. PlanetScale's Singapore price sheet reports $5/month for non-HA PS-5
and $47/month for HA PS-10, each with the first 10 GB included. A
customer-managed AWS KMS key starts at $1/month. Its first and second key
material rotations each add another $1/month. The baseline uses five current
keys for state, environments, and recording envelopes; retaining two rotations
for each can raise their fixed line from $5 to $15 before request charges.

The selected recorder prices were checked on 2026-07-12. DigitalOcean's SGP1
CPU-Optimized 2-vCPU/4-GiB Droplet costs $0.0625/hour, capped at $42/month, and
includes 4,000 GiB of full-month outbound transfer. The TOR1 RTX 4000 GPU
Droplet costs $0.76/hour and includes 10 TB of full-month outbound transfer.
Droplets are billed per second with a 60-second or $0.01 minimum, and transfer
allowance accrues in proportion to active time. Inbound transfer is free and
outbound beyond the pooled allowance is $0.01/GiB. The GPU plan is a
contracted/provider-quota dependency and is unavailable in SGP1; Phase 0 must
prove TOR1 access and a ten-node burst quota without creating production
capacity.

The selected transcription prices were checked on 2026-07-12. DeepInfra lists
`openai/whisper-large-v3-turbo` at $0.00020 per audio minute. Cloudflare lists
`@cf/openai/whisper-large-v3-turbo` at $0.00051 per audio minute. Each forecast
uses provider-reported billed audio by successful and failed attempt, not
meeting duration alone. The billed input is unique non-overlapping speaker-turn
audio plus actual overlapping speakers, deterministic boundary context, and
retry audio. Full-duration participant-track multiplication is prohibited.

Recorder usage is modeled as four separate paths:

1. Cloudflare Realtime SFU to capture is inbound and free at DigitalOcean.
   Cloudflare charges $0.05/GB for data it sends after the account's shared
   1,000 GB monthly SFU/TURN allowance. A 3–4 Mbps selective input is about
   1.35–1.8 GB, or $0.0675–$0.09, per recorded hour when fully billable.
2. Capture to R2 uploads the same encrypted encoded media without transcoding.
   At the target four-meeting density, 3–4 Mbps per meeting fits approximately
   within the CPU Droplet's time-accrued transfer allowance. The dated forecast
   still charges observed overage and never assumes unused pooled transfer.
3. R2 to TOR1 is free R2 egress and free DigitalOcean ingress. Final upload from
   TOR1 to R2 consumes the GPU pool's time-accrued allowance. At 2 Mbps output,
   minor overage is possible when one node renders far faster than real time and
   is charged from observed bytes rather than rounded away.
4. R2 Standard stores about 0.9 GB per 2-Mbps recorded hour. One hour retained
   for a full month costs about $0.0135 before the 10-GB storage allowance.
   Ten-to-fifteen-second capture creates 240–360 Class A object writes per hour;
   the first million monthly Class A operations are included, then the
   published $4.50/million rate is about $0.0011–$0.0016 per recorded hour.

At 1,000 recorded meeting-hours per month, before transcription and ordinary
participant SFU/TURN traffic, the pre-benchmark recorder envelope is:

| Usage line                                  | Sustained full-load lower bound | Minimum-qualified lower bound |
| ------------------------------------------- | ------------------------------: | ----------------------------: |
| SGP1 capture compute, including N+1         |             $18.75 at four/node |            $34.38 at two/node |
| TOR1 render compute                         |         $38.00 at 20x real time |       $50.67 at 15x real time |
| Recorder-specific Cloudflare SFU egress     |         $17.50 after 1 TB at 3M |     $90.00 fully billed at 4M |
| Final R2 storage at 30-day steady retention |                          $13.50 |                        $13.50 |
| R2 operations and DigitalOcean overage      |                           $0–$2 |                         $0–$5 |
| Recorder-only usage subtotal                |                   about $88–$90 |                    about $194 |

The capture rows assume 1,000 meeting-hours packed continuously into 20 active
meetings: 50 wall-clock hours on six target-density nodes or eleven fallback
nodes. They include the ready spare but remain lower bounds. Partial bins,
five-minute prewarm, ten-minute no-shows, early endings, worker replacement,
render boot, and retries can increase node-hours materially. Every expected and
high forecast therefore replays the actual reservation time series through the
placement and render-deadline algorithms; it never divides aggregate hours by
density alone.

A renderer below 15x is unqualified for the ending-together deadline under the
ten-node ceiling. These figures expose why a browser-per-meeting fleet is
excluded and why the GPU throughput benchmark is a release gate. They also show
that the $200 fixed-platform ceiling cannot be represented as a $200 all-in
bill at this usage. The fixed baseline plus these recorder lower bounds is about
$188–$294 before normal participant media and transcription. Normal participant
media can consume the shared Cloudflare allowance before the recorder, and
transcription remains its own usage line.

Every dated forecast uses observed input by track and simulcast layer, render
factor, output bitrate, capture-bundle count, retries, retained bytes, playback
reads, normal participant SFU/TURN egress, and transcription-provider usage.
Cloudflare's shared free allowance is never assigned entirely to recorder
traffic in the expected or high case.

The current 2,000-one-hour-meeting planning case is 2,000 recorded room-hours,
or 120,000 base transcription minutes, with three participants on average,
stage-oriented 720p media, 30-day artifact retention, reservation-aware capture
packing, and no permanent recorder node. It is a budget forecast, not proven
capacity or a new fixed-resource ceiling:

| Monthly line                                       | Planning range | Load-bearing assumption                                       |
| -------------------------------------------------- | -------------: | ------------------------------------------------------------- |
| Fixed platform and dormant staging                 |        $100.48 | Current lean fixed topology                                   |
| SGP1 capture compute and bounded transfer          |       $60–$125 | Reservation packing, prewarm, N+1, and replacement overhead   |
| TOR1 render compute and bounded transfer           |       $80–$115 | 15–20x GPU factor, boot, verification, and bounded retry      |
| Cloudflare SFU/TURN, including recorder subscriber |      $140–$300 | Three-person average and measured subscribed video bitrate    |
| R2 storage and operations                          |        $30–$40 | 30-day steady retention, capture bundles, reads, and cleanup  |
| DeepInfra transcription and Lambda dispatch        |        $25–$40 | $24 base ASR plus measured overlap, context, retries, and AWS |
| Expected all-in total                              |      $435–$720 | Before taxes, credits, unusual TURN use, and provider changes |

The internal planning envelope is $850/month and the conservative external
estimate is $1,000/month until staging replaces these ranges with measured
time-series data. A full-month switch of all 120,000 base minutes from
DeepInfra to Cloudflare adds about $37.20; with a 20-percent overlap, context,
and retry allowance it adds about $44.64. That fallback remains inside the
envelope, but the forecast must recompute it from actual billed minutes.

The pre-benchmark fixed and hourly split is:

| Scope                | Candidate line                                               | Monthly or hourly hypothesis |
| -------------------- | ------------------------------------------------------------ | ---------------------------- |
| Shared foundation    | Workers Paid account minimum                                 | $5.00/month                  |
| Shared foundation    | Current state customer-managed KMS key                       | $1.00/month                  |
| Shared foundation    | Serverless controller, ledger, and log reserve               | $1.00/month                  |
| Production           | One `t4g.medium` for 730 hours                               | $30.95/month                 |
| Production           | One in-use public IPv4 address for 730 hours                 | $3.65/month                  |
| Production           | 30 GB gp3 root-volume pricing hypothesis                     | $2.88/month                  |
| Production           | Current environment customer-managed KMS key                 | $1.00/month                  |
| Production           | Recording envelope key-encryption key                        | $1.00/month                  |
| Production           | PlanetScale Singapore HA PS-10                               | $47.00/month                 |
| Dormant staging      | PlanetScale Singapore non-HA PS-5                            | $5.00/month                  |
| Dormant staging      | Current environment customer-managed KMS key                 | $1.00/month                  |
| Dormant staging      | Recording envelope key-encryption key                        | $1.00/month                  |
| Active staging       | `t4g.small`, public IPv4, and prorated 30 GB gp3 root volume | $0.0301/hour                 |
| Active capture node  | DigitalOcean SGP1 CPU-Optimized, 2 vCPU/4 GiB                | $0.0625/hour                 |
| Active render node   | DigitalOcean TOR1 RTX 4000 GPU                               | $0.76/hour                   |
| Burstable compute    | T4g Unlimited surplus CPU above earned baseline              | $0.04/vCPU-hour              |
| Each rotated KMS key | First and second retained rotations                          | +$1.00/month each            |

Before recorder compute, production plus its shared foundation is about
$93.48/month. Keeping staging configured but dormant brings that subtotal to
about $100.48/month. An example 88-hour staging-app month adds about $2.65.
These totals assume no chargeable T4g surplus CPU; the capacity result must add
its measured 24-hour-equivalent cost.

The $1 serverless reserve covers the five-minute lease controller, EventBridge
schedule, on-demand activation and release records, and bounded CloudWatch logs
until a dated calculator quote replaces it; the dormant controller cadence is
about 8,640 invocations in a 30-day month. Usage beyond that reserve is a
visible variance.

Recorder compute has no idle floor, so the normal fixed combined baseline
remains about $100.48. An example 88-hour staging-app month adds about $2.65.
Capture and render tests appear in a separate usage ledger at their actual
node-seconds, transfer, SFU, R2, and retry cost; a scale test never disguises
that spend as a permanent fixed resource.

These figures are hypotheses, not an apply quote: the measured root size,
DigitalOcean worker classes and app-node classes may change. S3 state, transfer,
Cloudflare usage, R2, SFU, GHCR, telemetry volume, browser/media runner compute,
paging, transcription, taxes, and credits remain separate measured lines. Any
enabled but unpriced resource blocks apply rather than disappearing inside the
rounded baseline.

Grafana's published pricing checked on 2026-07-12 gives each selected Free
account a $0 platform fee, one stack, 14-day retention for metrics, logs,
traces, and profiles, three active users, 10,000 active metric series, 50 GB
each of logs, traces, and profiles per month, 100,000 synthetic API-test
executions, and 10,000 browser-test executions per month. Each execution is
billed against its account allowance per probe location and runtime minute
rounded up. Frequency, locations, retries, duration, and every scripted test
remain explicit capacity inputs.

Free has no paid overage path. A forecast that exceeds either account's
allowances blocks production promotion and requires volume reduction or a
separately approved plan change. The automation never treats the second Free
account as pooled capacity and never upgrades to Pro automatically. The known
monitoring subscription floor is therefore $5/month for Workers Paid. The
non-Cloudflare paging destination and real-browser runner remain pending cost
lines.

The initial synthetic budget is a sizing hypothesis, not a provider promise.
The pre-proof execution sheet is:

| Uptime service      | Billed path and one-minute hypothesis       | Staging hypothesis                           | Production hypothesis                         | Required measurement before forecast                  |
| ------------------- | ------------------------------------------- | -------------------------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| Web edge            | Grafana API test plus separate browser test | 1 API location every 15 minutes: 2,880/month | 2 API locations every 5 minutes: 17,280/month | Browser cadence, duration, locations, and retries     |
| API control plane   | Grafana scripted API test                   | 1 location every 15 minutes: 2,880/month     | 2 locations every 5 minutes: 17,280/month     | Transaction duration, cleanup, and retries            |
| Sync realtime       | Grafana scripted WebSocket test             | 1 location every 15 minutes: 2,880/month     | 2 locations every 5 minutes: 17,280/month     | Script support, duration, reconnect, and retries      |
| Status and alerting | Grafana API/status test                     | 1 location every 15 minutes: 2,880/month     | 2 locations every 5 minutes: 17,280/month     | Full-path drill and notification-provider usage       |
| Media               | Selected real-browser runner                | Every 30 minutes                             | Every 15 minutes                              | Coordinated-client billing, runtime, compute, cleanup |
| Artifacts           | Recorder/browser runner                     | Daily and after deploy                       | Daily                                         | Recorder time, transcript cost, storage, and cleanup  |
| Telemetry pipeline  | Managed backend canary, outside synthetics  | Every minute                                 | Every minute                                  | Signal bytes, series, queries, retention, and alerts  |

Using Grafana's 43,200-minute monthly formula, the four production API-class
rows total about 69,120 executions in the production account. The four staging
rows remain at 11,520 executions while staging is dormant because they switch
to lease, controller, status, and target-absence assertions. Each remains below
its own 100,000-account allowance before retries and drills. Active-only media,
artifact, and application-telemetry tests are separate; the managed-backend
canary remains active every minute. The totals exclude browser tests, media,
artifacts, fallback replay checks, and telemetry ingestion. A two-minute billed
browser execution consumes twice the one-minute estimate, and a coordinated
two-client test may consume more than one browser execution. The final sheet
uses both the provider formula and a 31-day maximum, with one row per test,
location, retry policy, execution duration, coordinated client, and non-Grafana
runner resource.

Each Grafana account forecast also includes metric active series and data points
per minute, log/trace/profile GB ingested, frontend sessions, active users,
query/SLO features, notification delivery, and telemetry egress. Staging records
each measured input before production is activated. A forecast outside a Free
allowance blocks promotion until signal volume is reduced or Hasan approves a
different backend plan; production coverage is never weakened silently.

Launch cost guardrails are stated before taxes and credits:

- production plus shared fixed foundation warns above $110/month;
- dormant and fixed staging resources warn above $15/month, excluding
  production, shared foundation, and explicitly metered activation work;
- the combined staging, production, and shared fixed-resource forecast has a
  $200/month hard ceiling;
- an automatic staging plan that adds more than $10/month relative to its last
  approved forecast pauses for Hasan's explicit cost approval;
- every production plan remains approval-only regardless of its amount.

The normal selected baseline is about $93.48 for production plus shared
foundation and $7 for dormant staging, or $100.48 combined. Capture, render,
SFU, R2, transcription, active staging, and other work that scales with actual
use belongs to a separate usage forecast and ledger. At 1,000 recorded hours,
the recorder-only sustained-load lower bound adds about $88–$194 before normal
participant media and transcription. The fixed $200 ceiling is therefore a
platform-idle control and is never described as an all-in monthly bill.

Every recording reservation atomically reserves estimated concurrency, render
deadline capacity, tenant minutes, and dollar exposure from its usage budget.
The estimate settles to measured cost after finalization. Production has zero
unfunded recording quota: a tenant or internal program must have an approved
allocation before admission. Usage alerts fire at 50, 80, and 100 percent of
both tenant and global exposure. Reaching the limit closes new and unaccepted
admission; it never terminates an active capture or abandons an already accepted
reservation. Pricing or quota changes do not alter the infrastructure ceiling.

A warning emits a visible plan annotation and cost alert but does not by itself
authorize or block an otherwise valid staging apply. The hard ceiling, an
unpriced enabled resource, or a staging delta above $10 blocks apply. A hard
ceiling is a planned fixed-resource control rather than a provider billing cap.
A staging activation always retains its expiry and scale-to-zero behavior.

## Application Readiness Dependencies

### Go API

Before go-live, the API lane must provide:

- a production, non-root, multi-architecture image and graceful shutdown proof;
- complete environment validation for the selected Cloudflare SFU, R2,
  PlanetScale, optional Redis acceleration, domain, and observability configuration;
- liveness that reports only process health and readiness that names required,
  degraded, and optional dependency failures without triggering replacement
  loops during a provider outage;
- trusted proxy and client-IP handling for cloudflared;
- a release/version endpoint or safe health metadata;
- separate runtime and migrator database roles;
- a migration compatibility and live smoke contract;
- user/tenant deletion, pseudonymization, tombstone replay, expiry scheduling,
  and provider-deletion workflows for every retained PostgreSQL class;
- provider timeouts, retries, reconciliation, and safe degraded behavior.

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

### Recorder and transcription

Before staging can pass or production can be planned:

- the capture and render images, auth, reservation, job, artifact, cleanup, and
  resource contracts exist;
- zero-idle scaling, scheduled prewarm, unscheduled start hold, 20-meeting
  and 100-participant admission, ten-participant room bound, 120-minute limit,
  capture density, N+1 replacement, ten-node render ceiling, one-time
  bootstrap, certificate revocation, and provider reconciliation pass;
- PostgreSQL job leasing, retry, dead-letter, reconciliation, and connection
  budgets are tested;
- the recorder control API owns every database transition and workers prove
  they have no PlanetScale or infrastructure-control credential;
- selective track capture, the stage-layout timeline, 10–15-second encrypted
  bundle upload, fencing, replacement resume, gap attribution, manifest
  finalization, and orphan cleanup pass under worker and node loss;
- authenticated track ownership, versioned VAD/turn/overlap derivation, the
  speaker-turn manifest, and chunk-to-meeting timestamp mapping pass without
  acoustic identity inference or full-duration participant-track billing;
- the native GPU renderer produces the ratified 720p30 H.264/AAC stage artifact
  within 30 minutes across the maximum ending-together workload;
- application-layer bundle encryption, memory-only TOR1 decryption, per-job key
  handling, normal one-hour deletion, and 24-hour orphan expiry pass;
- R2 upload/finalization and PostgreSQL transitions are idempotent;
- normalized transcript document bytes move to R2; the current
  `transcriptions.text` column cannot remain the production content authority;
- the provider-neutral transcription port, DeepInfra primary adapter,
  Cloudflare fallback adapter, scale-to-zero Lambda dispatcher, exact model
  version, fenced single-result commit, and provider/model/version audit facts
  exist;
- DeepInfra's privacy/commercial gate, environment token isolation, spending
  alerts, quota/concurrency proof, conformance corpus, quality thresholds, and
  fallback circuit breaker pass before it becomes the production default;
- workers use job-scoped upload authority and never hold reusable R2 object
  credentials;
- recording and transcript delete endpoints revoke access, tombstone metadata,
  delete R2 bytes and provider copies, and verify completion within 24 hours;
- retry, dead-letter, reconciliation, duplicate/late-response rejection, and
  forced Cloudflare fallback pass without provider racing or webhooks;
- retention, erasure, orphan cleanup, and restore-tombstone behavior pass;
- a full composite-recording-to-transcript staging canary reaches terminal
  state on the selected production capture and render providers and classes,
  then the same corpus passes with DeepInfra disabled and Cloudflare active.

### Observability, uptime, and status

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

## Execution Handoff Contract

This spec is ready for a fresh implementation worker. Work begins at Phase 0
and advances in order; a later phase never inherits an unmet earlier gate.
Verification gates, benchmarks, provider inventory, and exact prices are
execution work rather than invitations to redesign the settled architecture.

The active execution handoff must name:

- the permitted phase range and whether it includes staging provider writes;
- the exact private AWS account/profile, Cloudflare account and zone,
  DigitalOcean team/project, SGP1 capture and TOR1 GPU quota, environment- and
  role-scoped automation-token references, PlanetScale organization, Grafana
  account owners, DeepInfra account and environment-token references,
  Cloudflare Workers AI account/token references, GitHub environments, and
  1Password vault to bind during inventory;
- the company-controlled non-Cloudflare notification destination;
- whether the worker stops at a reviewed staging plan or continues through a
  verified staging apply.

These bindings stay in the active private execution context or `.private/`, not
in this public spec. If a required binding is absent, the worker may continue
local implementation and read-only discovery but stops before the affected
provider write. The worker tests Grafana k6 browser support first for the
two-client media proof; an observed capability or allowance failure returns to
Hasan with evidence and priced alternatives rather than selecting another paid
runner silently.

No handoff wording authorizes production creation. Production retains the
two-approval database bootstrap, fresh OpenTofu plan, exact release approval,
and live-verification gates defined below.

## Implementation Phases

### Phase 0 — Record ratification and inventory

- record the ratified spec revision and the active implementation scope;
- approve a read-only inventory of existing provider resources;
- identify preserved R2 buckets and any reusable state backend without writing
  identifiers into the public repo;
- produce the first dated cost estimate;
- map every runtime variable and secret owner;
- verify that Grafana permits the two company-controlled Free accounts, prove
  their separate recovery and quota boundaries, and block for a newly ratified
  backend if it does not;
- verify Workers Paid account limits, the Cloudflare status path, and the
  non-Cloudflare notification route;
- verify DigitalOcean SGP1 CPU and TOR1 RTX 4000 availability, contracted GPU
  access, a team burst quota of at least twenty-one nodes, the eleven-capture
  and ten-render role limits for either active environment, and API creation limits
  without creating production capacity;
- verify the DeepInfra model/version catalog, environment account boundary,
  200-request quota, price, spending controls, DPA, subprocessors,
  processing-location and logging terms, plus the Cloudflare Workers AI
  fallback price, quota, and token boundary; no customer audio is sent during
  inventory;
- encode the ratified DigitalOcean capture/render bindings, the $110 production
  fixed warning, $15 staging fixed warning, $200 combined fixed ceiling, and
  separate recording usage ledger in plan and policy checks;
- encode the ratified data-class retention, RPO/RTO, absent legal hold, and
  deletion propagation in configuration, tests, and public policy text.

Gate: the ratified spec revision is recorded, and the active execution thread
explicitly names its permitted phases and provider-write scope.

### Phase 1 — Packaging and local runtime

- add production API, sync, recorder-capture, and recorder-render images;
- add the local production-shaped runtime definition;
- run optional bounded Redis acceleration alongside PostgreSQL Sync authority;
- implement the static SPA runtime-config contract and PostgreSQL job leasing;
- implement recording reservations, usage holds, the recorder control API,
  native selective capture, encrypted capture bundles, the layout timeline,
  fenced resume, native GPU composition, speaker-turn and overlap manifests,
  transcription chunks, provider-neutral ASR adapters, normalized transcript
  storage, and a deterministic multi-track multilingual media corpus;
- integrate the observability lane and prove its local telemetry pipeline and
  journey ledger from a clean host;
- add health, shutdown, resource, configuration, and image tests;
- prove both supported architectures;
- close the application blockers needed to boot staging.

Gate: a clean local host can build, start, migrate, exercise API, WebSocket, and
segmented recorder flows, stop, and restart the complete runtime.

### Phase 2 — OpenTofu bootstrap and foundation

- implement remote encrypted state and native locking;
- implement GitHub OIDC and protected environment roles;
- implement modules, policy checks, and cost checks;
- declare only shared PlanetScale organization prerequisites; create no
  environment database container in foundation;
- declare/import protected Cloudflare resources;
- configure GHCR release publishing and signature verification;
- declare the managed telemetry integration, environment-specific collector
  credentials, component uptime services, and status projection infrastructure;
- implement the external EventBridge/Lambda staging lease controller,
  conditional activation record, heartbeat, drift alerts, and bounded cleanup;
- implement separate DigitalOcean SGP1 capture and TOR1 render modules,
  one-time role-bound identity bootstrap, reservation-aware zero-idle scalers,
  20-meeting/ten-render-node bounds, worker and lease reconciliation, encrypted
  bundle lifecycle, and fixed-versus-usage cost controls;
- implement the scale-to-zero AWS transcription Lambda module, private
  digest-addressed release artifacts, environment-scoped SSM credentials,
  bounded concurrency, primary/fallback policy, temporary-object lifecycle,
  and per-attempt cost telemetry;
- implement isolated environment release ledgers and conditional-transition
  tests.

Gate: clean plans, state recovery proof, protected-resource no-delete proof, and
no production apply.

### Phase 3 — Staging

- idempotently create or adopt the staging PlanetScale database container, then
  create its persistent non-HA branch, roles, backup policy, and configuration;
- create the persistent staging Pages, Tunnel, R2, SFU app, SSM configuration,
  Grafana account integration, and monitoring;
- activate the app node through a bounded lease and prove automatic expiry,
  drain, scale-to-zero, root-volume deletion, and honest `Dormant` status;
- create an isolated leased HA database rehearsal branch, prove restore and
  failover with the same release, return to PS-5, and prove role revocation and
  branch deletion even after an injected cleanup failure;
- deploy the exact release manifest;
- run migrations and full end-to-end verification;
- activate staging capture and render capacity and prove reservation prewarm,
  unscheduled start hold, selective bundle capture, worker/node-loss resume,
  native composite rendering, speaker-turn manifest finalization, track-aware
  transcription, authorization, retention, erasure, reconciliation, and
  cleanup;
- run the ratified multilingual/noise/overlap corpus through the pinned
  DeepInfra and Cloudflare models, prove normalized-schema parity, timing and
  speaker-attribution thresholds, opaque provider payloads, DeepInfra's
  50-request internal cap, 429/backoff behavior, conditional single-result
  commit, forced circuit-breaker fallback, and no full-track minute
  multiplication;
- prove 20 simultaneous native captures using the real direct-SFU path, first at
  the four-room/40-participant/16-Mbps per-node target and then at the
  two-room/20-participant/8-Mbps fallback when required; exercise both 20
  three-person rooms and the five-ten-person-plus-fifteen-three-person stress
  mix; record CPU, memory, packet loss, keyframe latency, bandwidth, object
  rate, and the effect of losing one full node while the N+1 spare accepts its
  jobs;
- render a deterministic corpus representing 20 two-hour meetings ending
  together and prove the ten-node ceiling commits every 720p30 artifact within
  every deadline sub-budget with a per-node factor of at least 15x and a
  qualified service time at or below ten minutes per two-hour job; record node
  readiness, queue, input, render, upload, verification, recovery reserve, GPU
  decode/encode utilization, CPU, memory, local bytes, output quality, retries,
  and teardown;
- prove envelope encryption before cross-region processing, memory-only
  plaintext handling, job-key revocation, normal one-hour bundle deletion, and
  24-hour orphan cleanup;
- replace the app node during active capture and render work; prove the
  30-minute autonomy envelope and 20-minute minimum authority at failure onset,
  conditional uploads, no overlapping attempt,
  post-recovery object/lease reconciliation, explicit authority-expiry outcome,
  and complete usage settlement;
- benchmark cold scale-out, spare recovery, SFU ingress, both DigitalOcean
  transfer pools, R2 operations/storage, and cost per recorded minute at 50,
  80, and 100 percent of the launch workload;
- replace the 2,000-hour planning range with an observed reservation replay and
  provider-billed-minute forecast, including a full-month Cloudflare fallback;
- prove every component probe, telemetry signal path, public status projection,
  and alert route independently;
- replace the app node from scratch;
- reactivate from zero and prove the stable release reconstructs without manual
  repair or prior-node state;
- exercise deploy rollback, partial-release recovery, Stateholder recovery,
  health-triggered replacement, and secret rotation;
- prove a full node loss recovers acknowledged Sync outcomes from PostgreSQL
  without relying on node-local or Redis state;
- disable each monitoring path and prove the independent path alerts.

Gate: staging passes every defined functional, failure, recovery, security,
observability, and cost check.

### Phase 4 — Production plan

- when the production PlanetScale database container does not yet exist,
  produce its signed bootstrap action manifest and request approval for that
  action alone;
- after the approved bootstrap records the immutable database ID, return to
  this phase and produce a fresh production OpenTofu plan;
- produce the production OpenTofu plan and release promotion preview;
- show the cost delta, data lifecycle matrix, recovery objectives, migration,
  rollback, recorder capacity, fixed platform forecast, separately funded usage
  allocation, per-minute cost, pinned transcription provider/model/version,
  fallback exposure, and live checks;
- confirm the exact target and proposed release manifest.

Gate: Hasan explicitly approves the exact production action.

### Phase 5 — Production creation and promotion

- if this is the first approved database-bootstrap action, idempotently create
  or adopt only the production PlanetScale database container, verify and
  record its immutable ID, stop, and return to Phase 4;
- apply the approved production plan;
- create the protected HA branch, roles, backup policy, and configuration only
  through that second approved plan;
- promote the exact staging release;
- run live schema, revision, API, sync, Pages, DNS, TLS, two-client meeting, and
  bounded synthetic recording verification, then verify artifact cleanup;
- record evidence and stop.

Gate: the intended live revision completes the user flow, and the approved
recorder fleet produces and cleans up the synthetic artifact. Infrastructure
code, green unit tests, or provider dashboards alone do not pass.

## Verification Matrix

| Area               | Required proof                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| IaC                | Format, validate, lint, policy/security scan, provider lock, redacted plan, idempotent second plan            |
| State              | Concurrent lock rejection, encrypted state, earlier-version recovery, least-privilege state access            |
| Protected adoption | Existing R2 plan has no delete/replacement; live object/header/hash checks pass                               |
| Compute            | Fresh boot, health authority, wedged service, measured headroom, lease expiry, controller-driven replacement  |
| Secrets            | No log leakage, least-privilege reads, rotation, revoked old credential, fresh-node boot                      |
| Database           | Checksums/lock/timeouts, migrate, backup/restore, HA failover, PS-5 return, rehearsal leak cleanup            |
| Journey ledger     | Attribution, auth, bounds, pool isolation, retention, erasure, overload, and failed-PostgreSQL behavior       |
| Stateholder        | PostgreSQL recovery, exact ordered history, receipts, lifecycle intents, Redis-absent correctness, and RPO/RTO |
| Tunnel             | Normal routing, no direct origin, cloudflared restart, client IP/rate-limit correctness                       |
| Web                | Exact code/config digests, SPA fallback, assets, CSP/CORS, canonical origins, live build identity             |
| Sync               | Signed auth, two clients, heartbeat, reconnect, replay/snapshot, graceful deploy, load and soak               |
| Media              | Direct SFU publish/subscribe, remote playable outcome, failure classification, usage visibility               |
| Release            | Ledger CAS, partial failures, exact approval inputs, rollback, stable live revision proof                     |
| Recorder           | Reservation, 20-way capture, density/N+1 loss, encrypted bundles, 30-minute GPU render, erasure, usage cost   |
| Transcription      | Track attribution, overlap, schema/quality corpus, pinned DeepInfra, forced Cloudflare fallback, billed audio |
| Monitoring         | Component and lease heartbeats, external/Cloudflare failures, replay, alerts, status, pipeline canary         |
| Cost               | Dated fixed/usage ranges, 1,000/2,000-hour cases, quotas, uncertainty, alerts, ceiling, expected apply delta  |

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

Production activation is a separate done state. After explicit approval, the
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
- Cloudflare RealtimeKit recording guide:
  https://developers.cloudflare.com/realtime/realtimekit/recording-guide/
- Cloudflare RealtimeKit pricing:
  https://developers.cloudflare.com/realtime/realtimekit/pricing/
- Cloudflare Workers AI Whisper large-v3-turbo contract and pricing:
  https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/
- Cloudflare SFU provider resource:
  https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/calls_sfu_app
- DeepInfra Whisper large-v3-turbo contract and pricing:
  https://deepinfra.com/openai/whisper-large-v3-turbo
- DeepInfra OpenAI-compatible audio transcription API:
  https://docs.deepinfra.com/api-reference/audio/openai-audio-transcriptions
- DeepInfra standard-inference privacy and logging behavior:
  https://docs.deepinfra.com/account/data-privacy
- DeepInfra default concurrency and 429 behavior:
  https://docs.deepinfra.com/account/rate-limits
- DeepInfra model version and deprecation behavior:
  https://docs.deepinfra.com/models
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
- PostgreSQL `SKIP LOCKED` queue behavior:
  https://www.postgresql.org/docs/18/sql-select.html
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
- DigitalOcean Droplet pricing:
  https://www.digitalocean.com/pricing/droplets
- DigitalOcean detailed CPU and GPU Droplet pricing and billing:
  https://docs.digitalocean.com/products/droplets/details/pricing/
- DigitalOcean GPU specifications and transfer allowances:
  https://docs.digitalocean.com/products/droplets/details/features/
- DigitalOcean Droplet bandwidth billing:
  https://docs.digitalocean.com/platform/billing/bandwidth/
- DigitalOcean regional availability:
  https://docs.digitalocean.com/platform/regional-availability/
- DigitalOcean team resource limits:
  https://docs.digitalocean.com/platform/resource-limits/
- DigitalOcean scoped and expiring API tokens:
  https://docs.digitalocean.com/reference/api/create-personal-access-token/
- DigitalOcean Droplet autoscale-pool behavior:
  https://docs.digitalocean.com/products/droplets/concepts/autoscale-pools/
- Pion native WebRTC implementation and RTP/codec support:
  https://github.com/pion/webrtc
- Pyannote acoustic speaker-diarization toolkit, future mixed-audio adapter:
  https://github.com/pyannote/pyannote-audio
- FFmpeg stream copy and transcoding behavior:
  https://ffmpeg.org/ffmpeg.html
- FFmpeg segment muxer behavior:
  https://ffmpeg.org/ffmpeg-formats.html
- GStreamer compositor:
  https://gstreamer.freedesktop.org/documentation/compositor/index.html
- NVIDIA Video Codec SDK encode performance and session behavior:
  https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/nvenc-application-note/index.html
- LiveKit comparable self-hosted composite and track egress requirements:
  https://docs.livekit.io/transport/self-hosting/egress/
- LiveKit comparable SFU benchmark methodology:
  https://docs.livekit.io/transport/self-hosting/benchmark
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
