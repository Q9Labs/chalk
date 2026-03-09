## 2026-03-08 23:10 PKT

- researched browser haptics package health: `web-haptics` `0.0.6`, published `2026-03-02`, recent upstream activity, ~40k weekly npm downloads
- added `useHaptics` wrapper in `packages/sdk-react`
- wired haptics into shared button primitives, reaction picker, pre-join header/join CTA, and meeting keyboard mute/video shortcuts
- added regression tests for button clicks, reaction picker close, and meeting keyboard shortcut vibration
- verified: `bun run lint`, `bun run --cwd packages/sdk-react check-types`, targeted haptics tests green
- noted unrelated dirty-tree work mixed nearby: picture-in-picture + settings layout changes; keeping commit scope isolated

## 2026-03-09 00:11 PKT

- implemented web video backgrounds in SDK-first path: core media state/actions, RTK virtual-background controller, React hook wiring, meeting settings persistence, and in-room settings UI
- added blur + Cloudflare preset backgrounds + custom local upload via IndexedDB/local memory fallback
- added regression coverage for settings persistence, settings dialog rendering/selection, and meeting-room background apply/persist flow
- repaired an obvious pre-existing syntax corruption in `ParticipantOptionsMenu.tsx` to unblock tests/typecheck; also aligned participant-list edit icons to exported `Edit02Icon`
- verified: `bun run --cwd packages/sdk-core check-types`, `bun run --cwd packages/sdk-core build`, targeted sdk-react tests for `useMeetingRoomSettings`, `SettingsDialog`, `MeetingRoom`
- remaining unrelated blocker: `bun run --cwd packages/sdk-react check-types` still red in dirty-tree screen-annotations files (`ScreenAnnotationsLayer.tsx` shape/type issues)

## 2026-03-09 00:48 PKT

- implemented web-only screen annotations across `sdk-core`, `sdk-react`, and `apps/api`
- added `ScreenAnnotationsManager`, new annotation entity types, websocket encode/decode/actions, and auto session lifecycle tied to local screen-share start/stop
- added `useScreenAnnotations()` plus a lightweight SVG overlay + floating toolbar in `ScreenShareView`, including draw tools, text notes, undo/redo, clear, close, and host access mode controls
- cherry-picked Newton backend commit `f6f9833` for `annotation.*` websocket handlers, persisted `rooms.screen_annotation_state`, stale-session rejection, and API regression tests
- verified: `bun run --cwd packages/sdk-core check-types`, `bun run --cwd packages/sdk-core build`, `cd apps/api && go test ./...`
- Gemini UI invocation attempted exactly as requested with `gemini -m gemini-3.1-pro-preview ... --approval-mode yolo --output-format text`, but the CLI returned `ModelNotFoundError: Requested entity was not found`; continued implementation manually
- remaining unrelated blocker: `bun run --cwd packages/sdk-react check-types` still red on pre-existing dirty-tree issue `src/components/full/video-conference/useVideoConferenceController.ts(52,61): TS6133`
