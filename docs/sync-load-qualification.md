# Local Sync restart and queued-chat qualification

The October 3 follow-up reuses the October 1 LOAD lane's TypeScript Sync client,
WebSocket adapter, and durable chat page reader. It targets two missing checks:
a second Sync process restart in the same active Episode, and delivery of chat
submitted during each outage. This is a local qualification, not a production
capacity or database failover qualification.

## Method

- Run 25 TypeScript Sync clients in one seeded Episode against a disposable,
  migrated PostgreSQL 18 database on the M4.
- Use the repository's local Sync process entrypoint and existing Postgres test
  fixtures. Local development tokens remain valid throughout the run; API grant
  renewal, browser UI, and media are outside this check.
- Send 250 messages, kill the Sync process group, wait for every client to leave
  the live state, and submit five messages per client while Sync is absent.
- Hold those 125 messages using the SDK's existing offline-action controller,
  assert none was acknowledged before restart, then start a fresh Sync process
  against the same database and port. Keep the original client instances.
- Verify every client reads every expected message exactly once and every offline
  queue empties. Send another 250 messages and repeat the kill, queue, and restart.
- Send a final 250 messages. Compare message IDs in durable database rows with
  every submitted ID, including all acknowledged messages from before each kill.

Ordinary traffic is bounded to one awaited send every 100 ms, with durable page
reads between batches. Recovery still drains all 25 clients' real offline queues
concurrently. Counts distinguish unique messages from per-client deliveries.

## Results — October 3, 2026

Tested source: `7ec33f5e0`. All 25 clients recovered after both process kills.
All 1,000 submitted messages were acknowledged, all 25 clients observed every
message once (25,000 deliveries), and the database contained exactly the 1,000
expected message IDs: zero missing, duplicate, or unexpected rows.

| Measurement                                  | First restart | Second restart |
| -------------------------------------------- | ------------: | -------------: |
| Messages acknowledged before kill            |           250 |            625 |
| Messages queued while Sync was down          |           125 |            125 |
| Clients recovered                            |         25/25 |          25/25 |
| Reconnect minimum                            |       4.113 s |        2.984 s |
| Reconnect p50                                |       4.500 s |        3.511 s |
| Reconnect p95                                |       6.007 s |        4.596 s |
| Reconnect maximum                            |       6.051 s |        4.687 s |
| Missing or duplicate messages after recovery |             0 |              0 |

Reconnect time starts at the process kill, including the intentional outage and
fresh process startup. Percentiles use the nearest-rank method over 25 clients.
The run reported no failed sends. Task-owned Sync processes and the disposable
database were stopped after verification.

## Scope

The original LOAD report's first restart recovered 21 lightweight clients in
5.714–8.408 seconds; its second restart was invalidated by expired grants and
its chat proof did not read durable pages. The recovered harness was adapted
for local fixtures and process restarts, without production access.

A preliminary simultaneous-send variant completed both restart checkpoints:
750 messages, including 250 outage submissions, reached all 25 clients exactly
once. A subsequent burst encountered explicit `dependency_unavailable` send
rejections and database queue timeouts. Those rejected submissions are not
counted as successful delivery. This qualification does not establish a
supported peak send rate or uninterrupted service under saturation.

The release reliability script currently references the absent
`test/chalk_sync/reliability/soak_profile_test.exs`; this manual measurement does
not imply the entire release profile passed. Production-like topology and
database recovery remain in `realtime_sync.failover_qualification`.
