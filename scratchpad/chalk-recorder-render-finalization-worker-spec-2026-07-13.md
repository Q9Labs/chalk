# Chalk Recorder Render and Finalization Worker Spec

Status: Draft companion to `scratchpad/chalk-recorder-pipeline-spec-2026-07-12.md`.

Parent: `scratchpad/chalk-recorder-control-plane-spec-2026-07-13.md`.

Inputs: `scratchpad/chalk-recorder-cloudflare-capture-worker-spec-2026-07-13.md` and `scratchpad/chalk-transcription-spec-2026-07-12.md`.

Owner: Hasan Shoaib

## Purpose and boundary

This spec defines the scale-to-zero GPU worker that consumes one reconciled encrypted capture manifest, deterministically composes Chalk's accepted stage view, verifies and conditionally uploads the final MP4, seeds the speaker-turn transcription source, and reports one fenced terminal result.

The worker does not join a live meeting, choose layout policy, infer speakers acoustically, call an ASR provider, mutate PostgreSQL, choose object ownership, or retain plaintext media after bounded drain. The control plane owns assignment, keys, object intents, job transitions, final authorization, transcription dispatch, and cleanup authority.

## Runtime and release contract

Render runs on scale-to-zero DigitalOcean TOR1 RTX 4000 GPU Droplets. The release is digest-addressed and pins the OS image, NVIDIA driver, CUDA/runtime compatibility, GStreamer and FFmpeg builds, plugins, fonts, compositor implementation, schema compatibility, and verification tools.

The production path uses hardware decode and encode. CPU software encode is permitted only in deterministic local fixtures and cannot qualify staging capacity. Chromium and the Chalk web UI are prohibited.

The node root is stateless and outbound-only. Input plaintext, decoded frames, audio PCM, keys, and intermediate output live only in bounded memory or encrypted/ephemeral scratch that is removed before node drain. Snapshots, crash dumps, logs, telemetry, and image layers contain no media or key material.

## Assignment contract

The worker claims through the private mTLS control listener and receives one immutable render assignment containing:

- protocol, release, job, tenant, session, recording, attempt, fence, lease, journey, and trace identity;
- capture-manifest schema and checksum, ordered bundle facts, explicit gaps, track epochs, media-clock mapping, and pinned layout/VAD/overlap policy versions;
- method-, key-, expiry-, and size-scoped read intents for every encrypted input;
- bounded recording-key authority delivered over the job-scoped mTLS channel without KMS credentials;
- one conditional-create final-output intent and scoped intents for the speaker-turn manifest and transcription chunks;
- output codec, resolution, frame rate, bitrate, audio, metadata, font, and compositor release contract;
- capture completion time, artifact deadline, sub-budget timestamps, render-schedule generation, qualified service-time version, retry allowance, cleanup requirements, and expected resource reporting.

The assignment is rejected before input transfer if bundle sequences overlap, required ranges are unresolved, policy versions are unsupported, the deadline cannot fit the schedule generation and qualified service-time model, URLs or key authority expire too early, or the worker release is incompatible. If the schedule becomes stale after claim, the worker preserves its already admitted attempt while the reconciler closes new admission and recomputes unclaimed work; it does not abandon a valid in-flight render merely because later work arrived.

## Input verification and decryption

Before rendering, the worker verifies the capture-manifest checksum and every bundle's recording, attempt, fence, sequence, object key, content type, byte size, checksum, encryption metadata, monotonic range, media range, codec/layer facts, and timeline range. It records explicit gaps and rejects unaccounted holes or overlaps.

Each encrypted bundle is fetched through its scoped URL, inspected against immutable facts, and decrypted in memory using the per-recording data key. Authentication failure, unexpected object facts, expired authority, or unsupported codec fails the attempt without writing a final artifact. The worker never obtains an AWS KMS credential or reusable R2 credential.

Input opening and transfer are part of the measured render service time. Scratch is bounded per job and cannot consume another job's reserve. A node admits only the assignments included in the control plane's discrete schedule.

## Deterministic composition

