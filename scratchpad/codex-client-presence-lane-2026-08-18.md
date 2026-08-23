# Client Participant presence lane

## Files changed

- `sdks/typescript/client/src/space-client/types.ts` — added `ParticipantPresence` and required `Participant.presence`.
- `sdks/typescript/client/src/space-client/index.ts` — re-exported `ParticipantPresence`.
- `sdks/typescript/client/src/space-client/participants-controller.ts` — projected sync presence, added unknown fallbacks, and compared presence in roster equality.
- `sdks/typescript/client/src/space-client/controller-parity.test.helpers.ts` — allowed test snapshots to provide a presence projection.
- `sdks/typescript/client/src/space-client/participants-controller.test.ts` — added four presence projection and update-propagation tests.
- `sdks/typescript/react/src/__tests__/bindings.test.tsx` — added presence to two client roster fixtures.
- `sdks/typescript/react/src/components/participants-panel/participant-volume-context.test.tsx` — added presence to two client roster fixtures.
- `sdks/typescript/react/src/components/participant-grid/participant-grid.test.tsx` — added presence to the three roster fixtures.
- `sdks/typescript/react/src/selectors/space-selectors.test.ts` — added presence to the client Participant helper.
- `sdks/typescript/react-native/src/components/native-space-view/useSpaceViewController.test.ts` — added presence to the client roster fixture.
- `apps/web/src/components/sdk-preview/SdkPreviewGallery.tsx` — projected preview speaking into presence and set active speaker to false.
- `apps/mobile/src/dev-preview/sdk-preview-store.ts` — added connected/default-false presence to preview roster entries.
- `scratchpad/history/2026-W34.md` — condensed implementation milestones.

Pre-existing dirty files were preserved. Nothing was staged or committed.
No dependencies were added.

## New tests

- `projects participant presence from the presence projection`
- `uses unknown participant presence when the presence projection is null`
- `uses unknown participant presence when a participant is missing from the presence projection`
- `publishes a new participants slice when only participant presence changes`

## Verification tails

### `pnpm --filter ./sdks/typescript/client test` — exit 0

```text
> @q9labsai/chalk-client@4.0.1 test /Users/macmini/code/chalk/sdks/typescript/client
> pnpm exec vitest run


 RUN  v4.1.10 /Users/macmini/code/chalk/sdks/typescript/client


 Test Files  78 passed (78)
      Tests  401 passed (401)
   Start at  18:34:56
   Duration  2.47s (transform 2.06s, setup 0ms, import 9.96s, tests 3.41s, environment 5ms)
```

### `pnpm --filter ./sdks/typescript/client check-types` — exit 0

```text
> @q9labsai/chalk-client@4.0.1 check-types /Users/macmini/code/chalk/sdks/typescript/client
> tsc --project tsconfig.check-types.json --noEmit
```

### `pnpm --filter ./sdks/typescript/client lint` — exit 0

```text
> @q9labsai/chalk-client@4.0.1 lint /Users/macmini/code/chalk/sdks/typescript/client
> pnpm exec oxfmt --check . && tsc --project tsconfig.check-types.json --noEmit

Checking formatting...

All matched files use the correct format.
Finished in 137ms on 199 files using 10 threads.
```

### `pnpm --filter ./sdks/typescript/react check-types` — exit 0

```text
> @q9labsai/chalk-react@4.0.1 check-types /Users/macmini/code/chalk/sdks/typescript/react
> tsc --project tsconfig.check-types.json --noEmit
```

### `pnpm --filter ./sdks/typescript/react-native check-types` — exit 0

```text
> @q9labsai/chalk-react-native@4.0.1 check-types /Users/macmini/code/chalk/sdks/typescript/react-native
> tsc --project tsconfig.check-types.json --noEmit
```

### `pnpm --filter ./apps/web check-types` — exit 2 (pre-existing error)

```text
> web@0.1.0 check-types /Users/macmini/code/chalk/apps/web
> tsc --project tsconfig.check-types.json --noEmit

src/lib/chalk-access.test.ts(81,11): error TS2322: Type 'AccessGrantSource' is not assignable to type 'AccessGrant'.
  Property '[accessGrantBrand]' is missing in type '{}' but required in type 'AccessGrant'.
/Users/macmini/code/chalk/apps/web:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  web@0.1.0 check-types: `tsc --project tsconfig.check-types.json --noEmit`
Exit status 2
```

The presence widening error found in the first run was fixed; this final run reports only the unrelated existing `chalk-access.test.ts` error.

### `pnpm --filter ./apps/mobile check-types` — exit 0

```text
> @q9labsai/chalk-mobile@4.0.0 check-types /Users/macmini/code/chalk/apps/mobile
> tsc --noEmit
```

### `pnpm --filter ./sdks/typescript/react test -- src/__tests__/bindings.test.tsx src/components/participants-panel/participant-volume-context.test.tsx` — exit 0

```text
> @q9labsai/chalk-react@4.0.1 test /Users/macmini/code/chalk/sdks/typescript/react
> pnpm exec vitest run --config ./vitest.config.ts -- src/__tests__/bindings.test.tsx src/components/participants-panel/participant-volume-context.test.tsx


 RUN  v4.1.10 /Users/macmini/code/chalk/sdks/typescript/react


 Test Files  86 passed (86)
      Tests  190 passed (190)
   Start at  18:35:14
   Duration  6.09s (transform 8.09s, setup 6.72s, import 27.49s, tests 4.04s, environment 5.27s)
```

## Deviations

- No implementation deviations. The web typecheck remains non-green only because of the pre-existing `apps/web/src/lib/chalk-access.test.ts:81` error; it is unrelated to presence and was not changed.
- The final `ps aux` process check was blocked by sandbox `EPERM`; all verification command sessions returned and no command was left running.
