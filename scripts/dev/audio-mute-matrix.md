# React audio mute version matrix

This diagnostic runs four synthetic participants with distinct microphone tones
against one local API + Sync revision and a dedicated development Cloudflare SFU
app. It creates fresh Spaces and Episodes, leaves participants, and stops its
local stack. It never calls Episode end or deploys a service.

The normal profile lasts ten minutes per SDK: five eight-second self-mutes per
person, three teacher camera on/off cycles, and a five-second global UDP drop
plus one student's browser transport outage. The React control bar behavior
hook handles the microphone/camera clicks. Remote microphone tracks play in
audio elements, and receiver stats are mapped back to each speaker by the SDK
snapshot and receiver track identity.

Use a fresh Linux Instabox. Commit/push the harness first. The setup requires
the repository's installed workspace dependencies, Chromium, iptables, and the archived
Sync dependencies. `audio-mute-matrix-prepare.mjs` exports pinned React/server sources with
`git archive` and verifies published client tarballs against npm SHA-512 integrity.
It does not create or alter another checkout. Fetch the
`release/sdk-5.3.1` branch as well when using `box run` so that revision exists.
Install and resolve dependencies before recording a timed run.

Supply `CHALK_DEVELOPMENT_CREDENTIALS` as the absolute path to a private JSON
file containing `environment: "development"`, `source: "chalk-local-dev"`,
`appId`, and `appSecret`. Keep it outside Git and deliver it over SSH stdin
from a secret manager. Use only a verified development SFU app. Delete the
ephemeral machine and any temporary SFU app after collecting artifacts.

Run from the repository root in a login shell:

```sh
node scripts/dev/audio-mute-matrix-prepare.mjs
CHALK_DEVELOPMENT_CREDENTIALS=/tmp/development-sfu.json GOMAXPROCS=2 ERL_FLAGS='+S 2:2' node scripts/dev/audio-mute-matrix.mjs
node scripts/dev/audio-mute-matrix-report.mjs
```

`CHALK_MATRIX_VERSIONS` selects a comma-separated subset. `CHALK_MATRIX_SECONDS`
can shorten the run to a smoke check (minimum 60). Both settings change test
coverage; record them with the result. `CHALK_MATRIX_OUTPUT` selects the output
directory. The default is the ignored `artifacts/th-audio-1030-evening` directory.

`CHALK_MATRIX_MODERATOR=true CHALK_MATRIX_SECONDS=90` selects a separate probe:
the teacher mutes student 1 at 40 seconds; that student uses the React mic
control to unmute at 48 seconds. This exercises forced retirement separately
from self-mute. Save it to a separate output directory.

The report requires rising received packets and positive inbound `audioLevel`.
It integrates desired microphone state at the action timestamps, excludes the
first ten seconds of initial subscription warmup, and reports lost audio per
listener-speaker pair. Unmute latency is observed at approximately one-second
resolution. An unmute is unsuccessful if it has no audible sample before the
next mute or run completion. In-progress observations remain pending.

`sessionsPerParticipant` counts distinct issued SFU connection IDs, including
initial admission and subsequent access refreshes. Provider failures are read
from the local server's redacted logs, separately from browser API statuses:
Chalk's API status need not equal the upstream status. A 200 provider failure
can represent a partial remote pull error.

Versions 5.2.4–5.2.6 use the actual published client bundles, with pinned React
release source and the same installed dependencies. Version 5.3.1 uses pinned
source identical to master when checked. This does not measure acoustic speaker
output or simulate native microphone hardware mute and ended events. It uses the actual React control behavior hook in a minimal
consumer, rather than the complete portal layout. Raw artifacts remain ignored.
