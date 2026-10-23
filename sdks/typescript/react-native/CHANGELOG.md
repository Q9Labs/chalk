# Changelog

## 5.1.0

- Bound each Sync and whiteboard WebSocket opening attempt to the existing 30-second startup allowance, or to `syncStartupTimeoutMs` when set. `syncStartupTimeoutMs` accepts 1 to 60,000 ms, and each attempt gets at least 10 seconds. The whiteboard retries a timed-out attempt through the existing reconnect backoff, and so does Sync once the call is live, such as after a drop or a return to the foreground. A first join does not retry a Sync socket that never opens: the join fails when its startup wait of `syncStartupTimeoutMs` ends, and a setting below 10 seconds ends the join before the attempt's own 10-second minimum. The client's 10-second default does not apply to React Native.
- Size the call from the enclosing safe-area frame instead of the global window size. Orientation and call-region arrangement now follow the space `Chalk` is given, so a call rendered inside a smaller container, split view or modal lays out for that container rather than the whole screen. Full-screen calls look the same.
- Render registered native WebRTC host components so remote screen shares and camera video no longer disappear when React Native exports the video view as a string.
- Disable reaction sending and media enable controls until Sync is live, and keep recovery notices non-blocking.
- Show plain connection-not-ready and confirmation-timeout media feedback without exposing raw internal exception messages.
- Run the Android module API compatibility check only in the Chalk repository, so an app's `./gradlew check` no longer needs Chalk's test fixtures or the API 30 platform.

## 5.0.1

- Fix the Android 11 crash when joining a call by isolating API 31 audio listeners from React Native module signatures.

## 5.0.0

- Rebuild `Chalk` with a call header, Spotlight and Grid layouts, a dock, People and Chat sheets, and status pages.
- Add `ChalkArrival`, light and dark color schemes, call sounds and haptics, and permission recovery callbacks.
- BREAKING: replace the old layout and theme exports with `ChalkProps`, `ColorScheme`, and `Palette`. Remove the `/appearance` and platform-specific entry points.
- BREAKING: call `onLeave` when the user chooses Home on the post-call page, not immediately after leaving.
- BREAKING: add Expo audio, haptics, clipboard, document picker, file system, and `expo-crypto` peers. Add Reanimated, Worklets, Gesture Handler, and Safe Area Context peers.
- Use the v5 client, whiteboard, and facehash packages.

See the [project changelog](../../../CHANGELOG.md) for the full export removals and migration details.
