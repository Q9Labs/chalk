# Sync entry and Leave ordering model

A TLA+ model of how Sync orders one person's socket entries against their Leave: only the newest confirmed entry may Leave, a newer issued entry defers that Leave, a newer confirmed entry supersedes it, and a claimed Leave blocks new entries. TLC checks four rules over every order of those steps, and checks that each of six broken variants of the code breaks its rule.

Run `./run.sh` (about 10 seconds, Java 11 or later). CI runs it when a covered Sync file changes. The rules, the coverage record, the sync commit and how to read a failure are in [`.agents/skills/sync-entry-leave-formal/SKILL.md`](../../../.agents/skills/sync-entry-leave-formal/SKILL.md).

`anchors` lists the code fragments each action mirrors; `run.sh` fails when one is gone. `breaks` lists the broken variants and the rule each must break.
