# Packed web SDK consumer proof

This fixture packs `@q9labsai/chalk-client`, `@q9labsai/chalk-react` and their supporting archives, installs them in a temporary consumer outside the workspace, and bundles a browser app using package imports only. It never imports from the Chalk source tree. It uses the root `createSpaceClient` signature and the public `/effect` seam only to inject its protocol-faithful local adapters, then passes the canonical `SpaceClient` to the packed `Chalk`.

The browser proof uses a localhost Sync and WebRTC signaling mock, so it proves SDK lifecycle and browser media behavior without claiming traffic reached Cloudflare. Chromium runs the full two-context recovery matrix. Firefox and WebKit run the launch smoke when their Playwright binaries are installed; CI requires all three. No production proof runs from this fixture.

```sh
pnpm --dir tools/sdk-web-consumer-e2e test
```

Use `--skip-build` only after the client, React and supporting packages are already built.

## Media agreement

After join and after every microphone or camera toggle, `scripts/web-proof/agreement.mjs` compares each sender's local state with every observer's Sync-derived state, rendered badges, per-participant audio playback energy and advancing decoded video frames. The PR check runs the fault matrix in Chromium and Playwright WebKit with the `iPad Pro 11` profile, which is emulation, not a physical iPad.

```sh
node tools/sdk-web-consumer-e2e/scripts/run.mjs --browsers=chromium,webkit --agreement-only
```

Linux WebKit skips only the camera-frame assertion, a known engine stall (GStreamer negotiation failures); every microphone, control, projection and badge assertion stays on. `--agreement-fast` limits the matrix to join and toggles for the root gate.

The passive-projection cases intentionally fail against product code without the passive projection fix (#597). The fixture keeps physical publications separate from Sync projections: clearing prepared capture keeps the advertised publication, as the production adapter does, so the OS-ended-camera cleanup gap stays visible instead of being silently repaired.
