# Packed web SDK consumer proof

This fixture packs `@q9labsai/chalk-client`, `@q9labsai/chalk-react`, and their
supporting package archives, installs them in a temporary consumer outside the
repository workspace, and bundles a browser application using package imports only.
It never imports from the Chalk source tree. The fixture uses the root
`createSpaceClient` signature and public `/effect` seam solely to inject its
protocol-faithful local adapters, then passes the canonical `SpaceClient` to the
packed root `Chalk`; this exercises the public SpaceClient integration. The
access endpoint forwards an opaque `AccessGrant`; only the packed client
validates it.

The browser proof uses a localhost, protocol-faithful Sync and WebRTC signaling
mock. It proves SDK lifecycle and browser media behavior without claiming that
traffic reached Cloudflare. Chromium runs the complete two-context recovery
matrix. Firefox and WebKit run the launch smoke when their local Playwright
binaries are installed; CI installs and requires all three browsers. Every engine
also uploads a browser File through the real HTTP attachment transport and
decodes its Chat preview. The local storage fixture checks the uploaded byte
count and SHA-256 digest before finalization. Chromium verifies the preview in
the other Participant's Chat panel.

Run the complete proof from the repository root:

```sh
pnpm --dir tools/sdk-web-consumer-e2e test
```

Use `--skip-build` only after the client, React, and their supporting packed
packages have already been built.

# Media agreement

The required Chromium consumer check now verifies both participants after join
and after every microphone/camera toggle. `scripts/web-proof/agreement.mjs`
compares each sender's local state with every observer's Sync-derived state,
rendered badges, per-participant audio playback energy, and advancing decoded
video frames. It samples actual AudioOutput sinks, not aggregate RTP counters.
Synthetic camera frames keep changing; synthetic audio is a continuous tone.

The existing packed-artifacts PR check also runs the fault matrix in Chromium
and Playwright WebKit with the full `iPad Pro 11` device profile (touch, mobile,
viewport, scale and user agent). This is WebKit emulation, not a physical iPad.

```sh
node tools/sdk-web-consumer-e2e/scripts/run.mjs --browsers=chromium,webkit --agreement-only
```

Faults cover independent dropped/delayed/rejected Sync media projections,
Sync reconnect during unmute, OS microphone mute/end, media-only recovery
unavailable for 12 seconds (both a held dial and repeated 503s), current-binding
SFU 401/403, and same-participant tab
takeover during recovery. Each scenario reports its duration, continues after
failures to collect the remaining cases, and checks agreement after recovery.
Current authorization denial must terminate with truthful UI and released
resources; agreement is checked again after a fresh authorized join.
`--agreement-fast` limits this to join/toggles for the root gate.

The fixture deliberately separates physical publications from Sync projections.
It exercises the real packed SpaceClient and React UI, but replaces the provider
and Sync transport adapters. The SDK selector regression in
`sdks/typescript/client/src/space-client/media-agreement.test.ts` independently checks the
real SDK selectors against split SFU/Sync snapshots. The release web proof runs
the actual call test in Chromium and WebKit; the production SDK proof also saves
the media-agreement JSON artifact. No production proof is run by the packed fixture.
