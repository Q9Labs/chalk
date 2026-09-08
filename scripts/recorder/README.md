# Recorder qualification tools

Recorder evidence must say which boundary it exercised. Use these labels in
summaries:

- `deterministic-local`: local or fixture media, with no provider claim;
- `live-nonproduction-provider`: an explicitly non-production provider connection
  in which the recorder received real media packets;
- `production-runtime-qualified`: the deployed runtime and selected encoder were
  measured under the stated capacity. Local hardware results never satisfy this
  label.

Creating a provider connection without receiving media is connectivity evidence,
not capture evidence. A fixture is never live-provider evidence.

## Exact source

Capture a source fingerprint immediately before each qualification command:

```bash
node scripts/recorder/source-fingerprint.mjs > /private/tmp/recording-source.json
```

The fingerprint covers tracked and non-ignored untracked files, the current Git
status, and the current `HEAD`. It emits hashes and counts rather than paths. A
run with unresolved Git paths exits nonzero.

During an active multi-lane change, fingerprint only the inputs to a focused
check before and after it. Unrelated edits elsewhere then do not invalidate the
evidence:

```bash
node scripts/recorder/source-fingerprint.mjs \
  --scope apps/api/internal/adapters/pion \
  --scope apps/api/go.mod \
  --scope apps/api/go.sum
```

## Media evidence

`analyze-media.mjs` uses `ffprobe` to verify stream presence, packet timestamps,
keyframes, expected dimensions/codecs/frame rate, duration, A/V drift, and MP4
faststart placement. `--scan-anomalies` also decodes the media with FFmpeg and
reports black, frozen, and silent intervals.

```bash
node scripts/recorder/analyze-media.mjs \
  --input /private/tmp/recording.mp4 \
  --expect-width 1280 \
  --expect-height 720 \
  --expect-fps 30 \
  --expect-video-codec h264 \
  --expect-audio-codec aac \
  --expect-duration-ms 10000 \
  --duration-tolerance-ms 250 \
  --max-av-start-drift-ms 100 \
  --max-av-end-drift-ms 250 \
  --require-faststart \
  --scan-anomalies
```

The command prints `recording-media-evidence.v1` JSON and exits nonzero when an
assertion fails. It emits the artifact checksum and media facts, but not the
input path.

## Frame parity

Compare decoded RGBA pixels rather than PNG container bytes:

```bash
node scripts/recorder/compare-frames.mjs \
  --expected /private/tmp/live-frame.png \
  --actual /private/tmp/recorded-frame.png \
  --expect-width 1280 \
  --expect-height 720 \
  --diff-output /private/tmp/frame-difference.png
```

The default is exact equality. A nonzero changed-pixel or mean-error threshold
is rejected unless `--difference-explanation` records why the difference is
expected. The JSON evidence contains decoded-pixel hashes, difference bounds,
and error metrics without input paths.

## Resource evidence

Wrap a render or capture qualification with `measure-command.mjs`. The wrapper
preserves the command's exit status and writes mode-`0600`
`recording-command-evidence.v1` JSON with wall time, CPU time, peak RSS, context
switches, runtime architecture, and the exact command. Pass credentials through
the environment, never command arguments, because arguments are evidence.

```bash
node scripts/recorder/measure-command.mjs \
  --evidence /private/tmp/render-resources.json \
  --label deterministic-local \
  -- go run ./apps/api/cmd/recorder-render --fixture --dir /private/tmp/render
```

## Live non-production runner contract

A live-provider qualification must:

1. require an explicit non-production flag and reject a production environment;
2. load secrets at process launch without logging or writing them to the evidence
   directory;
3. use at most three synthetic publishers and one recorder for at most 120
   seconds per case;
4. record the source fingerprint, tool versions, exact command, elapsed time,
   artifact checksums, and bounded media facts;
5. close every provider connection and stop every spawned process, including on
   failure;
6. keep raw evidence in a mode-`0600` uniquely named temporary directory outside
   the repository, then publish only a redacted summary.

Provider sessions, paid compute, buckets, and deployments are separate external
effects. The qualification flag authorizes only the bounded non-production
provider-connection case; it does not authorize provisioning or deployment.
