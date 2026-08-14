# Missing Episode investigation

## 2026-08-14: Code-path diagnosis

- Dashboard entry calls the account-bound `participants/self` endpoint. That endpoint creates the Episode before it returns access.
- The database transaction is atomic. A successful join response implies an `episodes` row unless the browser and dashboard are reading different tenants or deployments.
- Dashboard auto-start leaves `episodes.started_at` null.
- This path bypasses the Episode commit observer. The periodic diagnostics backfill also filters out null `started_at` rows, so no `episode_diagnostics` root is created.
- If an enabled `episode.started` webhook target exists, webhook encoding rejects the null start time and rolls back the whole join transaction.
- Next proof step: distinguish the authoritative `episodes` row from the `episode_diagnostics` root for one affected Space and time window, then correlate the journey ID through the account boundary and API telemetry.

## 2026-08-14: Verification and observability gap

- Focused webhook, Episode diagnostics runtime, and dashboard join HTTP tests pass. Existing webhook tests confirm that a missing start time is rejected, but no PostgreSQL dashboard-join integration test covers the combined path.
- Production diagnostics cannot discover an Episode by Space and time. It needs an Episode, journey, request, command, or trace identifier first.
- Root creation, reconcile health, queue drops, projector lag, and dead letters lack durable health signals. This makes the missing-root failure quiet even though the diagnostic system is meant to explain lifecycle gaps.
