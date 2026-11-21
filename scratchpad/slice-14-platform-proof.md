# Slice 14 — Platform: proof log

Branch: `obs/slice-14-platform`
Spec: `docs/plans/hyper-observability/slices/14-platform.md`

`diagnose platform <environment> <UTC date>` now judges a full UTC day of env
telemetry. Every fixture is the concatenation of its declared chain hand-offs:
real emitter output captured under pinned stamps (`event_id`, `est_server_ms`,
and wall-clock fields like `duration_ms`/`max_lock_wait_ms` re-stamped the same
way) plus a deterministic day fill, so each check sees one eligible subject with
complete coverage. Missing telemetry reports `unknown` (evidence gap), never a
false healthy.

Fault environment: isolated real Postgres via `scripts/gates/with-postgres.sh`
(migrations applied); the poller fault test drives the real
`postgres.RunHealthPoller`/`sampleOnce` against it. Host collector rows come
from the real production-alerts collector against a stub Axiom ingest; edge rows
from the real uptime-worker `collect`/`monitor` against a stub Cloudflare
GraphQL + ingest; markers from the real `release-marker.mjs` poster; request
rows from the real `http.go` request log against a live httptest server; boot
rows from the real `boot_facts.go` emitters.

## Checks

| Check | Fault run | Verdict | Named hop |
|---|---|---|---|
| `db.unreachable` | poller pointed at a closed port: `connect_failed` samples + collector `database-unreachable` rows agree for the same minutes | broken | `db_connect` |
| `db.pool_saturated` | real pool max=2, two conns held, third acquirer waits then cancels: 4 consecutive qualifying samples | broken | `db_pool` |
| `db.lock_wait` | session advisory lock held; a `chalk-api` backend blocks >5 s: 2 consecutive lock-wait samples naming the blocker | broken | `db_lock` |
| `flags.unrecorded_change` | second real boot on a different `flags_hash`; the day's only marker is an unrelated web deploy | broken | `config_boot` |
| `release.version_skew` | api marker deploys `2026.11.20-aaaaaaa`; api/sync service versions and request rows keep serving the old release past settle | broken | `release_rollout` |
| `release.failures_after_change` | two counted edge buckets of api 5xx inside the hour after a deploy marker; benign media-plane anchor stays quiet | broken | `release_change` (`api.release`) |
| same rule, restart path | surge contained inside the deploy span, one matching boot, quiet after | expected | `release.deploy_restart` |
| `edge.origin_unreachable` | two consecutive counted buckets at 78% origin-failure share + host `runtime-health` down + uptime checks failed | broken | `edge_origin` |
| `edge.asset_failures` | two consecutive asset buckets failing 11+ chunk requests each, 95 min after a web deploy | broken | `edge_asset` |

Healthy controls: all 8 healthy fixtures produce **no finding**, one eligible
subject, checked = eligible (asserted in `platform-chain.test.mjs`).

Fixture chains: `observability/fixtures/<code>/` for each of the 8 checks —
`chain/hops.json` (hop a: real emitter output, hop b: collector or reader
projection, hop c: assembly), `positive.json`, `healthy.json`.

## Gates and tests

- `node scripts/gates/obs-coverage.mjs`: exit 0 — all 8 `*.*` platform symptoms covered end to end; none on the allowlist.
- `node scripts/gates/obs-chain-replay.mjs <all 8 codes>`: replay writes byte-identical files.
- `pnpm run regen` + `node scripts/codegen/check-generated.mjs`: `check:generated passed: 14 checks`.
- `node --test scripts/diagnose-call/`: 230 pass.
- `node --test scripts/diagnose-call/proof/platform-chain.test.mjs`: 8/8 (findings asserted, healthy controls quiet).
- `scripts/gates/with-postgres.sh -- go -C apps/api test ./internal/adapters/postgres -run TestHealthPollerFaultChain`: pass (~7 s, real faults).
- `go -C apps/api test ./internal/observability -run TestHTTPFaultChain`, `./cmd -run BootFacts`: pass.
- `GOTOOLCHAIN=go1.26.11 go test ../../infrastructure/observability/production-alerts/collector*.go -run TestCollectorHealthChain` (from `apps/api`): pass.
- `node --test infrastructure/uptime-worker/edge.chain.test.mjs scripts/releases/release-marker.chain.test.mjs`: pass.
- `go -C apps/api build ./...`: clean.
- `pnpm exec vitest run src/obs/kernel.test.ts` (client SDK): 30/30, no type errors.
- `mix format --check-formatted lib/chalk_sync/application.ex`: parses clean (deps not fetched locally, so no full `mix compile`).

## Honest splits / renames

- `obs.flags_snapshot` stays the server-kernel event (the shared Go kernel is
  also linked by the SFU — it cannot honestly emit an `api.*`-named event).
  The TypeScript client emission is renamed to `client.flags_snapshot` (same
  precedent as `client.call_ended`), and the platform reader consumes both.
- Host collector rows keep their raw `chalk_alert_*` shape; `host.db_reachable`
  / `host.runtime_health` project `chalk_alert_value` at read time via
  `legacy.match` — the same projection the live adapter applies.
- `api.http_request` declares the fields the request logger really emits
  (`path`, `bytes`, `upstream_status`, `upstream_code`, `outcome`, …); raw log
  rows are projected to registry vocabulary at read time.

## Unproved / honest gaps

- `apps/sync` `application.ex` full compile unverified locally (Hex deps not
  fetched); syntax + format verified, full compile left to the Sync gate.
- Live `--env` runs against real Axiom need a real token; the adapter's
  projections (host alert rows -> claim fields, service-version and
  media-plane minting, read-failure gaps) are mirrored row-for-row by the
  fixture hand-offs the chains commit, but `platform-sources.mjs` itself has
  no dedicated unit test and no live production read was run in this slice.
- `end.wrong_screen` (slice 11) drifts under the unscoped
  `obs-chain-replay.mjs` (`client-frames.*.json` rewrite differently) — a
  pre-existing condition on `obs/foundation-int`, also noted in slice 11's
  own proof log; not touched by this slice.
