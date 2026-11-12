# Recording duration limits

A Recording stops at its reserved deadline. That is a normal stop: Capture
closes its provider connection, commits the encrypted tail and publishes its
stopped observation. The source stays available for Export until normal
retention ends. Reaching the limit does not create an MP4, and it does not end
the Episode. If both deadlines coincide, neither has a guaranteed order.

## Which deadline applies

- A Recording reserves the Episode's remaining lifetime when it starts, capped at
  four hours (`recordingpipeline.MaximumRecordingDuration`). Starting late gives
  a shorter Recording. The reservation is sealed at start, so extending the
  Episode later does not extend a running Recording. No public override exceeds
  the ceiling.
- Space settings (`default_episode_duration_seconds`,
  `maximum_episode_duration_seconds`) are snapshotted into each Episode. The 24
  hour defaults are Episode limits, not a promise of 24 hours of Recording.
- The Space's `recording_policy` decides whether a Recording starts. A Space
  created without one gets `automatic`.
- Public Spaces have a one-hour lifecycle, and joining late does not reset it.

## Detecting a duration stop

`source.stop_reason` on the Recording is `"duration_limit"` when Capture stopped
at its deadline. It is committed with the fenced stopped observation, so a job
timeout or a failed Capture never sets it. It is absent for other stops and for
legacy Recordings, and it stays after source expiry. Source availability and
Export status are separate.

## Sizing judgment

The four-hour limit rests on bounded memory, not on a hardware qualification.

- Capture keeps one Recording per node and uploads bounded bundles as it runs. A
  slow upload fails Capture rather than building a local backlog, so the node disk
  does not need to grow with duration.
- Render admission, decoder and MP4 bounds are fixed in the recording pipeline
  code. They are not measured peak disk use.
- Render time is budgeted at seven times the maximum duration, including staging
  and retries. The fixture runs near 5.9 times, so four hours is a projection,
  not a measurement.
- Transcription splits microphone audio into independent five-minute chunks, so
  longer Recordings add chunks, not larger provider requests. The transcription
  source lease's grace after retention expiry is a lease window, not a duration
  limit.
- A signed grant for a large source must outlast the transfer. Network throughput
  decides that, not a timeout in Chalk.

Every Go layer that checks duration (admission, decode, render request, render
commit, MP4 validation) uses the one pipeline constant. Sync and the renderer
each keep one constant for their language.

## Rollback

Keep the widened database bounds in a runtime rollback. The migration's down step
fails atomically if any row exceeds the old two-hour bounds. Reverting code
restores the old ceiling for new Recordings, but old validators can reject
in-flight four-hour authority or exports. Finish or stop those Recordings, and
finish their exports, before rolling back.
