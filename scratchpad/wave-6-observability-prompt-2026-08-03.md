# Wave 6 prompt — observability

You are executing wave 6 of the Chalk vocabulary-and-boundary restructure.
This prompt is self-contained; assume no other conversation context.
May run in parallel with wave 5 (infra/broker) — surfaces are disjoint;
if you find a file both waves would touch, stop and flag it instead of
racing.

## Mission

Make the telemetry speak the platform's language: spans, metrics,
dashboards, alerts, and digests named for Spaces and Episodes, so an
on-call reader and the glossary describe the same system.

## Read first (binding, not open for redesign)

- `GLOSSARY.md` — vocabulary, naming grammar (span names are names too:
  "names go all the way down").

## Blocked on (verify before starting)

- Waves 1–3 merged (the code paths being traced carry their final names;
  renaming telemetry before its subject just renames it twice).

## Scope

- `infrastructure/observability`: trace/span names, attributes, e2e
  checks, alert definitions, dashboard queries — room/session/meeting
  vocabulary → Space/Episode/Participant.
- `infrastructure/uptime-worker`: probe names and reported identifiers.
- In-service telemetry naming: the Elixir sync observability module and
  emitted span/event names, Go API telemetry, SDK join-trace naming
  (the "trace Chalk session joins" instrumentation becomes
  Episode/Space-named).
- Digest and artifact names owned by observability tooling. The durable
  sync state digest is already `chalk-sync-state-v1` — do not touch
  protocol or state versioning.
- Alert copy and runbook text in-repo follow the vocabulary.

## Definition of done

- Commit gate green; observability + uptime tests pass; sync + API test
  suites still green (telemetry renames touch their emit sites).
- Ratchet counts fall for the observability surfaces; baseline staged
  in the same commit.
- No banned terms remain in span names, metric names, dashboards,
  alerts, or probe identifiers.
- Renamed span/metric names that dashboards or alerts query externally
  (Grafana, provider-side alert rules) are enumerated in the final
  report so Hasan can update the hosted side in step.

## Environment notes

- Before typechecks or the gate, build the library chain sequentially or
  `packages/ui` fails on missing dists:
  `pnpm --filter '@q9labsai/chalk-assets...' --filter '@q9labsai/facehash...' --filter '@q9labsai/chalk-ui...' --filter '@q9labsai/chalk-whiteboard...' --filter '@q9labsai/chalk-client...' --filter '@q9labsai/chalk-react...' --filter '@q9labsai/chalk-react-native...' --workspace-concurrency=1 run build`
- Keep `--workspace-concurrency=1` on workspace-wide builds.
- `pnpm run gate -- --full` is red for pre-existing, unrelated reasons;
  the per-commit gate is the standard.
- Keep `.worktrees/` clean; gate vitest filters match stale copies.
