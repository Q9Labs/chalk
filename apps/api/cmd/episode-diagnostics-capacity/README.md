# Episode Diagnostics capacity harness

This command drives the public Episode Diagnostics HTTP boundary. It never
opens Postgres directly, so the API can use a remote append/query database
without changing the harness. The default plan is a 1,000,000-Event dry run,
with 100 Participant scopes, 10 viewers, 200-event append batches, and eight
bounded append workers. Network execution is fail-closed: disabling dry run
requires `-acknowledge-execution`; mutations against a non-loopback URL also
require both `-allow-remote` and the separate `-allow-production` override.

Run a fast contract-only plan:

```sh
cd apps/api
go run ./cmd/episode-diagnostics-capacity \
  -dry-run -events 20 -participants 2 -viewers 0
```

Run against a local API with the static sync producer and operator credentials:

```sh
cd apps/api
go run ./cmd/episode-diagnostics-capacity \
  -base-url http://localhost:8080 \
  -dry-run=false -acknowledge-execution \
  -producer-token "$CHALK_EPISODE_DIAGNOSTICS_PRODUCER_TOKEN" \
  -operator-token "$CHALK_EPISODE_DIAGNOSTICS_OPERATOR_TOKEN" \
  -tenant-id "$TENANT_ID" -space-id "$SPACE_ID" -episode-id "$EPISODE_ID" \
  -events 10000 -participants 10 -viewers 2 -batch-size 200
```

The same values can be supplied with `CHALK_API_BASE_URL` and the
`CHALK_EPISODE_DIAGNOSTICS_*` environment variables. A supplied
`-reference` is used for reads; otherwise the first successful append response
provides the reference. Writes use the exact `AppendDiagnosticEventsRequest`
wire shape and the `sync` source, which means the configured static producer
credential must be accepted by the API and the three scope IDs must identify an
existing Episode Diagnostic.

The command's `-dry-run` flag defaults to true. To execute a local mutation,
pass `-dry-run=false -acknowledge-execution`; a remote target additionally
needs `-allow-remote -allow-production`. The equivalent environment variables
are `CHALK_EPISODE_DIAGNOSTICS_DRY_RUN`,
`CHALK_EPISODE_DIAGNOSTICS_ACKNOWLEDGE_EXECUTION`,
`CHALK_EPISODE_DIAGNOSTICS_ALLOW_REMOTE`, and
`CHALK_EPISODE_DIAGNOSTICS_ALLOW_PRODUCTION`.

The JSON report contains append, snapshot, page, and SSE connection latency
p50/p95/p99 values, runtime heap samples, accepted/duplicate/conflict/rejected
counts, attempted and accepted throughput, and cursor loss observed across reconnects. SSE reconnects
send both `after` and `Last-Event-ID`, and each stream has a deadline. Set
`-retention-wait` to probe the reference again after a bounded wait, or provide
an operator-only `-retention-probe-url`; the API has no force-expire route, so
the default report marks retention as `not_configured`.

The harness does not run the 1,000,000-event default during tests. Tests use a
small fixture server and `-dry-run` to keep local verification fast.
