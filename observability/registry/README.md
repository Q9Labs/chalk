# Observability registry: slice author's guide

The registry is the single source for what Chalk emits about a call. It holds data only: events, fields, reason codes, state machines and symptoms. `scripts/codegen/obs-registry.mjs` turns it into typed kernels for TypeScript, Go and Elixir, the Axiom field schema, the coverage graph and the CLI's symptom tables. You never edit generated output; you edit these JSON files and run `pnpm run regen`.

Follow the steps below in order. The worked example is `end.wrong_screen` in [areas/end.json](areas/end.json): the Episode ended for a real reason, but a client showed the connection-lost screen. Every link it needs exists, so copy its shape.

## What lives where

| Path                                               | What it is                                                                                                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registry/core.json`                               | Kinds, outcomes, datasets with their field budgets, modules, platforms, environments, clock settings and the two reserved reasons (`unclassified`, `cancelled`). Slices don't edit it. |
| `registry/ids.json`                                | Every id kind: its display prefix, its field, its canonical stored form, the four meanings of "session" and the CHK- code.                                                             |
| `registry/envelope.json`                           | Fields every record can carry: delivery, the ID trail, build, flags, clock and the kernel-stamped record fields.                                                                       |
| `registry/areas/<area>.json`                       | One file per product area, owned by one slice: its fields, events, reasons, machines and symptoms.                                                                                     |
| `registry/coverage-allowlist.json`                 | Symptoms that are declared but not yet provable. CI prints this list on every run.                                                                                                     |
| `registry/vectors.json`                            | Test vectors the three kernels must all pass. Changing them is a contract change.                                                                                                      |
| `rules/<symptom>.mjs`                              | The rule that finds a symptom in evidence rows.                                                                                                                                        |
| `fixtures/<symptom>/positive.json`, `healthy.json` | Rows the rule must flag, and rows it must not.                                                                                                                                         |
| `kernel/go/`                                       | The Go kernel source. The generator copies it into `apps/api/internal/obs` and `features/media/sfu/internal/obs`.                                                                      |
| `generated/`                                       | Generated JSON: the full registry, the Axiom fields, the coverage graph and the CLI tables.                                                                                            |

The TypeScript kernel lives in `sdks/typescript/client/src/obs/` and the Elixir kernel in `apps/sync/lib/chalk_sync/obs.ex`, each next to its only consumer.

## Steps for a slice

1. **Open your area file.** Your slice owns one file in `areas/`, named in the plan. Everything you name (reason codes, symptom codes) must start with one of the file's `prefixes`. Don't edit another slice's area file.

2. **Declare each new field** in the area's `fields` list, unless `envelope.json` or another area already declares it. Search `generated/registry.json` first; a field has one meaning across Chalk.
   - `name` is snake_case. Durations end in `_ms`, sizes in `_bytes`, rates in `_bps`, ratios in `_pct`. The generator rejects `_s`, `_sec`, `_millis`, `_kb`, `_mbps`, `_percent` and similar.
   - `type` is one of `string`, `int`, `number`, `bool`, `enum`, `id` or `map`. An `enum` lists its `values`. An `id` names its `id_kind` from `ids.json`.
   - `sensitivity` is `null`. Leave it null: a later privacy pass fills it in. It must be present.
   - `doc` says what the value means in one sentence.
   - Never declare a field for a credential, token, grant, authorization header, full signaling body, SDP, transcript text or raw provider error. Use a fixed code, a class or a hash.

3. **Declare each event** in the area's `events` list.
   - `name` is dotted snake_case, such as `sync.episode.ended`. It is unique across the registry.
   - `kind` is `op` (work with one terminal outcome), `decision` (an authoritative choice, with a `decisions` list), `surface` (something shown to a person) or `fact` (a measurement or observation). A state change is not an event: declare it as a machine (step 5).
   - `dataset` is one of the datasets in `core.json`. Every field an event uses counts against that dataset's budget, and the generator fails when the budget is exceeded.
   - `side` is `client`, `server` or `any`; `modules` lists the modules that emit it.
   - `fields` maps each field name to `{ "required": true | false }`. An enum field may narrow its values for this event with `"values": [...]`, a subset of the field's values. Trail fields (`episode_id`, `participant_id` and the rest of `envelope.json`'s trail group) are allowed on every event without being listed. Don't list kernel-stamped fields such as `outcome`, `reason_code`, `duration_ms` or `op_id`: the kernel adds them.
   - `emit_sites` lists `{ "path": "...", "literal": "..." }` for every place in code that emits the event. The literal is a string the file must contain, such as the event name in quotes or a Go constant like `obs.EventSyncEpisodeEnded`. CI fails when the file stops containing it.
   - `legacy` is only for an event an older code path already emits under another name; see `client.call_ended`.

4. **Declare each reason code** in `reasons`: `{ "code": "<prefix>.<snake_case>", "outcome": "expected" | "error", "doc": "..." }`. An `expected` reason is a known, legitimate stop (the Episode was already ended). An `error` reason is a failure. Code that throws something the op doesn't classify is recorded as `error(unclassified)`, never as ok.

5. **Declare each state machine** in `machines`: `name`, `states`, `initial`, `edges` as `[from, to]` pairs, and `triggers`. The kernel rejects a transition that is not a declared edge or uses an undeclared trigger.

6. **Declare the symptom** in `symptoms`.
   - `code` is `<prefix>.<snake_case>`, such as `end.wrong_screen`.
   - `doc` says what went wrong in plain words, and `user_words` lists how a person would say it.
   - `witnesses` lists the evidence the rule needs: `{ "id": "server_end", "event": "sync.episode.ended", "fields": [...], "required": true }`. The rule receives rows grouped by these ids.
   - `fault_scenario` is the path of the test that produces the symptom on real code (step 9).

7. **Write the rule** at `rules/<code>.mjs`. It exports `symptom` (the code) and `evaluate(evidence)`, which takes `{ [witness id]: rows }` and returns a list of hits. Each hit names the ids involved and the `event_id`s of the rows that prove it. A rule that finds nothing has not proved health: say so in its header, and never return a healthy verdict.

8. **Write the fixtures** at `fixtures/<code>/positive.json` and `healthy.json`, each `{ "description": "...", "rows": [{ "event": "...", ...fields }] }`. Every row uses registry events and fields with valid enum values and the event's required fields. The positive rows must give at least one hit and include every witness field. The healthy rows must give none, and should include the near misses a careless rule would flag (another Episode, a drop long before the end).

9. **Write the fault scenario**: a test next to the code that drives the real code into the symptom, captures what it really emits, and runs the rule on it. It must contain the symptom code. See `sdks/typescript/client/src/connection/end-wrong-screen.fault.test.ts`.

10. **Emit from the code** with the kernel calls below, at the emit sites you listed.

11. **Remove the symptom from `coverage-allowlist.json`** once every link exists. CI fails if you leave a complete symptom on the list.

12. **Check it.** Run these from the repository root:

```sh
pnpm run regen
pnpm run check:generated
node scripts/gates/obs-coverage.mjs
```

Then run the tests of every kernel you emit from (below). The generator's error messages name the file and the entry that is wrong.

## Kernel calls

Each kernel has the same five calls. Each call writes one record, checked against the registry. In tests and CI the kernel is closed, so a violation throws; in production it is open, so a violation is counted and the record still goes out.

| Call       | TypeScript (`createKernel` from `sdks/typescript/client/src/obs`)  | Go (`internal/obs`)                                   | Elixir (`ChalkSync.Obs`)                                           |
| ---------- | ------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------ |
| op         | `kernel.op(name, fields, (scope) => work, { classify })`           | `obs.Op(ctx, name, func(ctx, scope) error, attrs...)` | `Obs.op(name, fields, fn -> work end, classify: fun)`              |
| transition | `kernel.transition(machine, from, to, trigger, trail, { reason })` | `obs.Transition(ctx, obs.Move{...}, attrs...)`        | `Obs.transition(machine, from, to, trigger, fields, reason: code)` |
| decision   | `kernel.decision(name, decision, fields, reason)`                  | `obs.Decision(ctx, name, decision, reason, attrs...)` | `Obs.decision(name, decision, fields, reason)`                     |
| surface    | `kernel.surface(name, fields).dismiss()`                           | `dismiss := obs.Surface(ctx, name, attrs...)`         | `dismiss = Obs.surface(name, fields)`                              |
| fact       | `kernel.fact(name, fields)`                                        | `obs.Fact(ctx, name, attrs...)`                       | `Obs.fact(name, fields)`                                           |

An op records exactly one terminal outcome:

- It is `ok` when the work returns normally.
- It is `expected(code)` when the work calls `scope.expected(code)`, throws `expected(code)` (TS), returns `obs.Expected(code, err)` (Go), or is classified so (Elixir `classify`). A cancelled context or an AbortError is `expected(cancelled)`.
- It is `error(code)` when the work throws or returns a classified failure. Anything unclassified becomes `error(unclassified)`.

Go fields are `obs.F(obs.FieldEpisodeID, id)`, using the generated `Field*`, `Event*`, `Machine*` and `Reason*` constants. Record a decision only after it commits, never inside the transaction that might roll back.

## IDs and handles

Stored ids keep their canonical form: a dashed UUID, a W3C trace or span id, or a provider token. A prefix such as `ep_` is display and lookup syntax only. `formatHandle` / `FormatHandle` / `Ids.format_handle` adds it. With a scope, they return the shortest prefix of at least four hex digits that no other id in the scope shares. `parseHandle` reads a full or short handle, a bare id, `session:<id>`, a legacy participant hash or a `CHK-` code. `resolveHandle` returns every match: `unique`, `ambiguous` with all matches, or `none`. A reader never picks one of several matches.

A Participant is the per-Episode seat, and `generation` counts its rejoins. The person is the User or Agent. Journey, request and trace are three different ids: never use one for another.

"Session" has four meanings, so the word alone never names an id:

- `episode` is the call itself (`ep_`).
- `provider_media` is the media provider's session (`pm_`).
- `client_session` is one client app run (`cs_`).
- `dashboard_auth` is a dashboard sign-in session. It is not an observability id and never appears in telemetry.

`session:<id>` returns candidates for the first three. `CHK-XXXX` is a short code a person can read aloud. It is four Crockford base32 characters from the first 20 bits of the client session id, so it collides across a large population: resolve it only within a scope (an Episode, a Tenant and a time window), and expect ambiguous results.
