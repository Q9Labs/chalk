# Recording duration limits

Capture stops at its reserved deadline. Reaching that deadline is a normal stop:
Capture closes its provider connection, commits the encrypted tail and publishes
its stopped observation. The retained source remains available for Export until
its normal retention expiry. Export is requested separately; reaching the limit
does not automatically create an MP4.

The class (Episode) continues unless its own deadline or another end action ends
it. Capture does not end the Episode. An Episode deadline can coincide with the
Recording deadline; neither clock has a guaranteed execution order.

## Which deadline applies

- API Spaces: automatic and on-demand Recordings reserve the Episode's remaining
  lifetime at Recording start, capped at four hours. Starting on demand late in an
  Episode gives a shorter Recording. An earlier manual stop ends Capture sooner.
- Public Spaces created through the public flow have a one-hour lifecycle. Their
  Recording reservation is also bounded by the Episode's remaining lifetime and
  the four-hour Capture ceiling. Joining or starting Capture late does not reset
  the public Space lifecycle.
- Integrators set `default_episode_duration_seconds` and
  `maximum_episode_duration_seconds` on the Space, and may set or extend an
  Episode deadline through the API. Space settings are snapshotted into each
  Episode; changing the Space does not change an active Episode. A Recording's
  reservation deadline is sealed separately. Extending an Episode does not
  extend an already-started Recording. There is no public Recording duration
  override above the four-hour ceiling.

The API Space defaults are 24 hours for both Episode duration settings. These
are Episode limits, not a promise of 24 hours of Recording. The Space's
`recording_policy` decides whether a Recording starts at all: a Space created
without one gets `automatic`, so send `disabled` or `manual` if that is not
what you want.

## Detecting a duration stop

Read the Recording (`GET /v1/tenants/{tenant_id}/recordings/{recording_id}` or the
Recording list). `source.stop_reason` is `"duration_limit"` when Capture stopped
at its reserved deadline. The field is absent for other stops and legacy
Recordings whose stop reason was not retained. It remains visible after source
expiry or a failed Export; source availability and Export status are separate.
The marker is committed with the fenced stopped observation, so it is not set
by an unrelated job timeout or a failed Capture.

```json
{
  "source": {
    "status": "available",
    "stop_reason": "duration_limit",
    "expires_at": "2030-01-02T12:00:00Z"
  },
  "export": { "status": "none", "retryable": false }
}
```

## Four-hour capacity and budgets

These are sizing estimates, not a four-hour hardware qualification. A Recording
still reserves the Episode's remaining lifetime; the ceiling does not extend an
Episode or an existing reservation.

- At an assumed aggregate 0.4 MB/s, four hours produces 5.76 GB (5.36 GiB)
  of source, versus 2.88 GB for two hours. At the admitted 4 Mbps aggregate
  payload ceiling, the payload is 7.2 GB (6.71 GiB), before bundle overhead.
- Capture uses one Recording per node. The checked-in c-2 profile has 25 GiB
  of disk. Capture assembles bounded bundles in memory and uploads them as it
  runs; it does not spool the full Recording to node disk. Bundles target ten
  seconds and cap payload at 7.5 MB each. A slow or failed upload fails Capture
  rather than building an unbounded local backlog. No Capture disk increase is
  needed for this duration change.
- Ten-second bundles give about 1,440 bundles for four hours. The decoder accepts
  2,048 files and 16 GiB of input, and bounds decoded output at 32 GiB. Render
  admission accepts 64 GiB of total input and a 32 GiB MP4. These bounds stay
  unchanged; payload estimates do not prove peak render disk usage.
- The render budget is seven times the maximum Recording duration, including
  staging and retries: 14 hours becomes 28 hours. The existing qualified fixture
  comment reports about 5.9 times media duration, which projects to 23.6 hours
  for four hours. This is not a measured four-hour render time or a performance
  guarantee. Job claims and recovery share that absolute budget.
- Production render object transfers have no whole-body 30-second timeout;
  their 30-second timeout is for response headers. Signed grants last ten
  minutes by default (at most thirty). A 7.2 GB object needs about 96 Mbps to
  transfer within ten minutes, excluding overhead. Capture uploads individual
  bundles, not the whole four-hour source. No duration-wide upload timeout needs
  widening; network throughput still determines whether a grant suffices.
- Transcription preparation splits microphone audio into five-minute chunks:
  four hours needs forty-eight chunks per continuous microphone track, rather
  than twenty-four. Provider admission separately allows up to fifteen minutes. The dispatcher processes chunks independently. Its default provider
  timeout is ninety seconds, capped at 120 seconds; the worker lease is fifteen
  minutes. Longer Recordings add chunks, not larger provider requests. The
  4,096-chunk manifest bound remains unchanged.

Runtime rollback must retain the widened database bounds. Do not roll back the
migration while longer reservations or artifacts remain: its down step validates
the restored two-hour bounds and fails atomically if any row exceeds them.
Reverting the code restores the two-hour
ceiling for new Recordings. In-flight four-hour Recordings retain their sealed
deadlines, but old validators can reject their authority or exports above two
hours. Finish or stop those Recordings and finish their exports before rollback.

## Processing duration authority

Go admission, decode, render requests, render commits, and MP4 artifact validation
all use `recordingpipeline.MaximumRecordingDuration`. Video Export and microphone
preparation both call the same decoder with the whole Recording clock. Audio
preparation then walks the decoded source spans and applies the independent
five-minute chunk policy, not a second whole-Recording ceiling. Transcription
manifests bound chunks by the Recording clock and their chunk policy; they have
no two-hour cutoff. Sync and the renderer each retain one constant for their own
language layer; database CHECKs use the corresponding seconds and milliseconds.

The transcription source lease's two-hour expiry grace is a processing lease
window after source retention expires, not a media-duration limit. It does not
truncate four-hour Recordings or change their chunk lengths.
