# Reproduce a partial receive stall

Run this on a dedicated Linux Instabox with workspace dependencies, Chromium,
Go, Elixir dependencies, and the local Postgres/Redis tools installed. Commit
and push the branch before using `box run --keep`. No production or staging
service is used.

Create a disposable development SFU app. Deliver its credentials privately to
`CHALK_DEVELOPMENT_CREDENTIALS`, a mode-0600 JSON file with `environment` set to
`development`, `source` set to `chalk-local-dev`, and `appId`/`appSecret`.
Never commit that file or the raw artifacts.

```sh
node scripts/dev/receive-partial-prepare.mjs
CHALK_DEVELOPMENT_CREDENTIALS=/tmp/development-sfu.json node scripts/dev/receive-partial.mjs
node scripts/dev/receive-partial-report.mjs artifacts/receive-partial
```

Preparation pins master at `3f9fe4385` and the fixed SDK at HEAD; use
`CHALK_PARTIAL_FIX_REF` to select another fixed commit. The saved manifest is
used by the run, so a later HEAD change cannot relabel the prepared sources.
The local server stays fixed at the feature branch revision, including its
receive-only close support, for both SDKs. There is no deployment.

Each of six interleaved runs gets a new Space and Episode, one owner and three
collaborators, and distinct tones at 440/660/880/1100 Hz. The actual React
control-bar hook handles six mute/unmute cycles. At 60 seconds, a private
provider call force-closes exactly student 2's receive MID on student 1.
Other publications and listener connections are untouched. Each run lasts
150 seconds; `CHALK_PARTIAL_SECONDS` and `CHALK_PARTIAL_VERSIONS` select a
longer run or a subset.

Receiver stats are sampled every 250 ms and mapped by native track identity.
Audibility requires positive packet progress and audio level on a live,
unmuted track. Lost pair-seconds exclude the first ten seconds and intentional
mute intervals. Recovery is the first four consecutive audible samples after
a post-fault silence; the first second after injection is excluded when
finding that silence to avoid counting buffered audio as recovery. Unmute
latency starts immediately before the React button click. These measurements
have sampling and browser-scheduling uncertainty; they are not recordings of
the output device. Inspect `preFaultAudiblePairs`, errors, every run's pair
breakdown, session counts and provider receive-allocation states before using
an aggregate.

The harness leaves synthetic participants and stops its local stack. It does
not call Episode end. Delete the disposable SFU app and Instabox after copying
private results. A forced close simulates a lost subscription; it does not
prove the cause of Cloudflare's intermittent HTTP-200 partial pull failures.
