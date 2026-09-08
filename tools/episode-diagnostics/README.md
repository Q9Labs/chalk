# Episode diagnostics tooling

This private package owns the bounded `trace:inspect` resolver, deterministic
local fixture server, and desktop visual proof harness for Chalk Episode
Diagnostics. It does not mount an API route or enable any production worker.

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
