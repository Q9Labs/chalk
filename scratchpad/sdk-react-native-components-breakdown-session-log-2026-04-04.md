## 2026-04-04

- 2026-04-04 18:09:55 PKT
  - Task: Break down each component in `packages/sdk-react-native/src/components`, explain role/responsibilities, and describe how they work together.
  - Progress: Read the top-level phase controller (`NativeVideoConference`), in-meeting orchestrator (`NativeMeetingRoom`), panel/action/media/avatar/loading/end components, and the nested `native-meeting-room` layout helpers.
  - Notes: This task is explanatory only; no production code changes requested.

- 2026-04-04 18:24:12 PKT
  - Follow-up: Discuss architecture approaches for separating JSX/styles by platform while keeping shared state, props, and room logic centralized across Android, iPhone, iPad, and future Apple platform variants.
  - Progress: Reviewed collaboration/design workflow and prepared approach comparison focused on maintainability, platform semantics, and avoiding duplicated business logic.

- 2026-04-04 18:29:41 PKT
  - Clarification from Hasan: prefer stronger UI isolation even without explicit `Platform.OS` branches in render. Duplicate UI code is acceptable if it improves separation, lowers cross-platform regression risk, and makes platform-specific evolution easier.
  - Direction alignment: split major meeting surfaces per platform, including `TopBar`, `Stage`, `BottomDock`, `ActionSheet`, and `Panel`, while keeping shared controller/state/action logic centralized.
  - Ongoing discussion topics: what additional meeting surfaces should split, what the right controller/view-model contract should be, and what guardrails prevent UI logic from leaking back into shared renderers.
