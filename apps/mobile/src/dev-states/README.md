# Mobile state harness

Development route: `chalk://dev/states?codes=D1,P3,A2,V1`.

`App.tsx` requires this screen only under `__DEV__`. This screen requires `@q9labsai/chalk-react-native/dev` under the same guard. Release exports must pass `scripts/check-release-harness.mjs`; export both platforms with source maps so the scanner also checks module provenance.

The screen renders the real SDK `Chalk`, never a stand-in. Fixture clients open no live call or media devices. Development video slots draw deterministic flat colours, which are fixture content rather than product chrome. The supported SDK subset is D1/D2, O1, P1–P4, U1/U2, V1/V2, A2/A3/A5, T1/T5, C1 and join/leave events F5/F6. Other recognised mockup codes fail with an explicit SDK-adapter error. Unknown codes fail during parsing. New catalogue codes do not imply implemented SDK states.

UI-only state options are `sheet=more`, `sheet=people` and `menu=leave`. They call `setDevScenario`, and unmounting resets the scenario. Use U2 for the host Leave menu. The mockup catalogue is generated, not maintained by hand:

```sh
node apps/mobile/scripts/sync-mockup-codes.mjs /absolute/path/mobile-mockup.html
pnpm exec oxfmt --write apps/mobile/src/dev-states/codes.ts
node --import=tsx --test apps/mobile/scripts/harness.node-test.mjs
```

The harness installs `setMeasurementRegistry` before Chalk mounts. SDK refs supply native `measureInWindow` frames and flattened declared styles; the harness expands padding shorthands and View defaults. These are not computed/inherited native styles. Missing testIDs remain errors, not inferred values. Dumps include platform, full screen dimensions, pixel ratio and the measured root frame.

Append `dump=http://127.0.0.1:9876/dump&ids=frame.screen,frame.dock,dock.microphone` to upload a dump to the local collector. Only HTTP loopback hosts are accepted. iOS reaches an M4-local endpoint (or an SSH reverse tunnel); Android uses an adb reverse relay. No production endpoint is accepted.

`apps/mobile/scripts/capture-states.py` copies the exact lane source to its own M4 directory, rebuilds SDK JavaScript, leases a device slot, and starts Metro on the supplied port. `--client-cache` requires a matching native-input fingerprint and reuses the shared installed client without a native rebuild. Task-owned processes stop on success, failure, owner loss and the 40-minute session deadline. Persistent pooled devices shut down after a check and keep their installed client. Do not remove shared clients or pooled devices while other lanes need them.
