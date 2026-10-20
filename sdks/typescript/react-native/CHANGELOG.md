# Changelog

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
