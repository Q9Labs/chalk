# Observability registry: slice author's guide

The registry is the single source for what Chalk emits about a call and what can be checked about it: the items a check judges, the witness sources, the id kinds, the envelope every record carries, and each area's fields, events, reasons, state machines, facts and symptoms. It holds data only. A symptom's behaviour lives in its rule under `observability/rules/`, and its proof rows in `observability/fixtures/`. `scripts/codegen/obs-registry.mjs` turns the JSON into typed registries for the TypeScript, Go and Elixir kernels and into the generated JSON the checker, the CLI and the coverage gate read. You never edit generated output: you edit these JSON files and run `pnpm run regen`.

Follow the steps below in order. The worked example is `end.wrong_screen` in [areas/end.json](areas/end.json), with its rule in `observability/rules/end.wrong_screen.mjs` and its fixtures in `observability/fixtures/end.wrong_screen/`: the Episode ended for a real reason, but a client showed the connection-lost screen. Every link it needs exists, so copy its shape. A slice never adds a second way to declare, judge or prove a check.

## What lives where

| Path                                                    | What it is                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observability/registry/core.json`                      | The fixed vocabulary: record kinds, outcomes, the two reserved reasons (`unclassified`, `cancelled`), datasets with their field budgets, modules, platforms, environments, clock settings, the `items` a check judges, the witness `sources` and the `fault_components`. Slices don't edit it. |
| `observability/registry/ids.json`                       | Every id kind: its handle prefix, its field, its canonical stored form and its authority, plus the four meanings of "session" and the `CHK-` diagnostic code.                                                                                                                                  |
| `observability/registry/envelope.json`                  | Fields every record can carry, in groups: delivery, the ID trail, build, flags, clock and the kernel-stamped record fields.                                                                                                                                                                    |
| `observability/registry/areas/<area>.json`              | One file per product area, owned by one slice: its fields, events, reasons, machines, facts and symptoms.                                                                                                                                                                                      |
| `observability/registry/coverage-allowlist.json`        | Symptoms that are declared but not yet provable, each with the slice that finishes it. The coverage gate prints this list on every run.                                                                                                                                                        |
| `observability/registry/vectors.json`                   | Test vectors all three kernels must pass. Changing them is a contract change.                                                                                                                                                                                                                  |
| `observability/rules/<code>.mjs`                        | The rule that decides one symptom from the readings of its witnesses.                                                                                                                                                                                                                          |
| `observability/fixtures/<code>/{positive,healthy}.json` | Rows the rule must turn into a finding, and rows that must check every eligible subject and give none.                                                                                                                                                                                         |
| `observability/kernel/go/`                              | The Go kernel source. The generator copies it into `apps/api/internal/obs` and `features/media/sfu/internal/obs`.                                                                                                                                                                              |
| `observability/generated/`                              | Generated JSON: the normalized registry, the Axiom field schema, the coverage graph and the CLI tables.                                                                                                                                                                                        |

The TypeScript kernel lives in `sdks/typescript/client/src/obs/` and the Elixir kernel in `apps/sync/lib/chalk_sync/obs.ex`, each next to its only consumer. The generator writes their registries to `sdks/typescript/client/src/obs/registry.ts` and `apps/sync/lib/chalk_sync/obs/registry.ex`, and the Go registry to `apps/api/internal/obs/registry_gen.go` and `features/media/sfu/internal/obs/registry_gen.go`.

## The core vocabulary

**Items** are what a check judges, from `core.json` `items`: `episode` (one live occurrence in a Space, declared by its Postgres row), `attempt` (a join attempt keyed by its client session, `cs_`, including one that never became an Episode), `job` (a post-call job such as a recording render), and `space`, `tenant` and `platform`, each over one UTC day. A symptom names one item, and only an `episode` symptom can run per seat.

**Sources** are the witnesses a fact can come from, from `core.json` `sources`: `client` (per seat, delivered per client session through the telemetry ledger), `api`, `sync`, `sfu`, `cf`, `recorder`, `lambda`, `provider_webhook`, `db`, `r2`, `host`, `edge`, `report` and `release`. A source name appears in the registry and in watermarks, never in a finding's `fact:` brackets, which cite only `ev_` handles or `[proven absent]`.

**Fault components** name who owns a failing hop. A finding's `module=` is `<component>.<area>` (the area may be dotted), with the component one of `web`, `react`, `rn`, `sdk`, `mobile`, `ios`, `api`, `sync`, `sfu`, `cf`, `recorder`, `dispatcher`, `postgres`, `storage`, `host` or `tenant`, or it is the standalone `network` or `unknown`. A module never starts with a symptom prefix, and an `expected` finding has no module: it names its reason code in `reason=` instead. [diagnose.md](../../docs/diagnose.md#the-line-grammar) gives the full finding grammar.

## The envelope and delivery

`envelope.json` declares the fields any record may carry. The kernel stamps the delivery, build, flags, clock and record groups, and the caller's context supplies the trail (`tenant_id`, `episode_id`, `participant_id`, `generation`, `client_session_id`, `journey_id`, `trace_id` and the rest). Trail fields are allowed on every event without being listed.

The delivery group is how a reader knows what it has not seen. Contract C3, [telemetry delivery](../../docs/telemetry-delivery.md), owns its semantics:

- `event_id` names one record for good, and is its `ev_` handle. `seq` is its position in its source's stream, and `source_id` is that stream: a client uses its client session id, a server its instance id.
- `batch_id` names the batch that delivered the record, and `next_seq` is the source's high-water mark on every batch.
- `end` says how a source ended: `closed` (the client named its last `next_seq` exactly) or `abandoned` (a successor found it dead and reports the last high-water mark it persisted).
- A drop record carries `dropped_seqs` (half-open `[from, to)` ranges, at most 64), `drop_reason` (`queue_full`, `credential_expired` or `refused`) and, when the seqs belong to a predecessor, `dropped_source_id`.

The ledger binds each source to the first Participant that wrote it. A later Participant of the same User or Agent is a successor and may write to it. A batch whose own source is bound to another Participant that the batch's Participant does not succeed is refused whole with `source_bound`. A drop record that names a predecessor bound that way is rejected alone with `source_bound` and leaves that predecessor's gap open, while the rest of the batch lands. The ledger turns each source into watermarks and evidence gaps, and an open gap (a source that never closed, or a range it never accounted for) leaves the seat it covers unchecked. Unchecked is never healthy.

## Steps for a slice

1. **Open your area file.** Your slice owns one file in `areas/`, named in the plan, with its `area`, `slice`, `title` and `prefixes`. Facts, reason codes and symptom codes must start with one of the file's `prefixes`, and the generator rejects any that doesn't. Event and machine names only need to be dotted and unique, so an event may name its emitter (`sync.episode.ended`), but never use another area's prefix. Don't edit another slice's area file.

2. **Declare each new field** in the area's `fields` list, unless `envelope.json` or another area already declares it. Search `observability/generated/registry.json` first: a field has one meaning across Chalk.
   - `name` is snake_case. Durations end in `_ms`, sizes in `_bytes`, rates in `_bps`, ratios in `_pct`. The generator rejects `_s`, `_sec`, `_millis`, `_kb`, `_mbps`, `_percent` and similar.
   - `type` is one of `string`, `int`, `number`, `bool`, `enum`, `id`, `map` or `ranges`. An `enum` lists its `values`. An `id` names its `id_kind` from `ids.json`.
   - `sensitivity` is `null`. Leave it null: a later privacy pass fills it in. It must be present.
   - `doc` says what the value means in one sentence.
   - Never declare a field for a credential, token, grant, authorization header, full signaling body, SDP, transcript text or raw provider error. Use a fixed code, a class or a hash.

3. **Declare each event** in the area's `events` list.
   - `name` is dotted snake_case, such as `sync.episode.ended`. It is unique across the registry.
   - `kind` is `op` (work with one terminal outcome), `decision` (an authoritative choice, with a `decisions` list), `surface` (something shown to a person) or `fact` (a measurement or observation). A state change is not an event: declare it as a machine (step 5).
   - `dataset` is one of the datasets in `core.json`. Every field an event uses counts against that dataset's budget, and the generator fails when the budget is exceeded.
   - `side` is `client`, `server` or `any`; `modules` lists the modules that emit it.
   - `fields` maps each field name to `{ "required": true | false }`. An enum field may narrow its values for this event with `"values": [...]`, a subset of the field's values. Don't list trail fields or kernel-stamped fields such as `outcome`, `reason_code`, `duration_ms` or `op_id`: the envelope covers them.
   - `emit_sites` lists `{ "path": "...", "literal": "..." }` for every place in code that emits the event. The literal is a string the file must contain, such as the event name in quotes or a Go constant like `obs.EventSyncEpisodeEnded`. The coverage gate fails when the file stops containing it.
   - `legacy` is only for an event an older code path already emits under another name; see `client.call_ended`.

4. **Declare each reason code** in `reasons`: `{ "code": "<prefix>.<snake_case>", "outcome": "expected" | "error", "doc": "..." }`. An `expected` reason is a known, legitimate stop (the Episode reached its time limit, `end.time_limit`). An `error` reason is a failure. Code that throws something the op doesn't classify is recorded as `error(unclassified)`, never as ok.

5. **Declare each state machine** in `machines`: `name` (dotted snake_case such as `episode.lifecycle`, and never the name of an event), `states`, `initial`, `edges` as `[from, to]` pairs, and `triggers`. The kernel rejects a transition that is not a declared edge or uses an undeclared trigger.

6. **Declare each fact** in `facts`. A fact is what a witness claims, read from rows.
   - `name` is dotted and starts with an area prefix, such as `end.episode` or `end.client_screen`.
   - `kind` is `once` (one value per subject for its whole life, such as the Episode's end reason), `state` (a claim that held for a whole window, such as the microphone being unmuted), `aggregate` (a summary over exactly its window, such as a 15 s rollup) or `event` (a point record that may repeat, such as a failure). `scripts/diagnose-call/proof/facts.mjs` says how two claims of each kind are compared.
   - `per` is `seat`, `item` or `any`. A row of a per-seat fact that names no Participant or connection never binds to a seat, and an `item` fact may be read by a seat's check because the seat lives inside the item.
   - `events` lists the registry events that witness it, each with its `source` (from `core.json` `sources`), its `claim` (the field the fact compares), its `failure_claims` (claims that are failures some finding must explain) and its `fields` (every field a fixture row carries, including the claim).

7. **Declare the symptom** in `symptoms`.
   - `code` is `<prefix>.<snake_case>`, such as `end.wrong_screen`.
   - `item` is the item kind it judges, and `per` is `item` or `seat` (seat only on `episode`).
   - `doc` says what went wrong in plain words, and `user_words` lists how a person would say it.
   - `witnesses` lists `{ "fact", "from", "required", "independent", "query", "doc" }`: the fact it reads, the sources that may witness it, whether it is required, how many independent origins it needs (1 when omitted), and the query a reader reruns. Query placeholders are `{episode}`, `{participant}`, `{attempt}`, `{job}`, `{space}`, `{tenant}`, `{environment}`, `{day}`, `{from}` and `{to}`, and each must be one the symptom's item can fill.
   - `fault_scenario` is the path of the test that produces the symptom on real code (step 10), or `null` until it exists.

8. **Write the rule** at `observability/rules/<code>.mjs`. It exports `symptom` (the code), `expected` (one sentence of what a healthy subject produces), `applies(declaration, seat)`, `decide(input)` and, when records about the item keep arriving after it ends, `settle_ms`. `applies` reads only the declaration, so the plan never depends on what the telemetry contains. `decide` gets one three-state reading (`present`, `absent`, `unknown`) per witness fact and returns `{ status: "pass" }`, `{ status: "unknown", reason }` or a finding with its `outcome`, `hop`, `module`, `reason`, `upstream` and facts that cite only observations from its readings. The kernel throws when a fact cites anything else, when `module` is not a fault component (or is null on anything but an `expected` finding), or when a hypothesis comes without a witnessed upstream hop. A reading of `unknown` means the subject is unchecked: return `unknown`, never `pass`.

9. **Write the fixtures** at `observability/fixtures/<code>/positive.json` and `observability/fixtures/<code>/healthy.json`, each `{ "description", "asof_ms", "declaration", "rows" }` with optional `watermarks`. The declaration is the item the check judges (an Episode with its seats, an attempt, a job or a day), and each row is shaped like the telemetry: an `event` name plus registry envelope and event fields, with an `event_id` and an `est_server_ms` so it can be cited and placed. Every row uses valid enum values and its event's required fields. The positive rows must give a finding with the code and include every witness field. The healthy rows must check every eligible subject and give none, and should include the near misses a careless rule would flag (another Episode, a drop long before the end).

10. **Write the fault scenario**: a test next to the code that drives the real code into the symptom, captures what it really emits, and judges it the same way the fixtures are judged. It must contain the symptom code. See `sdks/typescript/client/src/connection/end-wrong-screen.fault.test.ts`.

11. **Emit from the code** with the kernel calls below, at the emit sites you listed.

12. **Teach the example world.** Add the fact to the `emits` of the watermark that delivers it in `scripts/diagnose-call/fixtures/nov18.mjs`, with observations for it, then rewrite the goldens as [diagnose.md](../../docs/diagnose.md#add-a-check) describes. Without that, every item the check applies to reads as unknown in the goldens.

13. **Remove the symptom from `coverage-allowlist.json`** once every link exists. The gate fails if you leave a complete symptom on the list.

14. **Check it.** Run these from the repository root:

```sh
pnpm run regen
pnpm run check:generated
node scripts/gates/obs-coverage.mjs
```

Then run the tests of every kernel you emit from (below). The generator's error messages name the file and the entry that is wrong.

## The coverage gate

`scripts/gates/obs-coverage.mjs` reads `observability/generated/coverage-graph.json` and, for every symptom, checks the chain a reader relies on: witnesses, then facts, then their events and fields, then emit sites in code, then the rule, then the positive and healthy fixtures, then the fault scenario. It judges both fixtures with `scripts/diagnose-call/proof/rows.mjs`, which reads the rows into observations and runs the diagnose kernel's judge (`scripts/diagnose-call/proof/verdict.mjs`), the same judge `pnpm diagnose` uses, so a fixture that passes the gate reads the same way in the CLI. A symptom with a missing link fails unless the allow-list names it, and the allow-list is printed on every run so nobody mistakes an allow-listed symptom for a covered one.

`scripts/diagnose-call/proof/catalogue.mjs` assembles each check from its registry entry and its rule file and validates them when it loads, so a malformed check fails every `diagnose` command with its code in the message. A symptom with no rule file yet is catalogued but not checked.

## Kernel calls

Each kernel has the same five calls. Each call writes one record, checked against the registry. In tests and CI the kernel is closed, so a violation throws; in production it is open, so a violation is counted and the record still goes out.

| Call       | TypeScript (`createKernel` from `sdks/typescript/client/src/obs/kernel.ts`) | Go (`internal/obs`)                                   | Elixir (`ChalkSync.Obs`)                                           |
| ---------- | --------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| op         | `kernel.op(name, fields, (scope) => work, { classify })`                    | `obs.Op(ctx, name, func(ctx, scope) error, attrs...)` | `Obs.op(name, fields, fn -> work end, classify: fun)`              |
| transition | `kernel.transition(machine, from, to, trigger, trail, { reason })`          | `obs.Transition(ctx, obs.Move{...}, attrs...)`        | `Obs.transition(machine, from, to, trigger, fields, reason: code)` |
| decision   | `kernel.decision(name, decision, fields, reason)`                           | `obs.Decision(ctx, name, decision, reason, attrs...)` | `Obs.decision(name, decision, fields, reason)`                     |
| surface    | `kernel.surface(name, fields).dismiss()`                                    | `dismiss := obs.Surface(ctx, name, attrs...)`         | `dismiss = Obs.surface(name, fields)`                              |
| fact       | `kernel.fact(name, fields)`                                                 | `obs.Fact(ctx, name, attrs...)`                       | `Obs.fact(name, fields)`                                           |

An op records exactly one terminal outcome:

- It is `ok` when the work returns normally.
- It is `expected(code)` when the work calls `scope.expected(code)`, throws `expected(code)` (TS), returns `obs.Expected(code, err)` (Go), or is classified so (Elixir `classify`). A cancelled context or an AbortError is `expected(cancelled)`.
- It is `error(code)` when the work throws or returns a classified failure. Anything unclassified becomes `error(unclassified)`.

Go fields are `obs.F(obs.FieldEpisodeID, id)`, using the generated `Field*`, `Event*`, `Machine*` and `Reason*` constants. Record a decision only after it commits, never inside the transaction that might roll back.

## IDs and handles

Stored ids keep their canonical form: a dashed UUID, a W3C trace or span id, a hex hash or a provider token. A handle such as `ep_9feb` is display and lookup syntax only. The prefixes come from `ids.json` and have one implementation, `sdks/typescript/client/src/obs/ids.ts`, mirrored by the Go and Elixir kernels: `formatHandle` / `FormatHandle` / `Ids.format_handle` adds the prefix and, with a scope, returns the shortest prefix of at least four hex digits that no other id of that kind in the scope shares. `parseHandle` reads a full or short handle, a bare id, `session:<id>`, a legacy participant hash or a `CHK-` code. `resolveHandle` returns every match: `unique`, `ambiguous` with all matches, or `none`. A reader never picks one of several matches.

The handles a reader meets most are `ep_` Episode, `cs_` client session (which also keys a join attempt), `job_` job, `pt_` Participant seat, `usr_` and `agt_` person (tenant tokens, printed in full), `spc_` Space, `ten_` Tenant, `f_` finding, `ev_` event row, `bt_` delivery batch, `dg_` diagnostic upload, `ak_` API key, `wh_` webhook endpoint, `fl_` flag set (its `flags_hash`), `mc_` and `sc_` media and Sync connections, and `CHK-XXXX` the diagnostic code. A related record a view shows is `<kind> <handle> key=value`, for example `upload dg_3f9a readback=ok`.

A Participant is the per-Episode seat, and `generation` counts its rejoins. The person is the User or Agent. Journey, request and trace are three different ids: never use one for another.

"Session" has four meanings, so the word alone never names an id:

- `episode` is the call itself (`ep_`).
- `provider_media` is the media provider's session (`pm_`).
- `client_session` is one client app run (`cs_`).
- `dashboard_auth` is a dashboard sign-in session. It is not an observability id and never appears in telemetry.

`session:<id>` returns candidates for the first three. `CHK-XXXX` is a short code a person can read aloud. It is four Crockford base32 characters from the first 20 bits of the client session id, so it collides across a large population: resolve it only within a scope (an Episode, a Tenant and a time window), and expect ambiguous results.
