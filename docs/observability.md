# Production observability

API request logs and Sync event spans export to Axiom. Use W3C trace IDs and
Space or Episode IDs to correlate them. The private
`observability_journey_events` table holds the durable correlation record for
webhook and recording lifecycles.

## Follow an incident

Start with the Space and Episode IDs from the affected class and the participant
ID when available. Keep the server error code and trace/request ID from a
failed join when locating the corresponding request.
Tenant-level requests do not have an Episode ID.

In the relevant Axiom API log or Sync trace dataset, run:

```apl
| search "<episode-id>"
```

Replace the placeholder with the affected Episode ID. Narrow by Tenant, Space,
participant or trace ID where those attributes are present. API/Sync exporters
remain enabled through their managed OTLP configuration; dataset names and tokens
are private deployment inputs, not repository constants.

When a Participant joined without a knock, check the journey root named
`participant.admission_requested` in `observability_journey_events`. A backend
that asked for direct admission leaves `"admission": "direct"` in its
attributes. Policy admissions carry no `admission` attribute.

## Alerts

Three Axiom monitors cover API errors and abnormal Sync drops, failed/overdue
recordings and transcripts or exhausted webhooks, and stale collector state.
The read-only collector and Discord message templates live in
[infrastructure/observability/production-alerts](../infrastructure/observability/production-alerts/README.md).
An independent uptime Worker checks API/Sync health and readiness and reports
failures directly to Discord.

### Sync lifecycle readiness evidence

When `/readyz` reports `lifecycle_intent_lag`, its cached dependency snapshot
retains the database observations from that failed probe. `database.lifecycle_intents`
reports pending, due, and retrying counts, plus the oldest pending intent's attempt
count and allowlisted error code (`other` for unknown codes; `null` before a failure).
The oldest pending age includes scheduled retries, not only work currently due.
Use these fields to distinguish undiscovered backlog from repeated delivery failures;
they do not establish the underlying cause of a `dependency_unavailable` result.
The response contains no intent, Episode, participant, or Tenant identifiers.
Readiness thresholds, retry scheduling, and the one-second query timeout are unchanged.

### Sync board-origin agreement

`view_origin_secret_mismatch` in readiness means two live Sync peers announced
different HMAC fingerprints. The error log names `local_fingerprint` and
`peer_fingerprint`, never either secret; compare the deployment's secret mounts.
`[:chalk_sync, :whiteboard, :origin_secret_mismatch]` counts one event per peer
fingerprint change, not per view. Announcements run every two seconds with a
six-second peer lease. Startup discovery, announcement loss and peer capacity
have distinct readiness reasons. A full per-Episode view clock records
`view_clock_capacity` through the same bounded `sync.whiteboard.view_origin_rejected`
trace/log path as invalid proofs and stale direct sequences.
