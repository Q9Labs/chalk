# Chalk Recorder and Artifact Pipeline Spec

Status: Ratified companion to the infrastructure readiness spec.

Parent: `scratchpad/chalk-infrastructure-readiness-spec-2026-07-11.md`. Its
settled decisions, canonical terms, non-goals, source-of-truth rules, R2 and
KMS storage contract, and anti-slop rules bind this document.

Owner: Hasan Shoaib

## Purpose and scope

This spec defines the recording pipeline from admission through committed
artifact: reservation and capacity placement, native selective capture on
SGP1, asynchronous GPU composite rendering in TOR1, worker identity and
reconciliation, the recording and transcript state machines, and the
PostgreSQL artifact-job contract. The recording overview and admission
ceiling live in the parent's Recorder and Artifact Pipeline section;
track-aware transcription — the consumer of the speaker-turn manifest and
audio chunks this pipeline emits — is specified in
`scratchpad/chalk-transcription-spec-2026-07-12.md`.

## Admission and reservation

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
drains after ten minutes. An unscheduled recorded meeting holds its opening
until a capture process acknowledges its lease; the initial maximum wait is
120 seconds and is replaced by the measured cold-start bound if staging proves
a lower value. Expiry fails visibly as `recording_capacity_unavailable`. The
meeting never starts under a promise that its missing opening minutes were
recorded, and it never silently falls back to client-side capture.

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

## Native selective capture

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

## Asynchronous composite rendering

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
or operator hold schedules raw-media retention beyond the 24-hour lifecycle
rule; because R2 lifecycle enforcement may itself lag up to a further day,
deletion evidence records the observed removal time.

## Worker identity and reconciliation

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

## Recording and transcript state machines

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

## PostgreSQL artifact jobs

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

## Considered recording methods

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

## Launch readiness dependencies

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
- R2 upload/finalization and PostgreSQL transitions are idempotent.

Transcription-specific readiness dependencies continue in the
transcription spec.

This spec is done when every item above has recorded evidence in the
execution ledger at the ratified ceilings, and work stops there.
Deliberately out of scope at launch: post-meeting gallery re-edits (tracks
outside the stage view are not retained), recordings beyond the 120-minute
limit or the ten-participant room bound, acoustic diarization, client-side
capture, and the self-hosted SFU packet tap (see Considered recording
methods). The single deterministic stage layout is accepted as good enough
for launch.

## References

- Cloudflare RealtimeKit recording guide:
  https://developers.cloudflare.com/realtime/realtimekit/recording-guide/
- Cloudflare RealtimeKit pricing:
  https://developers.cloudflare.com/realtime/realtimekit/pricing/
- PostgreSQL `SKIP LOCKED` queue behavior:
  https://www.postgresql.org/docs/18/sql-select.html
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
