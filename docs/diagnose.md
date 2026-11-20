# diagnose: questions about calls, answered with proof

`pnpm diagnose` answers "what went wrong, for whom, and how sure are we" about Episodes, join attempts and jobs. It is built for agents: the default output is a compact line grammar that costs a few hundred tokens, every line starts with a keyword or a handle you can grep or pass back, and `--json` gives the same view as one versioned object. `pnpm diagnose:call <episode-id>` is the older single-call report over today's rows; `diagnose call` runs it too.

It reads a world module today (`--fixture nov18` is the 18 Nov example). Reading production rows needs C1's IDs and C3's watermarks, so without `--fixture` it exits 69.

## Read a verdict

```text
episode ep_9feb tenant=TH outcome=broken coverage=partial(board) checked=5/9 asof=2026-11-19T01:00Z rules=c3470b2d
anchor=2026-11-18T09:45Z local=14:45+05:00 dur=60m seats=4
f_98d4 broken audio.no_voice_detected pt_4c1e(Haris) +07:10..+10:40 hop=sfu_ingress upstream=unknown ev=ev_a1f3
fact: SFU ingress 10480 packets, 0 voiced [ev_a1f3]
fact: microphone unmuted [ev_c9d0]
gap: board.view_jumped all 4 seats: board.camera not emitted by client 3.1.0
next: diagnose evidence f_98d4
```

A verdict has three parts, and you need all three before you say anything about a call:

- **outcome** is `broken`, `degraded`, `expected`, `healthy` or `unknown`. `healthy` means every planned check ran on complete evidence, nothing failed and no witnesses disagree. Anything short of that is `unknown`, never `healthy`.
- **coverage** is `complete` or `partial(areas)`, with `checked=c/e` counting the checks that could actually decide. Every `gap:` line is a reason coverage is partial, and gaps are never paged or cut by a budget. `coverage=complete` with a gap line is a bug, and the renderer refuses to print it.
- **disagreement** lines (`disagree ...`) say two witnesses contradict each other, or that a complete re-read passes a check the stored verdict failed. Treat a disagreement as unproved until you have read its `evidence`.

A `fact:` is something a row says, with the rows in brackets. A `hypothesis:` is an attribution with the observation that would falsify it, and it is printed only when an upstream witness supports it. `upstream=unknown` means the evidence stops at that hop, so don't name a cause past it.

The backstops make silence honest. `UNEXPLAINED` is a problem report or failure that no check explains, and it counts as broken. `BLIND_SPOT` is a report that arrived after the verdict, or a report stream the bundle could not read completely. `WITNESS_DISAGREEMENT` is a disagreement. `unchecked` means no verdict exists yet, and `stale` means rows or rules changed after the verdict; neither ever reads as healthy.

## Ask

| Question                                      | Command                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| How did a tenant's day go?                    | `diagnose day TH 2026-11-18` (or `today`, `yesterday`, `--symptom <code>`)                        |
| What happened in one Episode, attempt or job? | `diagnose ep_9feb`, `diagnose attempt jr_6d5e`, `diagnose job job_4a3b`                           |
| Is the proof behind a finding enough?         | `diagnose evidence f_98d4`                                                                        |
| How has one person fared?                     | `diagnose participant usr_9a1b --since 30d` or `--from 2026-11-01 --to 2026-11-12`                |
| Where else does a symptom appear?             | `diagnose pattern audio.no_voice_detected --tenant TH`                                            |
| What happened in a time window?               | `diagnose window TH --from 2026-11-18T09:00Z --to 2026-11-18T11:00Z`                              |
| Bring verdicts up to date                     | `diagnose check TH 2026-11-18`, `diagnose check ep_9feb`, `diagnose check --tenant TH --since 7d` |
| I only have a name or an id                   | `diagnose Haris`, `diagnose 3e4f5a6b-...`, any handle or raw hex prefix                           |

A lookup that matches more than one thing prints `cand` lines and opens nothing; narrow it with `--tenant` or pass one of the handles. When a lookup resolved through something other than the handle you typed, a `via:` line says what matched (a session id as `client_session` or `media_connection`, for example).

Handles are a kind prefix and the shortest id prefix that is unique in the view: `ep_` Episode, `jr_` join attempt, `job_` job, `pt_` Participant seat, `usr_`/`agt_` person, `f_` finding, `ev_` evidence row, `cs_`/`mc_` client session and media connection, `ten_` tenant.

## Page and budget

`--limit N` pages the records; the last line then says `more: N omitted by limit` and gives the `next:` command with `--cursor`. A cursor belongs to its view and exits 64 anywhere else. `--budget TOKENS` stops records at an approximate token budget instead. The status line and every gap print on every page.

## Exit codes

`0` printed a view, `64` usage mistake, `69` no data source. With `--strict`, `3` when the outcome is broken or degraded, and `2` when coverage is partial or the lookup was ambiguous.

## Add a check

A check is one entry in `scripts/diagnose-call/proof/catalogue.mjs` (`CheckDef` in `scripts/diagnose-call/proof/profile.mjs`):

1. Name the symptom `code`, the `item` kind it applies to, whether it runs once per item or `per` seat, and an `applies` predicate that reads only the declaration, so the plan never depends on what the telemetry happens to contain.
2. List the facts it `requires` (and `optional` ones), each with the sources that witness it, how many independent origins it needs, and the query that reproduces it.
3. Write `decide`: it gets three-state readings (`present`, `absent`, `unknown`) and returns `pass`, `unknown` with a reason, or a finding whose facts cite only rows from its readings. The kernel throws if a fact cites anything else, so a rule cannot overclaim.
4. Add a soundness case in `scripts/diagnose-call/proof/soundness.test.mjs`, then rewrite the goldens with `DIAGNOSE_GOLDEN=write node --test scripts/diagnose-call/output/output.test.mjs` and recount tokens with `uv run -q --no-project --with tiktoken python scripts/diagnose-call/golden/count_tokens.py`.

Changing a check changes the rules hash (`rules=`), so stored verdicts read as stale until `check` reruns them.
