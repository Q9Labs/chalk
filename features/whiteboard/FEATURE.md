# Whiteboard

Whiteboard owns the living Space scene, collaboration protocol, file access,
canvas, client recovery, React views, native bridge, and its recorded rendering.
The Space owns what **is**: the scene, draw policy, and current configuration.
The Episode owns what **happened**: frozen activity and recording artifacts.
Recording composition and the Episode lifecycle remain consumers, not new
whiteboard responsibilities. See [the glossary](../../GLOSSARY.md).

## Source map

| Directory          | Owns                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `api/`             | Public Go API and download endpoint description                                              |
| `api/internal/`    | Private file service, cleanup, participant verification, Postgres adapter, generated queries |
| `api/db/`          | SQL queries and historical whiteboard migrations                                             |
| `sync/`            | Elixir authority, repository, protocol, fanout, socket adapter, generated contract           |
| `sdk/`             | Existing client, React, and React Native SDKs' whiteboard source and unit tests              |
| `packages/canvas/` | The unchanged public `@q9labsai/chalk-whiteboard` workspace package                          |
| `web/`             | Asset configuration and recorded-whiteboard renderer                                         |
| `tests/sync/`      | PostgreSQL-backed whiteboard protocol and authority tests                                    |
| `contract/`        | Canonical whiteboard wire schema                                                             |
| `tools/`           | Whiteboard contract emitters                                                                 |
| `docs/`            | Product docs, recording integration, migration evidence, baseline inventory                  |

Apps assemble these sources. The API mounts the feature's endpoint through the
same generic endpoint machinery. Sync compiles external source paths in its
existing Mix application. SDK bundlers consume the source directly and bundle
published declarations without moving unrelated SDK features. The private root
workspace supplies module resolution for feature-owned TypeScript sources.

Fallow treats the relocated SDK source as SDK entrypoints, matching its existing
public-package treatment of the SDK shells. Its package-cycle warnings describe
these source fragments and their shells, not independently built packages; module
cycle checks and the feature dependency guard remain enabled. The health baseline
preserves the existing contract validator's complexity finding at its new path.
`scripts/features/compare-contracts.mjs` proves that validator changed only its
schema path. Web tooling/test exclusions follow their previous `apps/web/` scope.

## Public interfaces and dependencies

The Go entrypoint is `github.com/q9labs/chalk/features/whiteboard/api`.
Its implementation packages are private under `api/internal/`; callers cannot
import them. Existing Chalk SDK exports and wire schemas remain unchanged.
`ChalkSync.WhiteboardV1` retains its existing module identities.

[feature.json](feature.json) declares direct repository dependencies. The shared
Go packages moved to `platform/` each already have consumers outside whiteboard:
object storage serves chat and recordings, IDs serve API domains, token
verification serves other collaboration surfaces, and HTTP contract types and
rate-limit policy serve the other API routes. Shared rendering font helpers and
geometry serve both whiteboard and recording composition.

The manifest also declares the current SDK shell dependencies. It does not call
those shells whiteboard-owned or hide their dependencies behind a platform name.
The application lifecycle, authentication, stateholder authority, database, socket
context, and observability modules remain shared Sync infrastructure.

Go checks resolved imports, including test imports. Elixir checks the compiled
xref graph's direct source edges. Dependency-cruiser checks resolved TypeScript
edges against the same manifest. The API and Sync gates run their language checks;
the root gate runs dependency-cruiser. Deliberate violation demos live with the
feature verification scripts.

## Build and deploy

The repository has one root Go module. The API and Sync images receive a
repository-root named build context but copy only the source their build needs.
Go embeds migrations from their owning folders into one sorted set. The local
Goose helper assembles that same SQL set in a disposable directory. No tracked
second source tree or import-rewriting build generator exists.

`apps/api/db/schema.sql` remains the shared database-schema projection consumed by
sqlc and cross-feature fixtures. Whiteboard's historical migrations and queries
live here; the shared projection is not a second implementation of the feature.

The native package stages its feature-owned bridge into distribution output,
alongside the existing generated embedded renderer assets. Source remains here;
published packages retain their native sources and resources.
