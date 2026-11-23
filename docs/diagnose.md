# diagnose: questions about calls, answered with proof

`pnpm diagnose` answers "what went wrong, for whom, and how sure are we" about Episodes, join attempts, jobs, and the days of a Space, a Tenant or the platform. It prints a compact line format built for agents (every line starts with a keyword or a handle you can grep or pass back), and `--json` gives the same view as one versioned object. `pnpm diagnose:call <episode-id>` is the older single-call report; `diagnose call` runs it too.

For a live incident, start in Axiom with the trace or request ID ([Follow an incident](observability.md#follow-an-incident)). Reach for `diagnose` when you want a verdict you can trust about one Episode, or to sweep a fixture world.

## Worlds

Every command except `call` reads one world:

- `--fixture nov18` (or a path to a world module) reads a fixture world, which is plain data. Every command works on a fixture.
- `--live --tenant <uuid> --episode <uuid>` reads one Episode from the real stores, read-only. It needs `CHALK_DATABASE_URL` for the declaration and seats, `AXIOM_TOKEN`, `AXIOM_ORG_ID` and `CHALK_LOG_DATASET` for the rows, and reads each seat's client watermark from the telemetry ledger. Live mode can't yet discover attempts, jobs or anything across Episodes, so `attempt`, `job`, `day`, `space`, `tenant`, `platform`, `pattern` and `window` need a fixture.

A client row counts as evidence only when the telemetry ledger stored it; anything else is ignored and counted on stderr ([Watermarks and gaps](telemetry-delivery.md#watermarks-and-gaps)). Server sources have no complete watermark yet, so a live verdict stays `partial` until they do. Pass `--store <file>` to keep verdicts across runs; without it a live read is `read=fresh`.

## Read a verdict

```text
episode ep_9feb tenant=TH outcome=broken coverage=partial(board) checked=9/13 asof=2026-11-19T01:00Z rules=e679be28
anchor=2026-11-18T09:45Z local=14:45+05:00 dur=60m seats=4
f_5b55 broken audio.not_heard pt_4c1e(Haris) +07:10..+10:40 hop=sfu_ingress module=unknown upstream=unknown ev=ev_a1f3
fact: SFU ingress 10480 packets, 0 voiced [ev_a1f3]
fact: microphone unmuted [ev_c9d0]
f_d2a1 expected end.time_limit all +60:00 reason=end.time_limit ev=ev_0b9e
gap: board.view_jumped all 4 seats: board.camera not emitted by client 3.1.0
next: diagnose evidence f_5b55 --fixture nov18
```

Read all three parts before you say anything about a call:

- **outcome** is `broken`, `degraded`, `expected`, `healthy` or `unknown`. `healthy` needs every planned check to run on complete evidence, so it never appears next to `coverage=partial`.
- **coverage** is `complete` or `partial(areas)`, and `checked=c/e` counts the checks that could decide. Each `gap:` line is a reason coverage is partial. A check passes only when its required facts are present, never on silence.
- **disagreement** (`disagree ...`) means two witnesses contradict each other. Treat it as unproved until you've read its `evidence`.

A `fact:` is something rows say, with their `ev_` handles in brackets. `upstream=unknown` means the evidence stops at that hop, so don't name a cause past it. `UNEXPLAINED` (a failure no check explains) counts as broken, and `unchecked` or `stale` never reads as healthy. Times are relative to the item's start (`+07:10`) in item views and UTC or tenant-local `HH:MM` in day views. Handle prefixes (`ep_`, `pt_`, `cs_`, `f_`, `ev_` and the rest) are in `observability/registry/ids.json`, and the golden outputs in `scripts/diagnose-call/golden/` are the reference for every line shape.

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

Every `next:` line runs as printed. A lookup that matches several things prints `cand` lines; narrow it with `--tenant` or a handle. `--limit N` and `--budget TOKENS` page long views, and gaps print on every page.

Exit codes: `0` printed a view, `64` usage mistake, `69` no data source. With `--strict`, `3` when the outcome is broken or degraded, `0` only when it is healthy or expected over complete coverage, and `2` otherwise.

## Add a check

A check's declaration lives in its area file under `observability/registry/areas/` and its behaviour in `observability/rules/<code>.mjs`. `scripts/diagnose-call/proof/catalogue.mjs` joins and validates them on load. `observability/registry/README.md` covers the registry side.

1. Declare the area's new facts (`name`, `kind`, `per`, and the `events` that witness them) and the symptom (`code`, `item`, `per`, and its `witnesses` with the query that reproduces each). Run `pnpm run regen`.
2. Write `observability/rules/<code>.mjs`, exporting `symptom`, `expected`, `applies(declaration, seat)`, `decide(input)`, and `settle_ms` or `healthy_absent` when they apply. The kernel rejects a rule that cites rows it wasn't given, names a module that isn't a fault component, or passes on silence.
3. Add the fault scenario and its hop chain, which write `observability/fixtures/<code>/positive.json`, `observability/fixtures/<code>/healthy.json` and `observability/fixtures/<code>/chain/`. `observability/fixtures/end.wrong_screen/README.md` is the worked example. `node scripts/gates/obs-coverage.mjs` must pass (the positive fixture gives the finding, the healthy one gives none, and every fixture row comes from a chain hop), and `node scripts/gates/obs-chain-replay.mjs <code>` replays the hops. Then remove the symptom from `observability/registry/coverage-allowlist.json`.
4. Leave `scripts/diagnose-call/fixtures/nov18.mjs` and the goldens alone. Only a change to the CLI's output or a foundation check rewrites them: `DIAGNOSE_GOLDEN=write node --test scripts/diagnose-call/output/output.test.mjs`, then `uv run -q --no-project --with tiktoken python scripts/diagnose-call/golden/count_tokens.py`.

Any edit to the kernel, a registry fact or a rule file (even a comment) changes the `rules=` hash, so stored verdicts read as stale until `check` reruns them.
