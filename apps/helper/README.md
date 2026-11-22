# Run Chalk Helper for development

The fixture runs without a call or browser pairing. Managed desktop ink requires a verified Chromium monitor or window share. Use the annotated preview or Document Picture-in-Picture when Helper cannot verify the source or exclude its ink from the outgoing video.

## Build and run

On macOS, from `apps/helper`:

```sh
npx --yes @tauri-apps/cli@2.12.6 build --debug --ci --bundles app --features fixture
src-tauri/target/debug/bundle/macos/Chalk\ Helper.app/Contents/MacOS/chalk-helper --fixture
```

On Windows, install the Tauri v2 desktop prerequisites. Build with the same command, replacing `--bundles app` with `--bundles nsis`. The local installer is under `src-tauri/target/debug/bundle/nsis/`. These builds have no distribution signature. Do not distribute them. The **Helper development installers** workflow can build the same fixture on either platform. Leave all inputs blank for the offline fixture, then launch with `--fixture`. Supply all four inputs for a test deployment and omit `--fixture` when you launch it.

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

Set these build-time values before you build Helper:

- `CHALK_HELPER_WEB_ORIGIN`: the exact Chalk HTTPS Origin, also allowed by the managed API.
- `CHALK_HELPER_PAIR_TICKET_PUBLIC_KEY`: the base64url, unpadded Ed25519 public key for the managed Sync token issuer. Do not copy its private key to a Helper machine.
- `CHALK_HELPER_SYNC_ORIGIN`: the WSS Origin that routes `/v1/screen-annotation/helper` to Sync, without a path or query. A host that serves only the call socket cannot attach Helper.
- `CHALK_HELPER_API_ORIGIN`: the exact HTTPS Origin for the managed API, without a path or query. This enables device-code sign-in.

Set `VITE_CHALK_HELPER_INSTALL_URL` in the web app to enable the Helper offer. Run Helper without `--fixture`. In a signed-in call, share your monitor and compare the fingerprints in the browser and Helper. Click **Allow** in Helper, enter the native confirmation code in the browser, and select the actual shared display in Helper. Guest sharers use the call preview instead. The browser briefly disables the outgoing track while it reads three landmarks from a local clone. Helper enables ink only after it verifies the OS protection setting and the browser confirms that the landmarks disappeared. If you see **Draw one mark**, click it to draw a fading mark on the selected display. Helper sends that mark through the same call and returns to click-through mode.

For a window share, choose **Follow captured window** in Helper. The classic Chromium picker must identify the native window and the browser preview must match three locally sampled landmarks. Protected ink moves with the window. Helper hides ink when the window minimizes, moves off the current desktop, is covered, or needs recalibration after a resize. A monitor share stays on the selected display; ink does not follow individual windows inside it. Tab shares and opaque native picker sessions use the preview. Helper does not request Accessibility. On macOS, allow Screen Recording for Helper when you choose to follow. Background checks never ask for permission.

If loopback is unavailable, open **Use a device code** in the signed-in call. Paste the displayed account ID into Helper and click **Get a device code**. Enter the code in the same call and compare the fingerprints before approving. macOS limits automatic Keychain access to Helper. On Windows, Credential Manager stores ciphertext that needs a non-exportable Windows key with user confirmation. If the operating system cannot protect the credential, use the call preview. Device codes do not enable native ink, and credential rotation is not part of this release. Disconnect the current share with **Disconnect** or revoke the persistent registration under **Dashboard → AI apps → Chalk Helper devices**.

The local listener binds only `127.0.0.1:47361`. It requires the exact Origin and Host, a signed single-use pair ticket, and native consent. It renews the lease with fresh tickets while its browser and publication stay current. The remote Sync ticket has a separate audience and uses an Ed25519 proof bound to the server socket nonce.

The updater is off unless you set both `CHALK_HELPER_UPDATE_ENDPOINT` and `CHALK_HELPER_UPDATE_PUBLIC_KEY` at build time. Use an HTTPS manifest and the Tauri artifact verification key for that release channel. The development installer workflow publishes no releases.
