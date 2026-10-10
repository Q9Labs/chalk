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
  lifetime at Recording start, capped at two hours. Starting on demand late in an
  Episode gives a shorter Recording. An earlier manual stop ends Capture sooner.
- Public Spaces created through the public flow have a one-hour lifecycle. Their
  Recording reservation is also bounded by the Episode's remaining lifetime and
  the two-hour Capture ceiling. Joining or starting Capture late does not reset
  the public Space lifecycle.
- Integrators set `default_episode_duration_seconds` and
  `maximum_episode_duration_seconds` on the Space, and may set or extend an
  Episode deadline through the API. Space settings are snapshotted into each
  Episode; changing the Space does not change an active Episode. A Recording's
  reservation deadline is sealed separately. Extending an Episode does not
  extend an already-started Recording. There is no public Recording duration
  override above the two-hour ceiling.

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

The existing Recording webhook is unchanged. An integrator can read the
Recording to inspect its source stop reason. This change preserves captured
media on future clean duration stops; it does not recover old terminal failures
or guarantee success when provider cleanup, storage or lease authority fails.
