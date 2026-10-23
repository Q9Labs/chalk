# Board view leadership scenario table

The rendered Board receives views through the real TypeScript SDK. A fake clock fires background-tab timers about once a minute. Each move has a 600 ms camera deadline; no row reloads the app.

Within one tab, only its sequence orders views. Across tabs, the authenticated last-led stamp wins, then the connection UUID breaks ties. Every camera move leads by default except the explicitly marked follow-apply path. Recovery retains the latest leading intent even if later idle frames arrive.

| Scenario                                                                            | Round 4 helper | 8550a79d7 | b2d201ec6 | Rebased fix |
| ----------------------------------------------------------------------------------- | -------------- | --------- | --------- | ----------- |
| an observed direct view does not block the selected relay's next unapplied view     | FAIL           | FAIL      | FAIL      | PASS        |
| JUDGE: a late pre-reconnect sequence cannot win by being stamped later              | PASS           | PASS      | FAIL      | PASS        |
| JUDGE: a newer move wins after a node ten seconds ahead                             | PASS           | PASS      | FAIL      | PASS        |
| later moves win with Sync clock skew -10000 ms in both directions                   | FAIL           | FAIL      | FAIL      | PASS        |
| later moves win with Sync clock skew 10000 ms in both directions                    | FAIL           | FAIL      | FAIL      | PASS        |
| concurrent nodes converge for followers receiving opposite arrival orders           | PASS           | PASS      | PASS      | PASS        |
| delayed frames from the same connection never move the camera                       | PASS           | PASS      | PASS      | PASS        |
| a delayed pre-loss frame stamped after reconnect still loses to the higher sequence | PASS           | PASS      | FAIL      | PASS        |
| owner-first delivery still reaches a follower through the selected relay            | PASS           | PASS      | PASS      | PASS        |
| Follow-me starts leadership once and idle timers retain that leadership             | FAIL           | FAIL      | PASS      | PASS        |
| older idle keep-alives cannot take over a throttled newer tab                       | FAIL           | FAIL      | PASS      | PASS        |
| a real move in the older tab takes over immediately while newer is throttled        | FAIL           | FAIL      | PASS      | PASS        |
| foregrounding and moving in the newer tab takes leadership back without reload      | PASS           | FAIL      | PASS      | PASS        |
| a real move during reconnect leads on ready with no extra move                      | FAIL           | FAIL      | FAIL      | PASS        |
| one tab quiet for minutes resumes with the first move                               | PASS           | PASS      | PASS      | PASS        |
| a database rewind cannot delay a new leader or either relay path                    | FAIL           | FAIL      | PASS      | PASS        |
| a delayed pre-restore frame cannot undo recovery                                    | FAIL           | PASS      | PASS      | PASS        |
| cached Follow stays current with enriched proof before the newer view               | PASS           | PASS      | PASS      | PASS        |
| cached Follow stays current with enriched proof after the newer view                | PASS           | PASS      | PASS      | PASS        |
| legacy-then-enriched replay preserves the authenticated metadata                    | FAIL           | FAIL      | PASS      | PASS        |
| temporary socket loss retains order but authoritative leave clears cached views     | FAIL           | FAIL      | PASS      | PASS        |
| idle keep-alives make zero camera writes, including minute-throttled timers         | PASS           | PASS      | PASS      | PASS        |
| JUDGE: user Zoom in grants leadership                                               | FAIL           | FAIL      | FAIL      | PASS        |
| JUDGE: recovery-time real movement is retained as leadership after reconnect        | FAIL           | FAIL      | FAIL      | PASS        |

Both historical incarnation-based versions pass 11/24. The first last-led version passes 15/24. The rebased fix passes 24/24. This includes the judge's four reproductions: zoom leadership, delayed pre-loss sequence, recovery movement and clock skew. New skew rows switch in both directions; the concurrent row feeds opposite arrival orders into two real SDKs and checks the rendered camera against their common winner.

The cross-node stamp boundary also has deterministic Elixir tests with independent clocks ten seconds apart, authenticated observations in both directions, forged-frame rejection and concurrent stamps. Replacing the clock with the previous wall-clock-only rule makes both skew tests fail; the hybrid clock passes them.

## Evidence and limits

`scratchpad/held-sdk-proof-2026-10-23/r9/` contains indexed, row-by-row JSON, the historical source loader, exact judge reproductions, local review and focused red/green logs. The loader freezes each version's SDK, generated contract and Board; the round-4 comparison substitutes only its helper. It never overwrites the working tree.

The final table and PostgreSQL-backed Sync suite ran after rebasing onto `c48de517a`. Authority still owns every watch; an unavailable Authority still closes hello with 1012 and `failure: "authority"`. The strict Sync suite passes 214 tests with zero skips. Two separate topology-profile tests remain excluded. Format, warnings-as-errors compilation, Credo and client declarations pass.

A fresh two-node M4 run in `r9/live-final/` physically rewound PostgreSQL from transaction 2095 to 1922 while Sync and established sockets survived. It proved authenticated relays both ways, restart recovery, zero idle/delayed-frame camera writes, later moves from the ten-second-slower node and agreement between two followers during overlapping moves. Mismatched origin secrets made both nodes unready with fingerprint-only logs; matching secrets restored readiness. All nine production-source hashes match this head. The remote runner cleaned its checkout and stopped owned services.

The M4 run used `scripts/gates/remote.sh` with the 20-minute job bound. Its upload began before the final applied-sequence fix; a hash-pinned source overlay applied that file before compilation or service startup. The runtime source-hash check, not the pre-overlay snapshot ID, identifies the code tested. The previous `r7/live-final/` proof belongs to b2d201ec6 and is not reused as proof of this head. The initial new attempt stopped before starting services because client declarations exposed a missing union narrowing check; the corrected run passed.

## Known follow-up

[Issue #451](https://github.com/Q9Labs/chalk/issues/451) records a separate crossed-reconnect counterexample found by scoped review. For A:1/stamp300, A:2/stamp100 and B:1/stamp200, different arrival orders can select different tabs. The 24 passing rows above do not prove that three-frame case. Its six-permutation production-helper reproduction is retained in `r9/crossed-stamps-repro.mjs` and `r9/crossed-stamps-results.json`; the current head does not converge. This is an unresolved product limitation, not a clean-review claim.

The same review found a direct-observation/relay-application freeze and invalid proof reuse when cached Bring becomes an ordinary view. The added rendered row proves the first fix; a real signer/verifier regression proves that Bring can be suppressed without allowing it to be added or its geometry changed. Both regressions fail before their fixes.
