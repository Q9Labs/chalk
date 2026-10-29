# Whiteboard file inventory

Baseline: `79661e765`, before this spike.

These 154 tracked paths contain `whiteboard`, case-insensitively. This is a
discovery inventory, not a claim that every file belongs to whiteboard. Recording
consumers and old migrations keep their existing owners. Shared integration files
also refer to whiteboard without naming it in their paths.

Regenerate the candidate list with:

```sh
git ls-tree -r --name-only 79661e765 | rg -i whiteboard
```

## apps/api

14 files.

```text
apps/api/db/migrations/20260729190500_add_whiteboard_v1.sql
apps/api/db/migrations/20260819130000_whiteboard_presentation_state.sql
apps/api/db/migrations/20261011203000_whiteboard_receipt_multipart_bound.sql
apps/api/db/migrations/20261022233000_whiteboard_draw_policy.sql
apps/api/db/migrations/20261027080000_whiteboard_presenter.sql
apps/api/db/queries/whiteboard_files.sql
apps/api/internal/adapters/postgres/sqlc/whiteboard_files.sql.go
apps/api/internal/adapters/postgres/whiteboard_files.go
apps/api/internal/httpapi/whiteboard_files.go
apps/api/internal/recordingpresentation/builder_whiteboard_history_test.go
apps/api/internal/whiteboardfiles/cleanup.go
apps/api/internal/whiteboardfiles/cleanup_scheduler.go
apps/api/internal/whiteboardfiles/participant_verifier.go
apps/api/internal/whiteboardfiles/service.go
```

## apps/recording-renderer

2 files.

```text
apps/recording-renderer/src/compose/whiteboard.test.ts
apps/recording-renderer/src/compose/whiteboard.ts
```

## apps/sync

21 files.

```text
apps/sync/lib/chalk_sync/contract/generated_whiteboard_v1.ex
apps/sync/lib/chalk_sync/transport/socket_whiteboard_v1.ex
apps/sync/lib/chalk_sync/whiteboard_v1/authority.ex
apps/sync/lib/chalk_sync/whiteboard_v1/authority/poller.ex
apps/sync/lib/chalk_sync/whiteboard_v1/episode.ex
apps/sync/lib/chalk_sync/whiteboard_v1/fanout.ex
apps/sync/lib/chalk_sync/whiteboard_v1/multipart.ex
apps/sync/lib/chalk_sync/whiteboard_v1/outbound_queue.ex
apps/sync/lib/chalk_sync/whiteboard_v1/postgres_repository.ex
apps/sync/lib/chalk_sync/whiteboard_v1/protocol.ex
apps/sync/lib/chalk_sync/whiteboard_v1/reducer.ex
apps/sync/lib/chalk_sync/whiteboard_v1/repository.ex
apps/sync/lib/chalk_sync/whiteboard_v1/sql.ex
apps/sync/lib/chalk_sync/whiteboard_v1/view_owner.ex
apps/sync/test/chalk_sync/contract/generated_whiteboard_v1_test.exs
apps/sync/test/chalk_sync/whiteboard_v1/authority_test.exs
apps/sync/test/chalk_sync/whiteboard_v1/draw_policy_test.exs
apps/sync/test/chalk_sync/whiteboard_v1/hello_close_test.exs
apps/sync/test/chalk_sync/whiteboard_v1/postgres_repository_test.exs
apps/sync/test/chalk_sync/whiteboard_v1/socket_test.exs
apps/sync/test/chalk_sync/whiteboard_v1/view_owner_test.exs
```

## apps/web

3 files.

```text
apps/web/src/docs/content/whiteboard.mdx
apps/web/src/lib/whiteboard-asset-versions.ts
apps/web/src/lib/whiteboard-assets.ts
```

## contract/schema

1 files.

```text
contract/schema/whiteboard-v1.json
```

## docs/recording-whiteboard.md

1 files.

```text
docs/recording-whiteboard.md
```

## packages/whiteboard

74 files.

