# Chalk web Space performance correction report (2026-08-26)

The corrected 30-minute workload is feature-green, and the isolated rendering
traces show large reductions in layout, paint, raster, commit, and GPU task
work. Aggregate Chromium CPU is higher because the corrected run keeps remote
media, screen share, Board, attachments, and re-entry working; the failed
baseline did not execute the same useful work, so its process CPU is not a
like-for-like improvement claim.

## Scope and validity

- Test surface: local Go API, Elixir Sync server, and Vite web app on the M4
  test Mac, backed by isolated PostgreSQL, Redis, and object storage.
- Final workload: four Chromium Participant pages, 24 complete cycles, and
  1,853.145 seconds of feature work.
- Sampling: 1,496 five-second samples, including 1,490 live samples, with no
  metric errors and at most 7 ms of schedule drift.
- Profiles: all four CPU profiles cover 1,856.5 to 1,856.8 seconds with 99.99%
  duration parity.
- Focused evidence: an isolated hardware-Metal trace pass and an isolated
  forced-GC heap-snapshot pass.
- Host load: average one-minute load was 3.166 on 10 logical CPUs and peaked at
  5.445.

The baseline raw profile is no longer present in the retained local or remote
run directories. Baseline numbers below therefore come from the canonical
checked-in pre-fix report, not a new analysis of the missing raw artifact.

## Durable artifacts

Raw artifacts remain untracked under `.private/chalk-perf/runs/`.

| Evidence | Run ID | Result |
|---|---|---|
| Final 30-minute runtime and CPU profiles | `profile-2026-08-25T22-32-32-712Z-uz58x1` | Passed; 24 cycles |
| Focused trace windows | `shakedown-2026-08-25T19-35-00-103Z-mim5kt` | Passed |
| Forced-GC snapshots | `shakedown-2026-08-25T19-37-37-808Z-nybrs4` | Passed |
| Final strict matrix | `shakedown-2026-08-25T21-44-33-351Z-aqdzqp` | Passed; five cycles |
| Final focused media churn | `shakedown-2026-08-25T21-41-42-507Z-8m7noz` | Passed; four rotations |

## Correctness result

The final profile records 970 steps and no feature failure. Tile drag remains
explicitly unsupported, while the local surface does not expose a Waiting
group or transcript control; these three dispositions are unchanged harness
findings rather than failed actions.

| Behavior | Pre-fix result | Final result |
|---|---|---|
| Microphone cycle | 7 passed, 19 failed | 24 cycles passed |
| Camera | Disable and remote playback failed | 24 initial-playback and 24 measured video windows passed |
| Screen share | Remote visibility failed | 24 share, zoom/pan, and stop cycles passed |
| Native File attachment | Staging failed | 24 initiate, upload, finalize, send, and remote receipt cycles passed |
| Board | First activation timed out | 24 local and remote collaboration cycles passed |
| Leave and re-entry | Re-entry timed out | Leave, remote removal, and visible re-entry passed |
| API/browser failures | 2,898 HTTP 503 and five HTTP 500 responses | No HTTP 4xx/5xx or fatal browser diagnostic |

The final API window contains 36 transient Cloudflare `track_not_found`
responses and no confirmed publication closure. All misses recovered through
identity-based partial pulls and bounded backoff; there was no provider
transport, timeout, connection-create, or track-close failure.

## Rendering result

Counts are normalized per Participant-second. The final screen-share trace is
valid shared-content rendering, while the baseline screen-share row measured a
failed wait and is not used for a before/after claim.

| Window | Layout | Update tree | Paint | Raster | Commit | GPU task | Peak layers |
|---|---:|---:|---:|---:|---:|---:|---:|
| Camera | -81.8% | -66.5% | -76.1% | -80.8% | -84.0% | +19.5% | 46 to 62 |
| Chat history scroll | -89.6% | -89.1% | -86.2% | -98.7% | -92.6% | -87.3% | 45 to 45 |
| Hand animation | -86.8% | -76.1% | -83.2% | -95.5% | -92.1% | -68.9% | 41 to 44 |
| Idle | -89.9% | -87.9% | -89.4% | -99.3% | -94.6% | -94.0% | 46 to 46 |
| Reaction animation | -55.9% | -63.1% | -78.7% | -85.8% | -90.9% | -56.6% | 40 to 40 |