The renderer replays the recorded timeline; it does not recalculate active speaker, screen-share priority, strip order, names, or track ownership from current meeting state. Screen share occupies the primary stage when the timeline says it is dominant. Otherwise the recorded active speaker is primary. The strip contains at most six non-primary participants in recorded order with authorization-time labels.

Simultaneous and missing-source behavior follows the pinned policy. Explicit gaps produce visible discontinuity or the ratified neutral treatment; frames and speech are never invented to hide missing capture. Repeating the same release against the same verified manifest must produce identical layout decisions, speaker-turn manifest, chunk boundaries, chunk bytes, and meeting-time mapping. MP4 byte-for-byte identity is not required because container metadata may differ, but canonical ffprobe facts, frame/layout decisions, duration, codec profile, and media checksums over normalized decoded samples must match.

The compositor uses a pinned GPU graph. The proposed launch path is GStreamer for timeline-driven decode, composition, audio mixing, and NVIDIA acceleration, followed by FFmpeg/ffprobe-compatible container verification. Exact tool choice remains an open decision below, but staging qualification must exercise the hardware path actually shipped.

## Final artifact contract

The launch artifact is:

- MP4 with H.264 video and AAC-LC audio;
- 1280×720 at 30 frames per second;
- 2 Mbps target and 3 Mbps maximum video bitrate;
- 128 kbps mixed audio;
- seekable metadata and verified playable duration;
- no invented frames across capture gaps.

The worker writes to the exact conditional-create intent. It closes and flushes the container, then verifies codec, dimensions, frame rate, bitrate bounds, audio codec/rate, seekability, duration against the reconciled media timeline, byte size, checksum, and object inspection. Only verified facts are reported. The control plane performs the idempotent final-key commit and recording-state transition.

The final artifact must be authorized and committed within thirty minutes after capture ends. The budget reserves at most three minutes for readiness and assignment, twenty minutes for transfer plus first-pass rendering, four minutes for upload/verification/authorization, and three minutes for bounded recovery. Missing a sub-budget or final deadline remains visible, preserves encrypted inputs within retention, closes new admission when capacity is unqualified, and never borrows from cleanup time.

## Speaker-turn and transcription handoff

The same render attempt decodes retained Opus tracks once and emits:

- one immutable, versioned speaker-turn manifest;
- bounded mono 16-kHz MP3 chunks for transcription;
- participant and authenticated track ownership, track class and epoch;
- chunk checksum, bytes, storage key, codec, language-independent timing, and source ranges;
- mapping from chunk-local time to meeting time;
- non-overlapping speech intervals emitted once from their owning track;
- overlapping intervals emitted once per audible participant;
- versioned context, silence, VAD, and chunk-duration rules.

The renderer never sends audio to an ASR provider and never produces full-duration chunks for every participant. It conditionally uploads the manifest and chunks through scoped intents, verifies their immutable facts, and calls one private transactional finalization operation. That operation commits the recording artifact, inserts the complete transcription source and chunk set, and creates one fenced transcription job per chunk. Partial source seeding is rejected or rolled back.

A transcription failure never changes committed recording availability or integrity.

## Lease, progress, retry, and recovery

The worker heartbeats and reports bounded phases: assignment accepted, inputs opening, inputs verified, render started, render progress, upload started, verification started, transcription source ready, and terminal result. Progress cannot change the deadline or authority envelope.

Lease renewal is compare-and-set on job, attempt, fence, owner, and token. Loss of lease or certificate stops new reads and writes after bounded drain. A retry receives a new attempt and fence, re-verifies all immutable inputs, and uses new conditional output intents. The prior attempt cannot overwrite or commit the new attempt's output.

Render defaults to three attempts. Retryable failures include qualified transient provider, node, transfer, and hardware faults while deadline and retention reserve remain. Unsupported schema, corrupt or unauthenticated input, impossible manifest, expired retention, or exhausted attempts becomes terminal failure. A missed thirty-minute objective may retry only while the twenty-four-hour encrypted-input window remains; by hour twenty-three the control plane commits or terminally fails and schedules deletion.

