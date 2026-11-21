# Run Chalk Helper for development

This build keeps live native ink off. The fixture does not join a Space or accept browser pairing. Use the in-call preview for a real share while capture exclusion and publication binding remain unverified.

## Build and run

On macOS, from `apps/helper`:

```sh
npx --yes @tauri-apps/cli@2.12.6 build --debug --ci --bundles app --features fixture
src-tauri/target/debug/bundle/macos/Chalk\ Helper.app/Contents/MacOS/chalk-helper --fixture
```

On Windows, install the Tauri v2 desktop prerequisites. Build with the same command, replacing `--bundles app` with `--bundles nsis`. The local installer is under `src-tauri/target/debug/bundle/nsis/`. These builds have no distribution signature. Do not distribute them.

If `packages/screen-annotation` is present, Tauri bundles its renderer and Figtree font. To build against Lane 2 before integration, set `CHALK_HELPER_RENDERER_SOURCE` to a local copy of that package. If neither is present, the development fixture uses a sample stroke painter.

## Probe outgoing video

1. Serve `probe/index.html` from a numeric loopback HTTP origin. Open it in the shipping browser under test.
2. On macOS, compile the probe with `swiftc -parse-as-library probe/mac.swift -o /tmp/chalk-capture-probe`. Run it with `--unprotected` first. On Windows, run `probe/windows.ps1 -Unprotected` from an interactive desktop.
3. For each browser and capture source, place the shared window underneath the visible marker. Click **Start capture probe** and select the source. The page counts marker pixels from a decoded WebRTC receive track. No screenshot leaves the machine.
4. Repeat without `--unprotected` or `-Unprotected`. Record browser and OS builds, reported surface, whether the marker was visually present locally, and the six samples. Confirm a target match separately. A hidden, wrong, or unconfirmed source is not a pass. Window and tab capture can exclude the marker by sampling only the target. Record that separately from a successful full-display exclusion.
5. Run the Mac probe with `--filtered --unprotected` to compare an all-windows capture with a capture that excludes the probe app. This path requests macOS Screen Recording consent, not Accessibility.

## Probe a filtered track handoff

Build the local receiver from `apps/api` with `go build -o /tmp/chalk-webrtc-probe ../helper/probe/webrtc.go`. Use the repository's existing Pion version. Then run:

```sh
/tmp/chalk-capture-probe --stream-filtered | ffmpeg -f rawvideo -pixel_format bgra -video_size 1280x720 -framerate 15 -i pipe:0 -c:v libvpx -deadline realtime -flush_packets 1 -f ivf pipe:1 | /tmp/chalk-webrtc-probe
```

Open the one-use local URL printed by the receiver. Click **Receive filtered screen track**. The receiver negotiates a video-only WebRTC track from the filtered stream. This does not change the Chalk SDK's publisher. Stop the pipeline when finished. Do not use the probe for a real share.

## Configure a local pairing build

Set `CHALK_HELPER_WEB_ORIGIN` to an exact HTTPS origin and `CHALK_HELPER_PAIR_TICKET_PUBLIC_KEY` to its pinned base64url Ed25519 verification key at build time. Run the app without `--fixture`. The proof listener binds only `127.0.0.1:47361`. It accepts a signed ticket and local approval, returns a short-lived session secret, and only reports `unbound`. No managed API issuer, device-code fallback, attachment refresh, or annotation input is wired in this build.

The updater is off unless you set both `CHALK_HELPER_UPDATE_ENDPOINT` and `CHALK_HELPER_UPDATE_PUBLIC_KEY` at build time. Use an HTTPS manifest and the Tauri artifact verification key for that release channel. The development installer workflow publishes no releases.
