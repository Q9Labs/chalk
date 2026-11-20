# diagnose: questions about calls, answered with proof

`pnpm diagnose` answers "what went wrong, for whom, and how sure are we" about Episodes, join attempts, jobs, and the days of a Space, a Tenant or the platform. It is built for agents: the default output is a compact line grammar that costs a few hundred tokens, every line starts with a keyword or a handle you can grep or pass back, and `--json` gives the same view as one versioned object. `pnpm diagnose:call <episode-id>` is the older single-call report over today's rows; `diagnose call` runs it too.

Every command except `call` reads one world. `--fixture nov18` (or a path to a world module) reads a fixture world, which is plain data: the 18 Nov example is the reference. `--live --tenant <uuid> --episode <uuid>` reads one Episode from the real stores, read-only: its declaration and seats from Postgres (`CHALK_DATABASE_URL`), its rows from the environment's log dataset in Axiom (`AXIOM_TOKEN`, `AXIOM_ORG_ID`, `CHALK_LOG_DATASET`) from the Episode's start to its end plus the longest settle time, and each seat's client watermark from the telemetry ledger through `apps/api/cmd/telemetry-watermarks`, with seq gaps placed in time by the source's own rows. A seq the ledger stored but Axiom returned no timed row for is a gap too, since its record was never read. A seat with no ledger source, or a ledger the command can't read, leaves that seat's client source not read. Server sources (API, Sync, SFU) are complete to the latest row Axiom holds for the service, which proves the read but not that the service dropped nothing. Sources with no live store yet, such as problem reports, are not read, so a live verdict stays partial until they have one. It prints what it read and dropped on stderr. Without a world, or with a store it can't open, it exits 69.

## Read a verdict

```text
episode ep_9feb tenant=TH outcome=broken coverage=partial(board) checked=9/13 asof=2026-11-19T01:00Z rules=e679be28
anchor=2026-11-18T09:45Z local=14:45+05:00 dur=60m seats=4
f_5b55 broken audio.not_heard pt_4c1e(Haris) +07:10..+10:40 hop=sfu_ingress module=unknown upstream=unknown ev=ev_a1f3
fact: SFU ingress 10480 packets, 0 voiced [ev_a1f3]
fact: microphone unmuted [ev_c9d0]
f_d2a1 expected end.time_limit all +60:00 reason=end.time_limit ev=ev_0b9e
gap: board.view_jumped all 4 seats: board.camera not emitted by client 3.1.0
next: diagnose evidence f_5b55
```

A verdict has three parts, and you need all three before you say anything about a call:

- **outcome** is `broken`, `degraded`, `expected`, `healthy` or `unknown`. `healthy` means every planned check ran on complete evidence, nothing failed and no witnesses disagree. Anything short of that is `unknown`, never `healthy`, so `outcome=healthy` never appears next to `coverage=partial`.
- **coverage** is `complete` or `partial(areas)`, with `checked=c/e` counting the checks that could actually decide. Every `gap:` line is a reason coverage is partial, and gaps are never paged or cut by a budget. `coverage=complete` with a gap line is a bug, and the renderer refuses to print it. An open evidence gap from the telemetry ledger (a source that never closed, or a range it never accounted for) is a gap: the seat it covers is unchecked.
- **disagreement** lines (`disagree ...`) say two witnesses contradict each other, or that a complete re-read passes a check the stored verdict failed. Treat a disagreement as unproved until you have read its `evidence`.

A `fact:` is something a row says, with the rows in brackets. A `hypothesis:` is an attribution with the observation that would falsify it, and it is printed only when an upstream witness supports it. `upstream=unknown` means the evidence stops at that hop, so don't name a cause past it.

The backstops make silence honest. `UNEXPLAINED` is a problem report or failure that no check explains, and it counts as broken. `BLIND_SPOT` is a report that arrived after the verdict, or a report stream the bundle could not read completely. `WITNESS_DISAGREEMENT` is a disagreement. `unchecked` means no verdict exists yet, and `stale` means rows or rules changed after the verdict; neither ever reads as healthy.

## The line grammar

Every line is space-separated words: a keyword or handle first, then positional words, then `key=value` pairs. A slice that adds a check or a view extends these shapes and adds no new ones.

