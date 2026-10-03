# Episode diagnostics tooling

## Cross-tool trace briefs

`pnpm diag check --prod` checks the Episode command source and Axiom trace
and API-log datasets. An operator can load the read-only Axiom query credential
with `export AXIOM_QUERY_TOKEN=$(op read "op://dev/Axiom MCP API token/credential")`.
Never commit or paste the token into config, fixtures, or reports. Production
Episode operator configuration is also needed for the command source.

`pnpm diag trace <32-hex-trace-id> --prod --json` joins retained Episode events
with Go/Elixir spans and redacted API log lines. The
`recording.provider.callback` flow in `diagnostics/flows.json` follows the four
required checkpoints in the shared contract. Its fixture's 2/3/4/5-second
deadlines become a 2-second initial window and three 1-second dependent
windows. The first window starts at the first visible flow event, so it cannot
independently identify a late first checkpoint. The catalog has no conditional
or best-effort checkpoints for this action. Success and failure are branch
outcomes on the authorized-branch and provider-result steps.

The command adapter uses the Episode diagnostic ID as `flow_run` and resolves
`run <flowRun>` through the operator-authorized Episode event pages. Events
without a valid W3C trace/span pair cannot be represented in a q9 diagnostic
event and are omitted from that lookup.

This private package owns the bounded `trace:inspect` resolver, deterministic
local fixture server, and desktop visual proof harness for Chalk Episode
Diagnostics. It does not mount an API route or enable any production worker.

For a plain W3C trace ID, run `pnpm diag trace <32-hex-trace-id>` for a bounded
`DiagnosticTraceBrief/v1` (or add `--json`). Use `pnpm trace:inspect` with a
`chalkdiag:v1` reference when investigating full retained Episode evidence,
including cursor pages and debugger views. Both commands use the same
operator-authorized API configuration; a trace ID alone never grants access.

```sh
pnpm --dir tools/episode-diagnostics trace:inspect \
  'chalkdiag:v1:localhost:fixture-stalled' --format agent
```

Operator credentials are read from the diagnostics-only environment variable
`CHALK_EPISODE_DIAGNOSTICS_OPERATOR_TOKEN`, the explicit diagnostics credential
variables, or the private local file
`.private/chalk-dev/episode-diagnostics-operator.json`. Credentials are never
included in resolver output or errors.

The browser proof requires a real debugger route supplied by the caller. It
never starts the static API fixture as a UI target, and localhost mode rejects
non-loopback URLs:

```sh
node tools/episode-diagnostics/src/browser-proof.mjs \
  'http://127.0.0.1:3070/developer/episode-diagnostics/{reference}' \
  .private/chalk-dev/episode-diagnostics-proofs/latest
```

The `{reference}` placeholder is resolved once per named fixture state; a
fixed URL is rejected so every capture cannot silently show the same state.
For an exact deterministic local run, use the supervisor; it starts the API
fixture and the real `apps/web` Vite process on unique loopback ports, injects
the matching operator token only into Vite's Node proxy, waits for the web
origin, runs the matrix, and verifies both listeners are gone on success or
failure:

```sh
pnpm --dir tools/episode-diagnostics browser-proof:local
```

The browser matrix claims only live, reconnecting, stalled, ended, error,
failed, export, and disconnected states. Loading, empty, export-in-progress,
export-failed, and permission-denied remain API/component fixtures until a
real route proof exercises each state end to end. The fixture server is an API
dependency for the product page, never the browser-proof target itself.

The proof checks the product-owned debugger root, seven view controls, copy and
export actions, recovery and visibility-gap markers, fixed clock/font/data
readiness, and basic accessibility at 1440, 1280, and 1024 CSS pixels.

## Feedback operator commands

The same private operator credential and environment checks power Feedback
retrieval. The root aliases are `pnpm feedback ...` and
`pnpm --dir tools/episode-diagnostics feedback ...`:

```sh
pnpm feedback list --category bug --source chalk_web
pnpm feedback show <feedback-id>
pnpm feedback pull <feedback-id> --output .private/feedback/<feedback-id>
pnpm feedback open <feedback-id>
```

`pull` verifies bounded evidence and screenshot bytes against their SHA-256
headers before atomically writing a new directory. `open` uses the strongest
validated correlation and only configured Chalk observability hosts; set
`CHALK_FEEDBACK_OBSERVABILITY_URL` and
`CHALK_FEEDBACK_OBSERVABILITY_HOSTS` when the debugger is hosted separately
from the API origin. Use `--no-launch` to print the safe URL and command.
