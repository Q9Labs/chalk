# React Native canonical refactor session log — 2026-07-12

## 2026-07-12

- Started the React Native SDK canonical-standards refactor in the package directory.
- Read the TypeScript SDK standards, React guidance, provider/session-store exemplar, global code standards, and writing style.
- Initial inventory found `useEffect` in hooks, platform loading screens, Android connection service, pre-join and meeting controllers, meeting grids, multitasking hooks, the logo component, clipboard, and `NativeVideoConference`.
- Converted manager hooks to the shared `useManagerState`/`useSyncExternalStore` path, and moved preview, transcripts, whiteboard, recording duration, clipboard, animation, pagination, pre-join, meeting-room, Android connection, and multitasking lifecycles into framework-free stores/controllers.
- Moved `NativeVideoConference` join, disconnect, CallKit, diagnostics, and join-guard timer ownership into `NativeVideoConferenceController`; added focused controller/store tests and preserved platform-specific files.
- Split the CallKit lifecycle into `NativeVideoConferenceCallKitController` with an injected port and focused unit coverage.
- Source audit reports zero `useEffect` sites.
- Final package verification passed: `pnpm exec oxfmt src`, `pnpm run check-types`, `pnpm run test` (39 files, 146 tests), and `pnpm run build`.
