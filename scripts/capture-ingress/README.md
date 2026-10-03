# Capture ingress qualification

This opt-in integration harness publishes only an animated synthetic camera through the real web SDK and the local-development Cloudflare Realtime app. It compares simultaneous omitted and `h` / `none` / `asciibetical` pulls of that camera. It runs Capture’s real Pion adapter, packet admission and track clock without writing a bundle.

Start the documented development stack in this checkout:

```sh
CHALK_DEV_API_PORT=18080 CHALK_DEV_WEB_PORT=13070 pnpm dev
```

With `agent-browser` installed, run one bounded measurement into a **new private directory**:

```sh
CHALK_RUN_LIVE_SFU_CAPTURE_TEST=1 node scripts/capture-ingress/run.mjs .private/ingress-no-rtx
python3 scripts/capture-ingress/analyze.py .private/ingress-no-rtx > .private/ingress-no-rtx/summary.json
```

The runner reuses the exact SFU credentials already selected by its ready development stack’s credential resolver, which rejects production-marked apps. It does not select a second app or perform another credential lookup while publishing. It requires the ready stack to belong to this checkout. Credentials are read once from the owned runtime and cached in a mode-0600 file inside the private run directory; the finalizer deletes it. No additional `op` call is needed. The runner creates a unique browser instance and closes it, the test process, its access server and synthetic Episode in a finalizer; it also has owner-loss and maximum-lifetime guards. Stop the stack with `pnpm dev:stop` afterwards. Never use production credentials or real camera/microphone media.

Both subscriptions run for 180 seconds, with a 250 ms read deadline and the release-default 10-second keyframe interval. At 60 seconds, the publisher disables `h` and caps `l` at 80 kb/s for 45 seconds, then restores both layers. The SDK supplies the real `h` and `l` encodings.

Each subscription is bounded to 500,000 header records. Artifacts contain arrival times, RTP/RTX header attribution, VP8 descriptor metadata, run-local salted payload fingerprints, admission results and normalized timestamps. No media payload, complete SDP, credentials or reusable fingerprint salt is retained after cleanup. Keep all artifacts outside Git. The Go test also requires `CHALK_INGRESS_MEASUREMENT=1` and skips under `go test -short`.

The analyzer excludes empty payloads from video-repeat and PictureID counts, but includes their sequence positions when counting gaps. Unrepaired positions are holes between the first and last primary RTP sequence observed, after all admitted repairs; these are receiver-side sequence gaps, not an end-to-end publisher loss estimate. A regression can also be legitimate packet reordering, so inspect the admission and RTX counters together. This harness does not measure decoded video freeze duration.
