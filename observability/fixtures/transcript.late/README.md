# transcript.late fixtures

The positive and healthy fixtures are not written by hand. They are the telemetry rows of a real local-stack capture — the
worlds committed under `scripts/transcription-dispatcher/chain-inputs/` were read from Postgres, the API log, the chunk and
finalize lambdas and R2 during one recorded run — carried from hop to hop through the hand-off files in `chain/`. Each hop is
a test that reads committed capture inputs and compares what it produces with the committed files, so a hop that renames a
field, drops one or changes a value fails its own test.

1. Hop (a), `scripts/transcription-dispatcher/transcript.late.fault.test.mjs`, reads the captured world
   `chain-inputs/transcript.late.positive.mjs` (a finalize job's transcription completes more than sixty minutes after creation) and the healthy capture
   `chain-inputs/transcript.late.healthy.mjs` (a finalize job that claimed, finalized and completed with a readable transcript), asserts the fault conditions still hold, converts the
   evidence reader's observations back into the telemetry rows they stand for and writes them to
   `chain/<source>-rows.<run>.json` grouped by witness source. Where a declared witness event or field appears in no
   captured row — the claim sweeps' `reason_code`, first-retry attribution, lease expiry on a finished job, a finalize retry
   that never happened, a document read the run never reached — the test adds rows from two clearly separated files:
   `chain/witness-rows.positive.json` holds real rows other items emitted in the same captures plus the real
   `transcript.*claim` none-sweep lines from the API log, and `chain/coverage-rows.positive.json` holds the minimal
   synthetic rows for what no run produced, each marked by a minted subject id so it can never bind to the item under test.
2. Hop (b), `scripts/transcription-dispatcher/transcript-fixtures-chain.test.mjs`, assembles the fixture from its chain row
   files, judges it with the symptom's rule through the real kernel and writes `positive.json` and `healthy.json`. The
   healthy fixture relies on synthesized complete watermarks for absence proofs.

`chain/hops.json` declares each hop's test, its command and the files it writes. Each fixture lists its hand-off files under
`chain`, and `node scripts/gates/obs-coverage.mjs` fails when a fixture's rows are not exactly those files' rows, when the
first hop is not the fault scenario, or when a file in `chain/` or a fixture is written by no hop.

The ids and clocks come straight from the captures, so the hops write the same files on every run.
`node scripts/gates/obs-chain-replay.mjs transcript.late` runs the hops in order in write mode and fails when any of them writes a
file that differs from the committed one, skips, or fails. To rewrite the files after a deliberate change, run each hop's
command from `chain/hops.json` with `CHALK_CHAIN_WRITE=1` in order.