```text
packages/whiteboard/CHANGELOG.md
packages/whiteboard/README.md
packages/whiteboard/package.json
packages/whiteboard/scripts/build-embedded.mjs
packages/whiteboard/scripts/rewrite-declaration-specifiers-proof.mjs
packages/whiteboard/src/assets.ts
packages/whiteboard/src/collab/camera.test.ts
packages/whiteboard/src/collab/camera.ts
packages/whiteboard/src/collab/engine.test.ts
packages/whiteboard/src/collab/engine.ts
packages/whiteboard/src/collab/files.ts
packages/whiteboard/src/collab/fixtures/excalidraw-0.18.1-reducer-golden.json
packages/whiteboard/src/collab/index.ts
packages/whiteboard/src/collab/ink.ts
packages/whiteboard/src/collab/order.ts
packages/whiteboard/src/collab/presence.ts
packages/whiteboard/src/collab/reducer.test.ts
packages/whiteboard/src/collab/reducer.ts
packages/whiteboard/src/collab/syncable.ts
packages/whiteboard/src/collab/types.ts
packages/whiteboard/src/collab/view-limits.ts
packages/whiteboard/src/collab/view.ts
packages/whiteboard/src/collab/wire.test.ts
packages/whiteboard/src/collab/wire.ts
packages/whiteboard/src/embedded/compatibility-manifest.json
packages/whiteboard/src/embedded/controller-views.test.ts
packages/whiteboard/src/embedded/controller.test.ts
packages/whiteboard/src/embedded/controller.ts
packages/whiteboard/src/embedded/index.ts
packages/whiteboard/src/embedded/manifest.ts
packages/whiteboard/src/embedded/protocol.test.ts
packages/whiteboard/src/embedded/protocol.ts
packages/whiteboard/src/embedded/renderer-assets.ts
packages/whiteboard/src/embedded/renderer-bridge.test.ts
packages/whiteboard/src/embedded/renderer-bridge.ts
packages/whiteboard/src/embedded/renderer-entry.ts
packages/whiteboard/src/embedded/renderer-viewport.test.ts
packages/whiteboard/src/embedded/renderer-viewport.ts
packages/whiteboard/src/embedded/renderer.test.tsx
packages/whiteboard/src/embedded/renderer.tsx
packages/whiteboard/src/index.ts
packages/whiteboard/src/react/MathEditor.tsx
packages/whiteboard/src/react/WhiteboardCanvas.stylesheet.test.tsx
packages/whiteboard/src/react/WhiteboardCanvas.test.tsx
packages/whiteboard/src/react/WhiteboardCanvas.tsx
packages/whiteboard/src/react/asset-loading.test.ts
packages/whiteboard/src/react/board/Board.tsx
packages/whiteboard/src/react/board/BoardCursors.tsx
packages/whiteboard/src/react/board/BoardIcon.tsx
packages/whiteboard/src/react/board/BoardIsland.test.tsx
packages/whiteboard/src/react/board/BoardIsland.tsx
packages/whiteboard/src/react/board/BoardMenu.tsx
packages/whiteboard/src/react/board/BoardStyles.tsx
packages/whiteboard/src/react/board/board-draw-policy.ts
packages/whiteboard/src/react/board/board-engine.ts
packages/whiteboard/src/react/board/board-history.ts
packages/whiteboard/src/react/board/board-model.ts
packages/whiteboard/src/react/board/board-toasts.ts
packages/whiteboard/src/react/board/board-view-versions.ts
packages/whiteboard/src/react/board/controls/ChalkMenu.tsx
packages/whiteboard/src/react/board/controls/ChalkPopover.test.tsx
packages/whiteboard/src/react/board/controls/ChalkPopover.tsx
packages/whiteboard/src/react/board/controls/ChalkTooltip.tsx
packages/whiteboard/src/react/board/controls/index.ts
packages/whiteboard/src/react/board/useMediaQuery.ts
packages/whiteboard/src/react/engine-history.ts
packages/whiteboard/src/react/index.ts
packages/whiteboard/src/react/math-elements.ts
packages/whiteboard/src/react/mathjax-renderer.ts
packages/whiteboard/tests/font-export.fixture.ts
packages/whiteboard/tsconfig.check-types.json
packages/whiteboard/tsconfig.embedded.json
packages/whiteboard/tsconfig.json
packages/whiteboard/vitest.config.ts
```

## sdks/typescript/client

17 files.

```text
sdks/typescript/client/src/generated/whiteboard-v1.ts
sdks/typescript/client/src/space-client/whiteboard-controller.test.ts
sdks/typescript/client/src/space-client/whiteboard-controller.ts
sdks/typescript/client/src/whiteboard/file-download-transport.ts
sdks/typescript/client/src/whiteboard/index.ts
sdks/typescript/client/src/whiteboard/types.ts
sdks/typescript/client/src/whiteboard/v1-client-recovery.test.ts
sdks/typescript/client/src/whiteboard/v1-client.ts
sdks/typescript/client/src/whiteboard/v1-codec.test.ts
sdks/typescript/client/src/whiteboard/v1-codec.ts
sdks/typescript/client/src/whiteboard/v1-create.ts
sdks/typescript/client/src/whiteboard/v1-multipart.test.ts
sdks/typescript/client/src/whiteboard/v1-multipart.ts
sdks/typescript/client/src/whiteboard/v1-persistence.ts
sdks/typescript/client/src/whiteboard/view-bounds.ts
sdks/typescript/client/src/whiteboard/view-versions.test.ts
sdks/typescript/client/src/whiteboard/view-versions.ts
```

## sdks/typescript/react

7 files.

```text
sdks/typescript/react/src/components/whiteboard-view/RecordingWhiteboardView.test.ts
sdks/typescript/react/src/components/whiteboard-view/RecordingWhiteboardView.tsx
sdks/typescript/react/src/components/whiteboard-view/WhiteboardView.tsx
sdks/typescript/react/src/components/whiteboard-view/recording-whiteboard-state.ts
sdks/typescript/react/src/internal/useWhiteboardSceneSubscription.test.tsx
sdks/typescript/react/src/internal/useWhiteboardSceneSubscription.ts
sdks/typescript/react/src/whiteboard/wire-adapters.ts
```

## sdks/typescript/react-native

11 files.

```text
sdks/typescript/react-native/ios/ChalkWhiteboardAssets.swift
sdks/typescript/react-native/ios/ChalkWhiteboardAssetsBridge.m
sdks/typescript/react-native/scripts/sync-whiteboard-assets.mjs
sdks/typescript/react-native/src/components/EmbeddedWhiteboard.tsx
sdks/typescript/react-native/src/space-client/whiteboard-watchdog.test.ts
sdks/typescript/react-native/src/whiteboard/embedded-whiteboard-assets.ts
sdks/typescript/react-native/src/whiteboard/embedded-whiteboard-viewport.test.ts
sdks/typescript/react-native/src/whiteboard/embedded-whiteboard-viewport.ts
sdks/typescript/react-native/src/whiteboard/export-board-image.ts
sdks/typescript/react-native/src/whiteboard/native-board-session.test.ts
sdks/typescript/react-native/src/whiteboard/native-board-session.ts
```

## tools/contract-fixture-proof

3 files.

```text
tools/contract-fixture-proof/src/emitters/whiteboard-contract.mjs
tools/contract-fixture-proof/src/emitters/whiteboard-elixir.mjs
tools/contract-fixture-proof/src/emitters/whiteboard-typescript.mjs
```
