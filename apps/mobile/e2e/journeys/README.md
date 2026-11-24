# Mobile annotation journeys

Build the development app with the shared annotation renderer available. Start
Metro in `apps/mobile` with `EXPO_PUBLIC_CHALK_ANNOTATION_FIXTURE=1` and connect
the installed app to it before running these tests. The fixture exercises the
native annotation UI and renderer with an in-memory SDK client. It does not
exercise the media or Sync transports.

From this directory:

```sh
pnpm --ignore-workspace install --frozen-lockfile
CHALK_ANNOTATION_IPHONE=<simulator-udid> pnpm test --target iphone
```

For iPad or Android, set `CHALK_ANNOTATION_IPAD` or
`CHALK_ANNOTATION_ANDROID` to that device's ID and select the corresponding
target. The runner drives the touchscreen and cannot substitute for exercising
an Apple Pencil on physical hardware.

The iOS sharer journey bypasses ReplayKit at the share-state boundary and
injects a viewer mark when Chalk goes to the background. It starts native
picture-in-picture only when AVKit offers it. This does not prove that
ReplayKit excludes the PiP window from the outgoing stream; test that on a
physical iPhone or iPad by comparing what the sharer and a second device see.