## Scaling and qualification model

Each recording is one non-preemptive job. The control plane assigns jobs by earliest deadline and finds the smallest node count at or below ten whose qualified service-time bins fit every remaining input-and-render budget. The worker reports measured input-open, transfer, decode, composition, encode, upload, verification, and total service time plus bounded GPU/CPU/memory/scratch/network use.

The 20-two-hour ending burst must prove at least a 15× media-processing factor, no qualified two-hour job over ten minutes including measured overhead, at most ten GPU nodes, and every artifact committed within thirty minutes. A lower factor or deadline miss fails qualification and closes production recording admission.

## Cleanup, security, and observability

After verified finalization or terminal failure, the worker clears plaintext keys, closes URLs and connections, removes scratch and partial output, reports cleanup facts, and becomes drainable. Capture bundles and wrapped key material delete within one hour of verified recording finalization. Transcription chunks delete within one hour after the normalized transcript commits. R2 lifecycle is the twenty-four-hour orphan backstop for both classes.

Journey and W3C trace context link claim, input verification, render phases, object operations, transcription seeding, terminal report, and cleanup. Metrics cover queue delay, deadline reserve, input bytes/time, per-phase duration, processing factor, GPU utilization/memory, CPU/memory/scratch, retries, gaps, output facts, verification, source/chunk counts, cleanup, and terminal reason with bounded labels.

Logs contain no media, labels, transcript text, plaintext keys, object URLs, certificate material, full object keys, SDP, or unbounded tool/provider output. FFmpeg/GStreamer stderr is mapped to bounded redacted codes before logging.

## Implementation phases and ownership

- [ ] **R0 — Contract freeze:** assignment, schedule generation, capture manifest, layout timeline, key authority, final object, speaker-turn manifest, chunk set, terminal result, one-job-per-chunk finalization transaction, compositor toolchain, driver/runtime versions, fonts, and RAM/GPU/scratch ceilings are ratified.
- [ ] **R1 — Verified input reader:** scoped download, immutable inspection, AES-GCM memory decryption, ordered manifest reconstruction, gap checks, and unsupported/corrupt input failures pass.
- [ ] **R2 — Deterministic compositor:** pinned timeline replay, stage/strip/labels/audio, gap treatment, and fixture determinism pass without Chromium.
- [ ] **R3 — GPU production executor:** the current fixture-only/provider-unimplemented path is replaced by a digest-pinned RTX4000 image; hardware decode/encode, resource bounds, cancellation, drain, and failure classification pass on one staging node.
- [ ] **R4 — Artifact and transcription finalization:** conditional uploads, media verification, one artifact commit, complete source/chunk transaction, one transcription job, retry idempotency, and cleanup pass.
- [ ] **R5 — Deadline and recovery:** node loss, lease loss, stale fence, upload conflict, retry, terminal failure, and hour-one/hour-twenty-four cleanup pass with observability.
- [ ] **R6 — Launch qualification:** the twenty-job ending-together workload meets processing, node-count, sub-budget, and thirty-minute gates on the shipped release.

The main thread owns shared schemas, database transactions, integration, and final verification. Capture may proceed in parallel after R0 freezes the manifest handoff. GPU implementation waits for a real R1 input reader and checked-in manifests; staging qualification waits for R0–R5.

## Done and stopping point

This seam is locally done when R0–R5 pass and one real capture manifest becomes a verified committed MP4 plus a complete accepted transcription source without direct database, KMS, or reusable R2 credentials. It is staging-qualified only when R6 passes at the ratified ceiling with failure, cleanup, security, cost, and observability evidence.

Work stops before ASR execution, production activation, gallery re-edits, acoustic diarization, unbounded retention, or a browser-based compositor.

## Open questions

1. Should the production compositor be GStreamer-first with FFmpeg/ffprobe verification, or an FFmpeg filter graph with NVDEC/NVENC throughout?
2. What exact per-job RAM, GPU memory, and scratch limits should qualification enforce on the RTX 4000 Droplet?
3. Which font family and fallback set are part of the immutable stage-label rendering contract?