The isolated traces support the intended rendering corrections: scroll reads
are coalesced, stable Stage and audio inputs avoid needless work, and visual
effects no longer drive the previous layout and paint cadence. Camera GPU task
count rises despite reductions in every main-thread and paint counter, so the
camera compositor path remains the next isolated optimization target.

## Runtime counters and CPU

Endpoint layout rates fell on every Participant page even though the final run
successfully exercised more media and Board work.

| Participant | JS heap endpoint | DOM nodes | Layouts/min | Style recalculations |
|---|---:|---:|---:|---:|
| Avery | 68.5 MB to 61.5 MB | 62,437 to 59,743 | 1,959.6 to 1,296.7 | 88,924 to 54,752 |
| Blake | 159.8 MB to 86.9 MB | 48,570 to 46,901 | 3,299.7 to 1,161.7 | 113,423 to 39,406 |
| Casey | 52.1 MB to 51.4 MB | 518 to 65 | 3,221.5 to 517.8 | 104,904 to 16,595 |
| Devon | 71.8 MB to 151.1 MB | 956 to 1,160 | 3,172.0 to 500.0 | 103,032 to 16,098 |

Devon's larger heap endpoint now includes the Board and media paths that did
not complete in the baseline. The forced-GC panel evidence below is the safer
retention comparison.

| Process | Pre-fix average CPU | Final average CPU | Final peak CPU |
|---|---:|---:|---:|
| Renderer aggregate | 44.799% | 78.987% | 157.769% |
| GPU | 22.703% | 30.443% | 41.591% |
| Browser | 2.407% | 2.900% | 15.868% |
| Audio utility | 6.281% | 9.379% | 11.104% |
| Network utility | 0.824% | 3.575% | 5.756% |
| Capture utility | 0.672% | 0.872% | 1.148% |

The process table is a capacity result, not a regression attribution: the
baseline spent much of its run retrying failed control-plane work without
decoding the intended remote media or completing the feature matrix. A future
like-for-like CPU target needs a green baseline workload.

The clearest CPU-profile improvement is chat time formatting.
`formatMessageTime` falls from 2,187 ms to 103.724 ms on Avery and from 1,322 ms
to 40.527 ms on Blake, reductions of 95.3% and 96.9%. No matching chat hotspot
appears on Casey or Devon.

## Forced-GC heap result

No detached-DOM class appears in the final panel diffs. Baseline-to-closed
totals are:

| Panel | Pre-fix nodes | Final nodes | Pre-fix self size | Final self size |
|---|---:|---:|---:|---:|
| Chat | +50,598 | +28,025 | +4,889,520 B | +4,536,229 B |
| Participants | +10,380 | +25,604 | +584,988 B | +905,090 B |
| Settings | +10,859 | +14,101 | +787,319 B | +860,669 B |
| Info | +5,318 | +5,706 | +254,331 B | +218,764 B |
| Reactions | +2,915 | +3,459 | +298,136 B | +371,174 B |

Chat closes with 44.6% fewer nodes and 7.2% fewer retained bytes. Info retains
14.0% fewer bytes. Participants, Settings, and Reactions rise by about 73 KB to
320 KB each in absolute retained size, without detached DOM; these panels need
production-build heap evidence before further retention work is justified.

## Bottom line

Ship the correctness and isolated rendering corrections: the complete feature
matrix is green and the targeted rendering costs fall sharply. Do not claim a
whole-run CPU reduction until a second green workload provides a like-for-like
baseline; camera GPU work and the modest panel-retention increases are the
conditions that would reopen performance tuning.
