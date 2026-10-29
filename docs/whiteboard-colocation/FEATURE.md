# Whiteboard ownership map

This spike tests config-only cross-language colocation. Runtime files remain in
place until the Go proof passes. The [inventory](inventory.md) records the 154
whiteboard-named paths at baseline `79661e765`.

## Ownership follows Space and Episode

The Space owns the canonical living whiteboard scene and current configuration.
The Episode owns the frozen history and recording artifacts of activity. A
recording renderer that reads whiteboard history is a consumer of whiteboard,
not whiteboard-owned code. Historical migration files also remain part of the
ordered API database migration history. See [the glossary](../../GLOSSARY.md).

## Current files and proposed destinations

| Current location | Responsibility | Proposed destination or retained owner |
| --- | --- | --- |
| `packages/whiteboard/` | Reducer, collaborative scene, React canvas, embedded renderer, assets, tests, package metadata | `features/whiteboard/sdk/canvas/` |
| `sdks/typescript/client/src/whiteboard/` | Wire codec, retry, multipart, persistence, download transport, types | `features/whiteboard/sdk/client/` |
| `sdks/typescript/client/src/space-client/whiteboard-controller*` | Space-client integration | `features/whiteboard/sdk/client/`, after resolving relative imports |
| `sdks/typescript/client/src/generated/whiteboard-v1.ts` | Generated wire contract | `features/whiteboard/sdk/client/generated/`, with generator output configured |
| `sdks/typescript/react/src/components/whiteboard-view/`, `src/internal/useWhiteboardSceneSubscription*`, `src/whiteboard/` | React views and subscription adapter | `features/whiteboard/sdk/react/` |
| `sdks/typescript/react-native/src/whiteboard/`, whiteboard component, watchdog, iOS assets, asset script | Native adapter and embedded assets | `features/whiteboard/sdk/react-native/` |
| `apps/sync/lib/chalk_sync/whiteboard_v1/` | Durable authority, repository, protocol, reducer, fanout | `features/whiteboard/sync/` |
| `apps/sync/lib/chalk_sync/transport/socket_whiteboard_v1.ex` | Socket adapter | `features/whiteboard/sync/transport/` |
| `apps/sync/lib/chalk_sync/contract/generated_whiteboard_v1.ex` | Generated wire contract | `features/whiteboard/sync/contract/` |
| `apps/sync/test/chalk_sync/whiteboard_v1/` and contract test | Sync whiteboard tests | `features/whiteboard/tests/sync/` |
| `apps/api/internal/whiteboardfiles/` | Authorized file downloads and cleanup | `features/whiteboard/api/whiteboardfiles/`; Go probe tests this first |
| `apps/api/internal/httpapi/whiteboard_files.go` | HTTP adapter in the shared `httpapi` package | Requires a package split, not just a move |
| `apps/api/internal/adapters/postgres/whiteboard_files.go` | Postgres adapter in the shared `postgres` package | Requires a package split, not just a move |
| `apps/api/db/queries/whiteboard_files.sql`, generated sqlc output | Queries generated into a shared Go package | Requires sqlc and package-boundary work |
| `apps/api/db/migrations/*whiteboard*.sql` | Five historical migrations | Keep the API migration ordering intact |
| `apps/api/internal/recordingpresentation/builder_whiteboard_history_test.go` | Recording history test | Recording owns this consumer |
| `apps/recording-renderer/src/compose/whiteboard*` | Recording composition | Recording owns this consumer |
| `apps/web/src/lib/whiteboard-assets.ts`, `apps/web/src/lib/whiteboard-asset-versions.ts` | Web asset configuration | `features/whiteboard/web/` |
| `apps/web/src/docs/content/whiteboard.mdx` | Published product documentation | `features/whiteboard/docs/`, with web content discovery configured |
| `docs/recording-whiteboard.md` | Recording integration documentation | Recording owns this cross-feature integration |
| `contract/schema/whiteboard-v1.json` | Wire schema shared by client and Sync | Retain canonical contract ownership or configure a new canonical path |
| `tools/contract-fixture-proof/src/emitters/whiteboard-*` | Contract code generation | `features/whiteboard/sdk/codegen/`, with output paths configured |

Keep unit tests beside the code they test when the toolchain requires package
membership. The proposed `tests/` directory is for tests that can move separately.
Moving every test into that directory is not a requirement of feature colocation.

## Dependencies and consumers

The [dependency manifest](dependencies.json) records observed dependencies before
any move. It is an inventory, not an enforced boundary.

The Go domain imports API-private `objectstorage`, `synctokens`, and `utilities`.
Its public types contain those packages' types. The HTTP adapter also uses shared
HTTP helpers and object-storage errors. The Postgres adapter uses shared `sqlc`
and utilities. The API command, HTTP package, and Postgres package import the
existing `whiteboardfiles` package path.

Sync depends on authentication claims and token verification, Episode lifecycle,
the stateholder's identities and Postgres transaction authority, database access,
socket context and close handling, UUIDs, and observability. Whiteboard tests also
use shared test processes and supervisors. This is not a standalone Mix app.

The TypeScript canvas imports the client contract and facehash. Client whiteboard
code imports sibling collaboration capabilities, connection dependencies, Space
client store and types, and Sync transport and clock types. Its tests import the
shared manual clock. React uses client APIs, the whiteboard package, shared icons,
and the `cn` utility. Native integration uses the native Space client and toast
stack. These relative imports are not workspace aliases that a `pnpm` glob fixes.

Recording history and renderers consume whiteboard. Application setup, SDK
entrypoints, socket dispatch, codegen, database schema, and build scripts also
refer to whiteboard. A path-name inventory does not make those files exclusively
whiteboard-owned.

## Tooling affected by a later attempt

- Go module paths, existing import strings, and `internal/` parent directories.
- Mix source paths, test paths, formatter inputs, and shared module boundaries.
- `pnpm` workspace discovery, package-relative scripts, TypeScript source paths,
  package exports, native asset registration, and dependency-cruiser rules.
- Gate workspace roots, service selectors, and CI change filters. New unknown
  paths currently select the full gate rather than silently skipping checks.
- `apps/api/sqlc.yaml`, which writes into a shared Postgres package.
- `scripts/codegen/generate-sdk.sh`, `scripts/codegen/check-sdk-generated.sh`, and emitter defaults.
- The release workflow's `api_source=apps/api` and `sync_source=apps/sync` named
  Docker contexts. The API image reads module files and builds the API command; the Sync
  image copies only `apps/sync/mix.exs`, `apps/sync/mix.lock`, config, and source from its app context.
  Neither image currently includes a root-level feature tree.

No relocation or deploy compatibility is established by this map.