- **Headers** name the scope: `episode ep_x tenant=T`, `attempt cs_x tenant=T`, `job job_x tenant=T`, `space spc_x 2026-11-18`, `tenant ten_x 2026-11-18`, `platform production 2026-11-18`, and the sweeps `day T 2026-11-18`, `participant usr_x`, `pattern <code>`, `window T`, `check`, `resolve "<text>"`. Space, Tenant and platform days are UTC dates; `day` sweeps a tenant's items over the tenant's local day. Then `outcome=`, `coverage=`, `checked=`, `asof=` and `rules=`.
- **Finding lines** are `f_x <outcome> <code> <party> <when>` and then, when they apply, `hop=<hop>`, `module=<component>.<area>`, `upstream=witnessed|unknown`, `reason=<reason code>` and `ev=ev_x`. The outcome is always the second word. `module` names the code that owns the failing hop, from the registry's fault components (`sdk.connection`, `api.admission`, `recorder.job`), or `network` or `unknown` when the evidence can't attribute it; an `expected` finding has no module and names the registry reason code it stands for in `reason=` (`reason=end.time_limit`).
- **Parties** are bare handles with an optional name in parentheses: `pt_4c1e(Haris)` for a seat, `usr_th-1041(Haris)` for a person, `all` for the whole item. There is no `scope=` key.
- **Brackets** after a `fact:` hold only `ev_` handles of the rows the fact cites, or `[proven absent]` when complete coverage proves no such row exists. They never hold a source name.
- **Group lines** in sweeps are `<code> <outcome> <kind>s=<n>` with `people=<n>` and the first handles: `admission.unresolved broken attempts=1 cs_6d5e`.
- **Related records** a slice needs to show (an upload readback, a webhook delivery) are `<kind> <handle> key=value`, for example `upload dg_3f9a readback=ok`. The kind is a word, the handle one of the registry's id kinds.
- `gap:`, `fact:`, `hypothesis:`, `witness:`, `row:`, `watermark:`, `query:`, `falsify ...:`, `next:`, `via:`, `cand`, `more:` and `report` keep their current shapes.

## Ask

| Question                                       | Command                                                                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| How did a tenant's day go?                     | `diagnose day TH 2026-11-18` (or `today`, `yesterday`, `--symptom <code>`)                                             |
| What happened in one Episode, attempt or job?  | `diagnose ep_9feb`, `diagnose attempt cs_6d5e`, `diagnose job job_4a3b`                                                |
| How did a Space, a Tenant or the platform do?  | `diagnose space spc_5bac 2026-11-18`, `diagnose tenant ten_1f0c 2026-11-18`, `diagnose platform production 2026-11-18` |
| Is the proof behind a finding enough?          | `diagnose evidence f_5b55`                                                                                             |
| How has one person fared?                      | `diagnose participant usr_th-1041 --since 30d` or `--from 2026-11-01 --to 2026-11-12`                                  |
| Where else does a symptom appear?              | `diagnose pattern audio.not_heard --tenant TH`                                                                         |
| What happened in a time window?                | `diagnose window TH --from 2026-11-18T09:00Z --to 2026-11-18T11:00Z`                                                   |
| Bring verdicts up to date                      | `diagnose check TH 2026-11-18`, `diagnose check ep_9feb`, `diagnose check --tenant TH --since 7d`                      |
| I only have a name, an id or a diagnostic code | `diagnose Haris`, `diagnose 3e4f5a6b-...`, `diagnose CHK-7K2Q`, any handle or raw hex prefix                           |

A lookup that matches more than one thing prints `cand` lines and opens nothing; narrow it with `--tenant` or pass one of the handles. When a lookup resolved through something other than the handle you typed, a `via:` line says what matched (a session id as `client_session` or `media_connection`, for example).

Handles come from one implementation, C1's `sdks/typescript/client/src/obs/ids.ts` (the prefixes are in `observability/registry/ids.json`): a kind prefix and, in a view, the shortest id prefix of at least four hex digits that is unique among that view's handles of the same kind. `ep_` Episode, `cs_` client session (a join attempt is keyed by its client session, the one id a client has before it has a seat), `job_` job, `pt_` Participant seat, `usr_`/`agt_` person (tenant tokens, printed in full), `spc_` Space, `ten_` tenant, `f_` finding, `ev_` event row, `bt_` delivery batch, `dg_` diagnostic upload, `ak_` API key, `wh_` webhook endpoint, `fl_` flag set, `mc_`/`sc_` media and Sync connection, and `CHK-XXXX` the code a person reads out from a client. Handles are display and lookup syntax only; stores keep canonical ids.

