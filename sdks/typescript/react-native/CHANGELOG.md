# Changelog

## 5.1.0

- Bound each Sync and whiteboard WebSocket opening attempt to 10 seconds, then retry through the existing reconnect backoff. React Native keeps its 30-second startup allowance, and larger configured allowances, for both transports.
- Size the call from the enclosing safe-area frame instead of the global window size. Orientation and call-region arrangement now follow the space `Chalk` is given, so a call rendered inside a smaller container, split view or modal lays out for that container rather than the whole screen. Full-screen calls look the same.
- Render registered native WebRTC host components so remote screen shares and camera video no longer disappear when React Native exports the video view as a string.
- Disable reaction sending and media enable controls until Sync is live, and keep recovery notices non-blocking.
- Show plain connection-not-ready and confirmation-timeout media feedback without exposing raw internal exception messages.

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
