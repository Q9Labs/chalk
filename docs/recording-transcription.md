# Recording and transcription

Recordings move from a durable start command through encrypted capture,
rendering, download, transcription, and temporary-source cleanup. This document
describes the architecture, processing flow, cost model, and release boundaries.

## Space recording preparation

Preparation uses the tenant-scoped Space `recording-preparation` resource.
`PATCH` accepts `starts_at` and `expected_revision` (`0` for the initial intent);
`GET` returns the current revision, preparation window and observed capacity;
`POST .../cancel` accepts the revision. Retries of the same command are
idempotent. A newer revision fences stale reschedules and cancels. Preparation
does not create an Episode, freeze a presentation or capture media. It becomes
`warming` only within the lead window, and `ready` only with fresh, unoccupied
capacity. Readiness is an observation, not a guaranteed admission reservation.
An actual recording consumes the intent atomically; cancellation never stops
that recording. Maintenance durably expires unused intents after the grace.

See [shared-host rollout](../infrastructure/managed-episode/recording-control.md)
and the [cost-first profile](../infrastructure/recorder/profiles/cost-first.json).
No production enablement, ingress change, secret issuance, paid provider call or
new cloud resource is authorized by local verification.

See [Recording duration limits](recording/duration-limit.md) for the reserved
deadline, clean stop behavior and `source.stop_reason`.

## Architecture

```mermaid
flowchart LR
  participant[Participant UI] --> sync[Sync recording plane]
  sync --> api[API control plane<br/>Postgres authority]
  api --> fleet[External fleet reconciler]
  fleet --> capture[Disposable capture worker<br/>c-2 baseline; smaller profile gated]
  capture --> temp[Private R2<br/>encrypted sequenced bundles]
  api --> kms[AWS KMS<br/>context-bound data keys]
  temp --> render[NYC1 c-8 render worker<br/>libx264]
  kms --> capture
  kms --> render
  render --> artifact[Private R2<br/>MP4 + transcript source]
  artifact --> dispatcher[AWS Lambda dispatcher]
  dispatcher --> asr[Direct DeepInfra<br/>Whisper large-v3-turbo]
  asr --> transcript[Normalized transcript.v1]
  transcript --> api
  api --> participant
  dispatcher --> cleanup[Durable temporary-object cleanup]
```

Postgres is the sole authority for intent, admission, assignments, leases,
fences, attempts, and terminal state. R2 is an object store, not a job queue.
DigitalOcean workers are disposable executors with short-lived workload
identity and object-scoped grants; they do not receive reusable DigitalOcean,
KMS, or R2 control credentials.

The implementation is split at stable boundaries:

- Sync serializes recording intent with the Episode control row and reserves the
  external operation.
- The API checks qualified capacity and health, freezes the presentation facts,
  creates fenced capture/render work, and independently verifies every reported
  object before committing completion.
- The external reconciler scales separate capture and render pools from zero,
  bootstraps immutable digest-pinned nodes, replaces unhealthy nodes, and drains
  them without making provider inventory authoritative.
- Capture writes encrypted, ordered media or explicit gap bundles. A controlled
  gap is data: it preserves the timeline across pauses, absent tracks, or worker
  handoff instead of silently shortening the recording.
- Render downloads only the accepted bundle set, reconstructs the frozen
  presentation, and produces the final MP4 plus recorder-owned transcription
  sources.
- The Lambda dispatcher claims fenced transcription chunks, invokes one selected
  provider, writes normalized conditional results, finalizes one deterministic
  transcript, and durably retries cleanup until temporary objects are absent.
- The public API exposes recording and transcript list/get operations and
  short-lived download authority; provider and object keys are not client
  controls.

## End-to-end flow

1. A participant with `manageRecording` starts recording. Sync durably reserves
   the operation before acknowledging it.
2. The API admits the request only against qualified, public-safe pool health,
   then creates generation- and fence-bound jobs.
3. The reconciler supplies an SGP1 CPU-Optimized `c-2` capture node. The worker
   joins the SFU as a controlled subscriber and writes encrypted sequenced
   bundles to a recording-scoped temporary R2 prefix.
