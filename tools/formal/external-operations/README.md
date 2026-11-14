# Sync external-operation queue model

A TLA+ model of how Sync takes a media source away from a person and how it grants one: role transitions (`role_transition_source_stop`), publication grants and fences, `remove_participant` and end-Episode operations, and the provider-lane consumer in `apps/sync` that claims an operation, calls the SFU and finalizes in a separate transaction. TLC checks five rules over every order of those steps, with nodes that can stop, claims that expire, requests that expire and provider answers that arrive late or never.

Run `./run.sh` (about 2 minutes on the Mac mini, Java 11 or later; `--deep` adds a third attempt and a fifth control revision). CI runs it when a covered Sync file changes. The rules, the findings, the coverage record and how to read a failure are in [`.agents/skills/external-operations-formal/SKILL.md`](../../../.agents/skills/external-operations-formal/SKILL.md).

- `ExternalOperations.tla` and `ExternalOperations.cfg` are the model and its base settings. Each run picks one operation (`rt`, `rem` or `end`), because all three at once is more than the model can enumerate.
- `anchors` lists the code fragments each action mirrors; `run.sh` fails when one is gone.
- `breaks` lists the broken variants of the code and the rule each must break.
- The three bugs the model found are fixed. `breaks` keeps each as a broken variant, and `apps/sync/test/chalk_sync/external_operations_findings_test.exs` tests each against the real code and Postgres.
- `ExternalOperations.chart.cfg` and `ExternalOperations.view.mjs` give `/statechart` the words of a person in the call, to read a failing run.
