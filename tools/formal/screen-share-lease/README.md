# Screen-share lease model

A TLA+ model of the screen-share lease of one Chalk Episode: the `sync_screen_share_leases` row and the `Live.Episode` process that acquires, renews and releases it while it follows the media plane's observations. TLC checks four rules over every order of those steps, reports two rules the real code breaks today, and checks that each of three broken variants of the code breaks its rule.

Run `./run.sh` (about a minute, Java 11 or later). CI runs it when a covered file changes. The rules, the findings, the coverage record, the sync commit and how to read a failure are in [`.agents/skills/screen-share-lease-formal/SKILL.md`](../../../.agents/skills/screen-share-lease-formal/SKILL.md).

`anchors` lists the code fragments each action mirrors; `run.sh` fails when one is gone. `breaks` lists the broken variants and the rule each must break. `findings` lists the rules the real code breaks today; `run.sh` reports them and stays green, and fails once a rule holds.