4. Episode end closes the capture plan. The API validates continuity, checksums,
   sizes, codecs, and object ownership before accepting capture.
5. A deadline-aware scaler supplies an NYC1 CPU-Optimized `c-8` render node. The
   measured profile uses eight browser frame producers and `libx264`; GPU render
   remains an optional, separately qualified configuration.
6. The API verifies the MP4 in R2, atomically commits the artifact, and issues
   short-lived download authority.
7. The committed recorder source is split into fenced transcription jobs. The
   Lambda dispatcher sends audio to
   DeepInfra's `openai/whisper-large-v3-turbo`, normalizes the results, and finalizes the
   stable transcript document.
8. Durable cleanup jobs delete transcript intermediates and recorder sources.
   Completion is accepted only after independent absence checks.

## Decisions

| Decision                                                              | Reason                                                                                                                            |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Durable control facts precede external work                           | A retry, process crash, or provider timeout cannot invent or lose acknowledged Episode state.                                     |
| Jobs use generation, fence, lease, and compare-and-set completion     | Late or replaced workers cannot overwrite newer truth.                                                                            |
| Provider inventory is reconciled outside OpenTofu                     | Pools can scale and replace nodes quickly while OpenTofu continues to own immutable policy, caps, firewalls, and image contracts. |
| Workers receive one-time bootstrap and job-scoped authority           | A compromised media worker cannot create infrastructure, enumerate a bucket, or decrypt another recording.                        |
| Capture stores encrypted sequenced bundles rather than one open movie | Work can resume after a handoff, discontinuities remain explicit, and render can verify a closed input set.                       |
| Presentation facts and UI build hash are frozen before render         | A retry renders the same participant layout and assets instead of whatever the current web release happens to serve.              |
| The qualified renderer is CPU-based                                   | The NYC1 `c-8`/`libx264` profile was available and met the measured deadline; a GPU dependency was unnecessary.                   |
| Transcription has one pinned provider per attempt                     | Provider failover cannot silently change privacy, residency, output shape, or billing semantics.                                  |
| Transcript finalization and source cleanup are durable jobs           | Provider success is not confused with a complete customer artifact, and cleanup survives partial failure.                         |

## Cost model

