# Recording pipeline model

A TLA+ model of one Chalk recording as it moves across Sync and the API: the Sync `sync_recordings` row, the API `recording_pipelines` row, the capture job lease and the capture nodes that claim it, the segments they write, and the Episode end that stops it all. TLC checks that only the live lease holder writes segments, that no claim steals a live lease or starts a fresh capture after a stop, that segments freeze when capture completes, that a lost final segment is always marked salvaged, and that an ended Episode leaves no recording running.

Run `./run.sh` (a few minutes, Java 11 or later). CI runs it when a covered file changes. The rules, the coverage record, the sync commit and how to read a failure are in [`.agents/skills/recording-pipeline-formal/SKILL.md`](../../../.agents/skills/recording-pipeline-formal/SKILL.md).

`anchors` lists the code fragments each action mirrors; `run.sh` fails when one is gone. `breaks` lists the broken variants and the rule each must break.
