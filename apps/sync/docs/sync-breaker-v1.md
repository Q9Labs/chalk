# SyncEngine v1 deterministic breaker

The v1 breaker is a bounded, seeded PostgreSQL 18 campaign with four executable phases:

- durable commands, lifecycle work, transaction faults, authority-lock races, deadlines, and an
  independent full-log oracle;
- external-operation reservation/finalization, provider ambiguity, confirmation crashes,
  recording, role cleanup, screen leases, monotonic observations, and adapter restart;
- real `/v1/sync` delivery schedules for ACK/event order, dropped hints, reconnect, Coordinator
  loss, exact-next live frames, and duplicates;
- strict wire decoding plus the production TypeScript replica's optimistic rebase, duplicate
  evidence, projection-gap recovery, and persisted-target restart.

Every checksummed artifact contains the seed, Git revision, contract version, sanitized
PostgreSQL/phase configuration, all 37 executed schedules, actual receipts and digest chain, folded
snapshot, intent states, provider-neutral projection, and bounded evidence. It contains no database
URL, credential, runtime process identity, or wall-clock duration.

Run it against an isolated migrated database in the test environment:

```bash
MIX_ENV=test CHALK_SYNC_TEST_DATABASE_URL="$URL" mix sync.breaker.v1 --output /tmp/v1.json
MIX_ENV=test CHALK_SYNC_TEST_DATABASE_URL="$URL" mix sync.breaker.v1 --replay /tmp/v1.json
```

Replay first verifies the artifact checksum and one MiB size bound. It then executes the complete
campaign twice with isolated database identities and cleanup, and requires both fresh semantic
projections to equal the recorded projection exactly. A changed receipt, intent state, digest,
folded snapshot, provider projection, phase observation, bound, or verdict fails replay.