The table below is the historical Cloudflare/c-2 qualification baseline, not
the new deployment's measured invoice. Direct DeepInfra currently lists
$0.00020 per submitted audio minute, or $24–72 for 2,000–6,000 audio hours.
That range depends on actual per-Participant audio submitted, retries and
silence—not merely wall-clock recording time. [DeepInfra model API and price](https://deepinfra.com/openai/whisper-large-v3-turbo/api)

The native adapter persists its requested model and adapter contract separately
from observed request/model/execution metadata. Missing metadata stays absent;
optional identity pins fail closed when evidence is missing or mismatched.
`providerReportedCostUsd` is recorded only when returned by the provider. A
final transcript sums it only when every chunk reports it. This excludes
unobserved failed/retried calls and is not an invoice or a fabricated billed
audio-duration claim.

Prices below are public list prices checked on 2026-09-10. They are an
incremental artifact-pipeline estimate, not a total Chalk or SFU bill.

| Component                  |                                                          Public unit price |                                                                                                    Measured or normalized cost |
| -------------------------- | -------------------------------------------------------------------------: | -----------------------------------------------------------------------------------------------------------------------------: |
| Capture compute            |                         DigitalOcean CPU-Optimized `c-2`: **$0.0625/hour** |                                                  **$0.0625 per recorded hour** at one fully utilized active recording per node |
| Render compute             |                           DigitalOcean CPU-Optimized `c-8`: **$0.25/hour** |                                  The qualification rendered 556.372 seconds in about 324 seconds: **$0.146 per recorded hour** |
| Transcription              |                Workers AI Whisper large-v3-turbo: **$0.0005/audio minute** |                                **$0.03 per audio hour submitted**; the 2.394-minute qualification input cost about **$0.0012** |
| Final MP4 storage          |                                           R2 Standard: **$0.015/GB-month** | The 22.823 MB, 556.372-second proof normalizes to about 0.148 GB per recorded hour: **$0.0022 per stored recorded-hour-month** |
| R2 operations and delivery | Class A **$4.50/million**, Class B **$0.36/million**, Internet egress free |                                                     Small beside compute at this object count; monthly free tier may absorb it |
| Envelope encryption        |    AWS KMS key **$1/month**, requests **$0.03/10,000** after the free tier |                                              Fixed key cost is shared by the environment; request cost depends on bundle count |

The normalized capture plus render compute is about **$0.208 per recorded
hour**. With one audio hour submitted for transcription, the direct variable
total is about **$0.238 per recorded hour**, plus approximately **$0.0022 for
each month the resulting hour remains stored**. Add these deployment-specific
terms separately:

- ready-spare or scheduled-prewarm time, underutilized nodes, and retry work;
- one transcription charge for every audio minute actually submitted (for
  example, multiple isolated tracks increase the total);
- temporary R2 byte-hours and operations;
- KMS, Lambda, control-plane, observability, SFU, and provider-account charges;
- taxes, discounts, and future price changes.

Sources: [DigitalOcean Droplet pricing](https://www.digitalocean.com/pricing/droplets),

[Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/),
[Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/), and
[AWS KMS pricing](https://aws.amazon.com/kms/pricing/).

## Prior qualification environment

The 2026-09-10 qualification used the immutable recorder release built from
commit `0f2c5d0a` and exercised the real API, Sync, Cloudflare SFU/R2/Workers AI,
AWS KMS/Lambda, and DigitalOcean pools:

- two browser participants exchanged bidirectional audio and video while a real
  capture worker subscribed through the SFU;
- ordered audio/video bundles and eleven contiguous explicit gap bundles closed
  without a timeline discontinuity;
- the CPU renderer completed on its first attempt and produced a 22,823,192-byte
  MP4 with a 556.372-second probed duration;
- API list, get, and signed download returned the same bytes as the independently
  read R2 object;
- two transcription chunks completed on their first attempt, finalization
  produced a 19-cue transcript, and API/download bytes matched R2;
- all five cleanup jobs completed on their first attempt and every temporary
  transcript/source object returned not found;
- capture and render returned naturally to zero active jobs, reservations, and
  nodes, with future demand cleared.

The proof also caught and corrected a coupled-release failure: the render worker
image and API's allowed presentation UI hash must move together. That invariant
is now treated as part of the release tuple, not mutable deployment trivia.

This qualification does **not** claim completion of live in-Space captions,
first-party mobile recording/transcript wiring, every regional load ceiling,
every possible worker-loss timing, or managed observability and notification
configuration. Those remain separate product and operational milestones.

## Recorder releases

Use the [Release, Nightly and Promote workflows](managed-release.md).
There is no separate recorder publish or deploy command. The pipeline builds
first-install or changed images, records immutable media members, updates only
the selected environment's pins, deploys the backend and dispatcher, and runs
cold signed-boot qualification before accepting the nightly cut.

`boot-check.py` remains the pipeline's isolated diagnostic. It receives an exact
candidate image identity and reads the target environment's fleet configuration.

The hook reads current role settings and uses the fleet's provider adapter and
controller bootstrap API. It creates a separately named/tagged diagnostic node,
mirrors bootstrap egress, and blocks the worker API so it cannot take live work.
All configured fleet SSH keys are preserved; the task key is added only to the
diagnostic create payload, outside the fleet config's key-count limit. A durable
create fence blocks a second POST after an accepted or uncertain response; a
definite provider 422 may retry without counting as another boot.
There are no pin, demand or fleet-setting writes. The diagnostic also copies
the bootstrap environment **after** the unchanged bootstrap/worker commands.
Fleet cloud-init stops on a failed bootstrap or worker start; subsequent commands
cannot hide that failure by returning success, and workers cannot start after a
failed identity bootstrap.
Guest evidence does not depend on SSH. An evidence-only `bootcmd` starts a bounded
background collector before the unchanged bootstrap/worker commands. Every thirty
seconds it PUTs cloud-init logs/status, boot journal, network/resolver state and
the installed public certificate to one short-lived presigned S3 object. No AWS
credential or identity private key is installed on the guest. The bucket defaults
to the private state bucket in the release configuration; an explicit
`CHALK_BOOT_CHECK_EVIDENCE_BUCKET` may select another encrypted, public-blocked,
DNS-compatible bucket without dots in the same AWS region. The operator needs
bucket encryption/public-block reads and scoped object read/write/version-delete
permissions. Existing fleet HTTPS egress must permit the upload; it is never
widened silently. The watchdog removes every object version and deletion marker
after node deletion. Downloaded evidence remains private beside the receipt and
records actual create/user-data hashes, provider inventory, cloud-init, issuer
issuance and the installed certificate.
PASS requires the candidate manifest, matching issuer certificate, CA/identity/
serial verification and confirmed scoped cleanup. Registration alone is FAIL.

A detached watchdog owns cleanup even if the caller exits. The default invocation
budget is eight minutes, below the release command's ten-minute hook timeout;
the runner rejects compute estimates above $0.05. For a separately authorized
diagnostic, `CHALK_BOOT_CHECK_DEADLINE_SECONDS` may extend the cap to 2700 seconds
and `CHALK_BOOT_CHECK_BOOT_TIMEOUT` bounds registration inside that cap. Never
extend a release qualification past its caller timeout. On cleanup failure, use
the receipt's private evidence directory and `ledger.jsonl` to recover the exact
owned IDs; do not scan/delete shared production tags. A failed or interrupted
attempt cannot be repaired into a passing cold-boot receipt.

Only one release owner may publish: SSM has no atomic compare-and-swap. Publication
checks the planned version/hash immediately before writing, preserves other values
and KMS metadata, and verifies readback. Deploy uses a canonical managed manifest
(including unchanged component provenance for an input-only reload), permits only
a Scheduler state change, and checks actual loaded process inputs. On failure the
Scheduler stays disabled; inspect the canonical controller result before recovery.

## Dispatcher binding during managed releases

The API authenticates each dispatcher request with HMAC over the body, path,
release, environment, role, audience and tracing context. It also checks the
signature window and consumes the nonce once. The release must equal the loaded
API component release (`CHALK_API_VERSION`); an old or unapproved release remains
unauthorized. These checks are unchanged.

The Release workflow's `scripts/deploy/deploy-managed-release.mjs` carries the dispatcher
binding forward after the host controller proves a healthy deployment. It reads
the recorder release configuration from SSM, verifies the target runtime and the
Lambda's current digest/binding, and reconstructs the dispatcher OpenTofu root
from current remote state. A retained API component keeps its existing binding.
For a changed API component, it:

1. Requires a clean OpenTofu drift plan and a version-pinned source ZIP whose
   bytes match the recorded SHA-256.
2. Copies those bytes to a key containing the API component release and digest,
   pins the returned S3 version, and plans the binding change.
3. Refreshes the non-secret runtime configuration digest and allows only the
   Lambda release/configuration digests, artifact location, description and
   corresponding tags, plus the log group's release tag. It applies guarded
   targeted plans for the log group and then Lambda, avoiding deferred unknown
   IAM policy changes. A full zero-drift plan and Lambda health, code digest and
   release readback must pass afterward.

The release fails if binding or verification fails, even if the host deployment
succeeded. Preserve any existing scheduler pause until runtime and binding
verification pass.
If deployment fails, inspect the failure and restore a clean
baseline before retrying with the same manifest. A failed Lambda apply after
the log-tag step can leave that tag ahead of the bound release; restore the tag
to the currently bound release before retrying. Do not manually enable the
scheduler before verification passes.
Requests already running during a release can briefly receive 401; normal fenced
retries reconcile them after the binding update.

Managed release `--dry-run` reports `dispatcher_binding` with the selected
ZIP digest and version, after artifact readback and a read-only state plan.
Dry runs do not copy,
apply, invoke SSM commands or verify loaded processes. Production configuration
is mandatory. Other configured environments use their own scoped recorder
configuration; there is no production configuration fallback.

The deployment identity needs the existing dispatcher module's read/apply
permissions, remote state and lock access, SSM configuration read, and versioned
artifact read/copy permissions. CI installs the repository-pinned OpenTofu. No
new API trust key, allowlist of older releases or authentication exception is
introduced. Public workflow runs must not log private configuration or state.
