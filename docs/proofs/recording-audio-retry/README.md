# Recovering a temporarily missing recording microphone

This isolated qualification ran on Instabox on 26 October 2026. Two Pion publishers sent different synthesized speech through the real Cloudflare SFU. The capture claim used the dedicated Q9 proof tenant, not a customer tenant. One HTTP 200 `not_found_track_error` was injected for speaker B's first remote pull. All other signaling and RTP used the real provider.

The production capture attempt, Cloudflare adapter, Pion receiver, encrypted bundle writer, `recordingdecode.Write` and `NodeComposeProducer` ran unchanged. Lease/plan persistence, key storage, object upload and lifecycle callbacks were local test ports. The fixture stopped through the supported media-stopped signal. This is not a deployed end-to-end pipeline qualification; that runs after merge on the next nightly master cut, before promotion.

| Capture behavior                       | Before (master base)                        | After                                     |
| -------------------------------------- | ------------------------------------------- | ----------------------------------------- |
| Injected missing-publication responses | 1                                           | 1                                         |
| Captured microphone sources            | 1                                           | 2                                         |
| Speaker A RTP packets                  | 756                                         | 754                                       |
| Speaker B RTP packets                  | 0                                           | 635                                       |
| Final production-compositor MP4        | Not rendered: second-source assertion fails | 15.433 seconds, H.264 + stereo 48 kHz AAC |

The baseline used the same live fixture with the three production capture implementation files from base `587245789`. It failed specifically at `captured 1 sources, want two`, not at setup. The patched worker recovered B at the same plan revision, without another publication update. Separate calls have slightly different packet counts; these are presence checks, not throughput measurements.

## Audio evidence

- [Final MP4](recording.mp4)
- [ffprobe stream summary](ffprobe.json)
- [Per-second final-MP4 levels](audio-levels.csv)
- [Source and final-MP4 measurements](audio-proof.json)
- [Final-MP4 spectrogram](spectrogram.png)

Each speaker's speech contains a quiet identifier tone: A at 997 Hz and B at 1999 Hz. The measurement script decodes the final AAC, then measures one-second RMS windows through an 8 Hz bandpass around each identifier. This distinguishes the speakers in the mixed output; an audio-stream count alone would not.

| Measurement                                          |               A |               B |
| ---------------------------------------------------- | --------------: | --------------: |
| Decoded source interval (ms)                         |         0–15080 |      2394–15094 |
| Median source RMS (dBFS)                             |          -24.47 |          -23.45 |
| Final-MP4 identifier RMS, median seconds 6–14 (dBFS) |          -30.35 |          -30.22 |
| Final-MP4 identifier RMS, second 0 / 1 (dBFS)        | -30.69 / -30.30 | -60.44 / -63.96 |

B's final-mix identifier rises above its initial floor after recovery. Both speech-bearing sources and both identifiers survive the production decoder/compositor/AAC path. Measurements cover this one bounded call; they are not a performance benchmark.

## Rerun

Use a disposable Linux checkout with FFmpeg, espeak-ng, Node, pnpm and the repository's Go toolchain. Inject the SFU app ID/secret and dedicated Q9 fixture tenant ID into `CHALK_CLOUDFLARE_REALTIME_APP_ID`, `CHALK_CLOUDFLARE_REALTIME_APP_SECRET` and `CHALK_RECORDING_AUDIO_FIXTURE_TENANT`. Do not print or commit them.

```sh
pnpm install --frozen-lockfile
pnpm --filter @chalk/recording-renderer build
export CHALK_RUN_LIVE_RECORDING_AUDIO_PROOF=1
export CHALK_RECORDING_AUDIO_REPO="$PWD"
export CHALK_RECORDING_AUDIO_PROOF_DIR="$(mktemp -d)"
python3 scripts/recorder/audio-recovery-proof.py fixtures "$CHALK_RECORDING_AUDIO_PROOF_DIR"
GOTOOLCHAIN=auto GOMAXPROCS=2 go -C apps/api test ./internal/recorderworker -run '^TestLiveRecordingAudioRecoversMissingPublication$' -count=1 -v
python3 scripts/recorder/audio-recovery-proof.py measure "$CHALK_RECORDING_AUDIO_PROOF_DIR"
```

The live test has a two-minute context and closes its publisher and receiver tracks. HTTP/1 is selected for the isolated provider client because the Instabox HTTP/2 empty-body create-session request timed out. No deployed transport settings changed.
