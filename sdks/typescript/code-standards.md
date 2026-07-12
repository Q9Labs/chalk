# TypeScript SDK Code Standards

Canonical standards for `sdks/typescript/*` (`client`, `react`, `react-native`).
These packages are published and public: they are the example consumers and
future agents copy from. When editing here, match this document over any habit
you brought with you. `src/generated/**` is machine-written — never hand-edit
it, and never imitate its style.

## Structure

- One responsibility per file, ~300 lines max. A cohesive state machine (e.g.
  the sync protocol client) may exceed that only when splitting would scatter
  coupled state — and even then, pure helpers, frame builders, and validation
  move to sibling modules.
- Each subsystem exposes its public surface through its `index.ts`; everything
  else is internal. Don't re-export internals "just in case".
- Specific imports from sibling modules; no deep imports into another package's
  internals.

## TypeScript

- Infer types for locals; write explicit types for exported function parameters
  and return values.
- Name a type the second time you spell it. Never repeat a structural type
  inline:

  ```ts
  // Bad — repeated ~10 times across a file
  function settle(ack: Extract<AckFrame, { readonly result: "committed" | "duplicate" }>) {}

  // Good — declared once in types.ts
  type CommittedAck = Extract<AckFrame, { readonly result: "committed" | "duplicate" }>;
  ```

- Narrow, never assert. A discriminated union is consumed with `switch` on its
  discriminant; the compiler proves exhaustiveness. A `Record<Type["type"], handler>`
  table that needs `frame as WelcomeFrame` casts is the type system telling you
  the shape is wrong.
- `as unknown as T` is banned. If you can't construct a value as its declared
  type, the type or the construction is wrong — fix that instead. Build objects
  as typed literals; use conditional spread for optional fields, not mutation
  of a `Record<string, unknown>`.
- `unknown` over `any`; `readonly` fields and `const` by default; `as const`
  for literal tables.
- `type` for data shapes and unions; `interface` only when a consumer is meant
  to implement it (e.g. `PendingCommandStore`, `TelemetryStorage`).
- Native `#private` fields in classes — real runtime privacy in a published SDK,
  not the `private` keyword.
- No defensive re-validation of values the compiler already typed. Validate
  once at the boundary (user options, wire frames, storage reads); after that,
  trust the types.

## Functions and control flow

The most important rule in this document: **a function must earn its name.**
Extract a helper only when it is reused, or when it isolates a genuinely
separate concern with meaningful inputs and outputs. Never wrap a single
expression or single call that is used once:

```ts
// Bad — four hops to learn one line of truth
private canFlush() { return this.canExport() && this.retryAllows(); }
private canExport() { return this.isEnabled() && this.hasPending(); }
private isEnabled() { return !this.disposed && this.options.enabled; }
private hasPending() { return this.pending.length > 0; }

// Good — one honest predicate, readable in place
private canFlush(options?: TelemetryExportOptions): boolean {
  if (this.disposed || !this.options.enabled || this.pending.length === 0) return false;
  return options?.keepalive === true || this.retryTimer === undefined;
}
```

Same rule for module helpers: `clockFrom(options)` hiding
`options.clock ?? systemClock` is noise — write the expression where it's used.
The test: if inlining a helper makes the caller *easier* to read, inline it.

- Early returns over nesting; handle the failure or trivial case first.
- Flat, explicit data flow — a reader should trace any behavior through at most
  two or three functions, each doing visible work.
- Loops: `for...of`; no spread-accumulators (`acc = [...acc, x]`) inside loops.
- Regex literals at module top level, not recreated per call.

## Errors

- Subsystem-specific error classes (`SyncPersistenceError`,
  `SyncCommandValidationError`) with messages that describe the invariant
  violated, not the code path.
- Never silently swallow an error. An intentionally-ignored failure gets a
  comment stating the invariant that makes ignoring safe
  (e.g. "a consumer callback must not interrupt the meeting path").

## Effect

The client package is **Effect-native inside, Promise-simple outside**.

- Subsystems are Effect services composed with Layers. Environment
  capabilities — WebSocket factory, pending-command store, telemetry exporter
  and storage, fetch — are provided as Layers with production defaults and
  in-memory/fake Layers for tests. Time and randomness come from Effect's
  built-in `Clock`/`Random` services; never hand-roll clock or random
  injection, and never call `Date.now()`, `setTimeout`, `Math.random()`, or
  `crypto.randomUUID()` directly from subsystem logic.
- Concurrency is structured: a fiber per connection with interruption instead
  of generation-counter guards; `Queue` plus one consumer fiber instead of
  promise chaining; `Effect.retry`/`Effect.repeat` with `Schedule` for backoff
  and heartbeats; `Scope` finalizers for cleanup.
- Observable state lives in `SubscriptionRef`: snapshots read synchronously,
  changes consumed as a Stream.
- Errors are `Data.TaggedError` classes on the error channel, handled with
  `Effect.catchTag` — not thrown exceptions.
- Wire frames and persisted records are decoded with Effect `Schema` at the
  boundary; after that, trust the types.
- **The public boundary hides all of this.** The default entry point is a thin
  Promise facade over a `ManagedRuntime`: methods return Promises, and
  `subscribe`/`getSnapshot` stay synchronous (the React package's
  `useSyncExternalStore` integration depends on that). No Effect types on the
  default surface. Effect-fluent consumers import services and Layers from the
  `@q9labsai/chalk-client/effect` subpath.
- `effect` is pinned to the 4.0 beta line: verify APIs against the installed
  package's types, not memory of Effect v3.

## React (`react`, `react-native`)

- Function components only; never define a component inside another component.
- React 19: `ref` is a normal prop — no `forwardRef`.
- **We do not use `useEffect`.** What looks like an effect is always one of:
  - *External state* (SyncClient snapshots, telemetry health, media devices):
    subscribe with `useSyncExternalStore(subscribe, getSnapshot)` — our clients
    already expose `subscribe`/`getSnapshot` for exactly this.
  - *A response to user action*: do the work in the event handler.
  - *Derived data*: compute during render (memoize only if measured as hot).
  - *DOM/native node access*: a `ref` callback, which can return a cleanup.
  If none of these fit, the logic belongs in the framework-free client layer,
  not in a component.
- Hooks at top level with correct dependency arrays; shared logic becomes a
  custom hook, not a copy.
- `React.memo` for leaf components in render-heavy trees (video tiles, grids);
  don't wrap by reflex elsewhere.
- Accessibility is non-negotiable: semantic elements, `aria-label` /
  `aria-pressed` on icon controls, keyboard operability,
  `focus-visible` rings. `rel="noopener"` on `target="_blank"` links.
- Styling via `cn()` with Tailwind utilities and CSS variables
  (`var(--foreground)`), matching the existing theme system.
- `key` from stable IDs, never array indices.

## Testing

- Vitest, colocated `*.test.ts` next to the source.
- Client-package tests are Effect-native: drive time with `TestClock`, provide
  fake capability Layers (scripted socket, in-memory store), and assert through
  the subsystem's service or the public facade — never reach into private
  state. Determinism comes from Layers, not from sleeping.
- Behavior changes ship with focused tests; every bug fix ships with the
  regression test that would have caught it.

## Workflow

- Format with `oxfmt` (package `lint` script runs `oxfmt --check` + `tsc`).
- Per-package: `pnpm run check-types`, `pnpm run test`, `pnpm run build`.
- Repo gate before any commit/PR: `pnpm run gate` from the repo root.
