# Public invite access model

A TLA+ model of one guest who arrives through a Space's public invite, in the Go API: the invite and its generation, the arrival, the Sync admission request and the host's decision, the grants the API issues, and the auto Space lifecycle worker that ends the call and archives the Space. TLC checks both admission modes, `knock` and `open`. It checks that a guest is admitted only while the invite, Space, Episode and arrival they knocked on are still valid, that a request has one decision, that a terminal arrival never changes, that no knock or join works in an archived Space, and that a refresh token goes only to a live participant. One rule does not hold on the real code: an archived auto Space can still have an active Episode. `findings` records it, and `run.sh` checks that it still breaks.

Run `./run.sh` (a minute or two, Java 11 or later). CI runs it when a covered file changes. The rules, the coverage record, the sync commit and how to read a failure are in [`.agents/skills/public-invite-access-formal/SKILL.md`](../../../.agents/skills/public-invite-access-formal/SKILL.md).

`anchors` lists the code fragments each action mirrors; `run.sh` fails when one is gone. `breaks` lists the broken variants and the rule each must break. The Go replay of the finding is `TestFormalFindingArchiveLeavesActiveEpisode` in `apps/api/internal/adapters/postgres`.
