# Episode lifecycle model

A TLA+ model of one Chalk Episode from admission to its end, with the steps that can race an end: joins, knock admissions, Leaves, deadline changes, a host pressing End and the maximum-duration end. TLC checks four rules over every order of those steps, reports one rule the real code breaks today, and checks that each of six broken variants of the code breaks its rule.

Run `./run.sh` (under a minute, Java 11 or later). CI runs it when a covered file changes. The rules, the finding, the coverage record, the sync commit and how to read a failure are in [`.agents/skills/episode-lifecycle-formal/SKILL.md`](../../../.agents/skills/episode-lifecycle-formal/SKILL.md).

`anchors` lists the code fragments each action mirrors; `run.sh` fails when one is gone. `breaks` lists the broken variants and the rule each must break. `findings` lists a rule the real code breaks today; `run.sh` reports it and stays green, and fails once the rule holds.
