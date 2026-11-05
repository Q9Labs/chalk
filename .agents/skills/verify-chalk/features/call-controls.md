# Call controls

In a call, a person turns their microphone and camera on and off, and leaves or rejoins. Each control changes what the other participants see and hear.

## Sub-features

- `controls-mic` toggles the microphone: `Unmute microphone` and `Mute microphone`.
- `controls-camera` toggles the camera: `Turn on camera` and `Turn off camera`.
- `controls-leave` leaves the call with `Leave call`.
- `controls-rejoin` returns to the call with `Rejoin`.

## How to get to it (user POV)

- Join a call as described in [join-call.md](./join-call.md), then move the pointer over the stage. The controls appear.

## Driving it with Playwright (join-call.mjs and tests/call.e2e.ts)

Preconditions:

- Both participants are in a call. Run the steps of [join-call.md](./join-call.md) up to the `Both tiles` step.
- Each context uses the fake devices from `webMediaFixture`.

- **Turn on.** Hover `getByRole("region", { name: "Space stage", exact: true })`, then click `Unmute microphone`, hover again, click `Turn on camera`. The buttons change to `Mute microphone` and `Turn off camera`. `join-call.mjs` does this in its `turns on microphone and camera` step.
- **Turn off and on again.** Click `Mute microphone`, then `Unmute microphone`, then `Turn off camera`, then `Turn on camera`, hovering before each click. After every change the other page still shows `Video tile for <name>`. Read the remote frame count to prove the stream resumes. `tests/call.e2e.ts` runs this order against a deployed proof tenant.
- **Leave.** Hover the stage and click `Leave call`. The tile disappears for the other participant and a button named `Rejoin` appears on the leaver's page.
- **Rejoin.** Click `Rejoin`. A button named `Video tile for <name>` appears again.

## Gotchas

- Controls are hidden until the stage is hovered. A click without a hover times out.
- `Rejoin` stays disabled until the leave finishes releasing the session. Wait for it to be enabled before you click.
- `join-call.mjs` covers the first turn on and the leave. The turn off and rejoin steps are mapped from `tests/call.e2e.ts` and `scripts/web-proof/connection-lost.mjs`. The `verify-chalk` lane did not drive them.
