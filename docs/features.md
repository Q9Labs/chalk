# Features own their cross-language source

Put one feature's implementation, tests, contracts, docs, and tools under
`features/<name>/`. Keep apps as assemblers. Whiteboard is the first migrated
feature; other features have not moved.

Use the feature's map and dependency manifest as its declared
repository dependencies. Follow [the glossary](../GLOSSARY.md): Space owns living
content and configuration; Episode owns frozen activity and artifacts.

## Add a feature

1. Create its folder, map, and dependency manifest. Use only the language folders
   it needs, such as `api`, `sync`, `sdk`, `packages`, `web`, `tests`, and `docs`.
2. Keep Go implementation packages under the feature's `api/internal/`. Export a
   small entrypoint under `api/`. Use the root Go module.
3. Extract a shared dependency to `platform/` only when another feature or app
   already needs it. Migrate all callers and remove the old path together.
4. Keep public TypeScript packages as workspace packages under the feature's
   `packages/` directory. Compile feature-owned partial SDK source in place.
5. Add external Elixir source and test paths to the owning Mix app. A source move
   does not change the module name or create another deployment.
6. Declare direct dependencies and extend the import checks. Demonstrate rejection
   of an undeclared dependency before accepting the real tree.
7. Update workspace discovery, gate selection, generation, package distribution,
   and Docker source contexts. Prove an affected path selects the required jobs
   and an unrelated path keeps its narrower checks.

Build outputs may contain bundled declarations, compiled JavaScript, SQL bundles,
and native package assets. Do not generate a second editable source tree, preserve
legacy import paths, or copy source back into old tracked locations.

The [whiteboard map](../features/whiteboard/FEATURE.md) describes the current
integration. Unit tests stay beside their code when language package membership
requires it. Cross-process feature tests can live under the feature's `tests/`.
