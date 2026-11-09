# Join-stall lane

Reproduces remote video that freezes for 10-40 s during a call on the nightly web and staging own SFU, and reads the node's reason. Every run touches the staging SFU, so it holds the lease; run the heavy part on an Instabox machine (8 vCPU / 16 GB) and delete it afterwards.

Finding so far: the stalls are SFU congestion pauses. At the pause the node's estimate is 370-620 kbps with no host pressure, while the receiver counts 0 lost packets and 0 NACKs. Quiet and CPU-loaded receivers both stall (192-352 s stalled per 3-guest UI run).

## Setup, once per machine

1. Create the machine and put the repo checkout at `/data/home/work` (this branch, `pnpm install`, Playwright Chromium installed).
2. Copy `ui/` to `/data/home/ui` on it (UI flow only), and this folder's scripts to `/tmp/w` locally (`cp -r scripts/prod-proof/join-stall-lane/* /tmp/w/`).
3. Locally, `export KEY=...` (the nightly proof Tenant credential) and have `gh` and `instabox` logged in.

## Run

`run.sh <box> "<cases>"` takes the lease, runs each case on the box, and copies the evidence to `/tmp/w/<tag>/`. A case is `tag:busy-loops:late-ms[:guests]`.

```sh
# UI flow, quiet, 3 guests (u5-style): tags starting with "u" use the public invite and clicks
READLOGS=1 /tmp/w/run.sh <box> "u5:0:0"

# SDK harness, quiet, 3 guests, third guest joins 25 s later
/tmp/w/run.sh <box> "q3:0:25000"

# Guest count 2, 4, 8 with node log read after the last case
READLOGS=1 /tmp/w/run.sh <box> "g2:0:25000:2 g4:0:25000:4 g8:0:25000:8"
```

Busy loops (second field) add CPU load on the box; use 0 for quiet.

## Read the result

- `python3 an-stall.py <tag> 3` lists UI-flow stalls of 3 s or more per received video track, with packets, keyframes and PLIs in each stall.
- `python3 an.py <tag>/join-stall.json` gives first packet, first keyframe and first decoded frame per track, plus stalls, for the SDK harness.
- `READLOGS=1` writes the node's congestion pause and resume lines and its 10 s media telemetry to `/tmp/w/node-pauses.jsonl` (needs the operator SSH key and the staging address in `~/.config/chalk-sfu/staging`). Compare pause counts with the client stalls of the same time window.

An "after" row means the same cases on the same box size, so compare stalled seconds and pause counts per run.
