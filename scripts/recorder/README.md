# Recorder archive releases

Release builds role archives on a GitHub Ubuntu 24.04 runner. Capture contains static Go binaries. Render carries pinned Node and relocated native renderer modules. FFmpeg, fonts, libraries and service accounts come from the unchanged base snapshot, so no package installation or compilation runs during node boot.

Archives use `recorder/<role>/<sha256>.tar.gz` keys in the environment's media artifact bucket; conditional upload and S3 SHA256 checks bind immutable bytes. The controller signs a GET with its host role for the startup timeout plus five minutes, and signing fails if the host credentials expire sooner. Cloud-init stages and checks the archive, switches `current`, then runs the existing bootstrap, with installed-file verification before any identity or control-plane contact. No AWS credentials are installed on the recorder.

Promote preserves held media JSON unchanged, copies the exact archives to the production artifact bucket and verifies their SHA256 again. It never rebuilds recorder payloads. Host roles need `s3:GetObject` on both recorder prefixes; CI needs source read and target write.

Base snapshots are a separately reviewed infrastructure operation; releases cannot create snapshots or builder droplets. The read-only `retain_runtime` command preserves the first promotion's legacy rollback pins, and only production rollback can restore those older pins. Signed-ready and the synthetic call remain the nightly qualification gate.

Before the first archive Release, set `CHALK_RECORDER_FLEET_IMAGE_ID` in each nightly recorder environment parameter to the approved existing base: `build_archives` reads that pin and never discovers or replaces a base implicitly. Set `CHALK_MEDIA_ARTIFACT_BUCKET` in both GitHub deployment environments before their first archive Release or Promote. Production's host also needs the same two-prefix read policy before its first Promote.

## Cost-first capture resource probe

`bash scripts/recorder/qualify-capture-local.sh` compiles the real capture bundler test binary and measures a compressed one-hour synthetic RTP stream (three Participants, six tracks, 4 Mbps, one Go CPU, 512 MiB Go memory target). It is a throughput and resource probe only: no SFU, codec, cloud SKU or render qualification, and the Go memory target is not an OS cap. Local evidence never enables a smaller candidate.

The [cost-first profile](../../infrastructure/recorder/profiles/cost-first.json) orders 1 GiB then 2 GiB shared-CPU candidates, with `c-2` as the baseline. An authorized cloud comparison must use the exact sealed image, run only the capture daemon, and record RSS, CPU, steal, ready latency, upload latency and bounded backlog for a paced hour, including camera and screen-share changes, reconnection, slow or retried uploads and independently verified artifacts. Measure ten-way `c-8` render completion separately against the one-hour objective, without shortening the eight-hour recovery bound. Keep raw artifacts private.

## Evidence labels

Recorder evidence must say which boundary it exercised:

- `deterministic-local`: local or fixture media, with no provider claim;
- `live-nonproduction-provider`: an explicitly non-production provider connection in which the recorder received real media packets;
- `production-runtime-qualified`: the deployed runtime and selected encoder were measured under the stated capacity. Local hardware results never satisfy this label.

A provider connection without received media is connectivity evidence, not capture evidence. A fixture is never live-provider evidence.

## Evidence tools

- `source-fingerprint.mjs` hashes tracked and non-ignored untracked files, Git status and `HEAD` (hashes and counts, not paths). Run it right before each qualification command. During a multi-lane change, pass `--scope <path>` (repeatable) so unrelated edits do not invalidate the evidence.
- `analyze-media.mjs` verifies an MP4 with `ffprobe` (streams, keyframes, dimensions, codecs, duration, A/V drift, faststart) and `--scan-anomalies` finds black, frozen and silent intervals. It exits nonzero when an assertion fails and omits the input path from its JSON.
- `compare-frames.mjs` compares decoded RGBA pixels, not PNG bytes. The default is exact equality; a nonzero threshold is rejected unless `--difference-explanation` says why.
- `measure-command.mjs` wraps a render or capture qualification and writes mode-0600 evidence JSON (wall and CPU time, peak RSS, exact command). Pass credentials through the environment, never arguments, because arguments are evidence.

Each tool documents its flags in its own usage errors.

## Live non-production runner contract

A live-provider qualification must:

1. require an explicit non-production flag and reject a production environment;
2. load secrets at process launch without logging or writing them to the evidence directory;
3. use at most three synthetic publishers and one recorder for at most 120 seconds per case;
4. record the source fingerprint, tool versions, exact command, elapsed time, artifact checksums and bounded media facts;
5. close every provider connection and stop every spawned process, including on failure;
6. keep raw evidence in a mode-0600 uniquely named temporary directory outside the repository, then publish only a redacted summary.

Provider sessions, paid compute, buckets and deployments are separate external effects. The qualification flag authorizes only the bounded non-production provider-connection case, not provisioning or deployment.

## Managed image release

[Release, Nightly and Promote](../../docs/managed-release.md) own builds, pin publication, dispatcher deployment and rollback. `release.py` is the pipeline's bounded image builder, not a separate deployment command; its plan works without existing image pins, API processes or dispatcher state. The pipeline runs static image inspection before deploy and cold signed-boot qualification afterwards.
