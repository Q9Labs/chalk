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

## 2026-08-14: Production correlation and repair

- Browser history showed that the affected named route carried a broker invite capability. The production database then showed a two-Participant Episode in the broker's fixed Space one second later, while the named Dashboard Space had no lifecycle rows. The UI had silently joined a different Space.
- The same production Episode had a null authoritative start and a year-one diagnostic start. This independently confirms the lifecycle timestamp defect in deployed code.
- The repair removes broker invite capabilities from named Dashboard routes before entry, defaults Episode starts to the database transaction time, observes Dashboard-created Episodes after commit, and backfills both authoritative and diagnostic start timestamps.
- Focused web, service, repository integration, and migration repair proofs pass. The API gate passed. The full web suite passed with bounded concurrency (75 files, 380 tests, coverage, and production build); the canonical concurrent runner only hit unchanged timeout flakes under host load. The designated remote full gate could not start because that host had less than one gigabyte free and Go compilation exhausted it; the isolated checkout was removed.
- Review narrowed the browser guard to marked Dashboard links so public invite links still work. The migration's irreversible `Down` now fails explicitly; an isolated database reached the new version and refused rollback without changing migration history.