## Page and budget

`--limit N` pages the records; the last line then says `more: N omitted by limit` and gives the `next:` command with `--cursor`. A cursor belongs to its view and exits 64 anywhere else. `--budget TOKENS` stops records at an approximate token budget instead. The status line and every gap print on every page.

## Exit codes

`0` printed a view, `64` usage mistake, `69` no data source. With `--strict`, `3` when the outcome is broken or degraded, and `2` when coverage is partial or the lookup was ambiguous.

## Add a check

A check has one home. Its declaration lives in its area file under `observability/registry/areas/` and its behaviour in `observability/rules/<code>.mjs`; `scripts/diagnose-call/proof/catalogue.mjs` assembles the two and validates them when it loads, so a malformed check fails every command with its code in the message. `observability/registry/README.md` describes the registry side.

1. Declare each new fact under the area's `facts`: its `name` (an area prefix), `kind` (`state`, `aggregate`, `event` or `once`), whether it is `per` seat, item or `any`, and the `events` that witness it, each with its `source`, the field the fact compares (`claim`), the claims that mean failure and the fields a reader needs. A row of a per-seat fact that names no Participant or connection never binds to a seat.
2. Declare the symptom: its `code`, the `item` kind it judges (`episode`, `attempt`, `job`, `space`, `tenant`, `platform`), whether it runs once per item or `per` seat, and its `witnesses`: each fact it reads, the sources that witness it, whether it is `required`, how many `independent` origins it needs, and the query that reproduces it. Query placeholders are `{episode}`, `{participant}`, `{attempt}`, `{job}`, `{space}`, `{tenant}`, `{environment}`, `{day}`, `{from}` and `{to}`, and each must be one the check's item can fill. Run `pnpm run regen`.
3. Write `observability/rules/<code>.mjs`. It exports `symptom`, `expected` (one sentence of what a healthy subject produces), `applies(declaration, seat)` (reads only the declaration, so the plan never depends on what the telemetry contains), `decide(input)` and, when records about the item keep arriving after it ends, `settle_ms`. `decide` gets three-state readings (`present`, `absent`, `unknown`) and returns `pass`, `unknown` with a reason, or a finding with `hop`, `module`, `reason` and facts that cite only rows from its readings. The kernel throws if a fact cites anything else, if the answer has a shape it does not define, if `module` is not a fault component (or is null on anything but an expected finding), or if a hypothesis comes without a witnessed upstream hop, so a rule cannot overclaim.
4. Add `observability/fixtures/<code>/positive.json` and `healthy.json`: `{ description, asof_ms, declaration, rows }`, with rows shaped like the telemetry (registry envelope and event fields). The coverage gate (`scripts/gates/obs-coverage.mjs`) judges both through the kernel with `scripts/diagnose-call/proof/rows.mjs`: the positive fixture must give a finding with the code, and the healthy one must check every eligible subject and give none. Add the fault scenario the registry names, which drives the real code and judges what it records the same way (`sdks/typescript/client/src/connection/end-wrong-screen.fault.test.ts` is the worked example). Then remove the symptom from `observability/registry/coverage-allowlist.json`.
5. Add the fact to the `emits` of the watermark that delivers it in `scripts/diagnose-call/fixtures/nov18.mjs`, with observations for it, or every item the check applies to reads as unknown in the goldens. The metamorphic tests in `scripts/diagnose-call/proof/soundness.test.mjs` run over its `BASES` list.
6. Rewrite the goldens with `DIAGNOSE_GOLDEN=write node --test scripts/diagnose-call/output/output.test.mjs` and recount tokens with `uv run -q --no-project --with tiktoken python scripts/diagnose-call/golden/count_tokens.py`.

The rules hash (`rules=`) covers the kernel files, each rule file and its registry entry byte for byte, so any edit there, even a comment, makes stored verdicts read as stale until `check` reruns them.
