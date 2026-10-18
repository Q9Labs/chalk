# Mobile state harness

Development route: `chalk://dev/states?codes=D1,P3,A2,V1`.

`App.tsx` uses a `__DEV__`-guarded require so Metro can remove the entire dependency graph in release. `scripts/check-release-harness.mjs` scans exported bundles and fails on fixture markers; a directory with no bundles also fails.

The checked-in code list is generated from the mockup's scenario table, not maintained by hand:

```sh
node apps/mobile/scripts/sync-mockup-codes.mjs /absolute/path/mobile-mockup.html
pnpm exec oxfmt apps/mobile/src/dev-states/codes.ts
node --import=tsx --test apps/mobile/scripts/harness.node-test.mjs
```

Fixtures port the web preview client's public `SpaceClient` projection and its whiteboard transport. They open no live call or media devices. The native stand-in draws flat silhouettes with Views. `scenarioForCodes` preserves UI-only states (name, knocking, refused, hold, full), share aspect, speaking level, conditions, and event codes: the public client snapshot does not represent all of these.

Until foundation exports `Chalk`, the route explicitly shows **Harness stand-in · SDK Chalk is not available**. Its sheet and drag are tooling demonstrations, not SDK implementation or parity evidence. If `Chalk` appears without a scenario adapter, this route fails explicitly. The UI-only scenario model, fake-video renderer, and all non-client conditions still need a typed SDK integration seam; do not treat stand-in screenshots as completed call-state coverage. F13 fails explicitly because the client chat model has no reactions.

`MeasuredView` and `MeasuredText` register native screen-point frames and flattened declared props, not computed/inherited native styles. Padding shorthands are expanded. A deep link may include `dump=http://127.0.0.1:9876/dump&ids=harness.ready,frame.dock`. Missing IDs are explicit errors. Dumps include platform, screen dimensions, scale and measured root frame. The HTTP collector is in the scratch parity folder. iOS uses localhost through an SSH reverse tunnel; Android uses `10.0.2.2`. Only those loopback hosts are accepted.

SDK primitives need measurement registration at their actual host refs and rendered styles. Do not copy the mockup values into a dump or infer a child's style from its parent. The app-owned wrapper is not yet an SDK instrumentation API: foundation must agree the injection seam before the seed IDs can report actual values.
