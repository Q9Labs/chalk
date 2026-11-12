# Feature architecture

Chalk is organized by feature. A feature is a product capability such as recording, chat or whiteboard, not a screen. Everything that makes a feature work lives in one folder, so an agent finds the feature's code, tests and rules in one place and can see from the folder what it depends on. Deployables don't change: each build collects its sources from the feature folders. Code that hasn't moved keeps the app layout until its feature moves.

Today `features/` holds `mcp`, `media` (including the own SFU) and `scorecard`. Everything else still lives in `apps/`, `sdks/` and `packages/`. The rest of this page is the rule set a move follows.

## Where code goes

- `features/<name>/` holds one capability end to end: Go and Elixir code, SDK code, its screens, infrastructure, migrations, queries and tests. A feature has only the parts it needs, and a deployable that serves one feature lives inside it.
- `apps/` holds shells: deployables that combine features, plus the entry points, routes and frames they own (landing pages, dashboard frame, docs site frame, app navigation).
- `foundation/` is for code every feature builds on that has no product meaning. It never uses a domain term from [GLOSSARY.md](../GLOSSARY.md). A package needs two feature users to be there; a package with one user moves into that feature. The folder doesn't exist yet: create it with the first such package.
- Each feature has an `AGENTS.md` with its purpose and invariants (see `features/mcp/AGENTS.md`).

## Dependency rules

Dependencies point one way: shells, then features, then core features, then `foundation/`. Core features (the Space, access and Episodes) never import other features.

- A feature imports another feature only through its public entry.
- Feature dependencies form a graph without cycles.
- Nothing imports from `apps/`.
- The imports are the declaration. Don't keep a separate dependency list.

Enforced today: `.dependency-cruiser.cjs` for TypeScript package entry points and no imports of apps from workspace packages, and Go's `internal/` rule. The feature-to-feature rules above are the target for each move, not yet a gate.

## Authority

Sync, through Postgres, decides room state: participants, admission, chat, whiteboard operations and call-visible recording status. The Go API decides identity and access. The media provider decides what is actually published. The client holds a copy of decided state and handles only what the device can do: capture, permissions, the media connection, noticing its own network loss, instant feedback, and intents the server hasn't received yet. The client never makes a decision the server also makes, and its permission checks only change what the screen shows.

Media controls split the decision by direction, so the device and the server never decide the same thing:

- Turning media off (mute, camera off, stop sharing) is the device's decision. It stops the track at once, tells Sync, and resends until Sync shows it off. Sync accepts every off, so nothing rolls back.
- Turning media on is the server's decision. The control shows a pending state until Sync shows the media live, and shows the reason when Sync refuses, such as a host mute.
- After a reconnect, the device resends its offs and takes every on from Sync.

## Data

A feature owns its tables, and only its own code reads and writes them. Other features get the data through the owning feature's public entry. A table may reference another feature's table only when the feature depends on that one.

Migration order is a property of the whole database, so migrations are ordered globally, not per feature. Removals keep the previous release runnable; see the [database workflow](../apps/api/docs/database-workflow.md).

## Contracts and versions

A feature owns the contracts for its wire formats; generators write the bindings (see [contract codegen](contract-codegen.md)). Every contract and migration stays compatible with the previous released version. That is what makes changing both ends of a contract in one commit safe:

- The API and Sync release from the same commit, and old and new versions run side by side for minutes during a rolling deploy.
- The web app reports its build version on connect and reloads at the next safe moment, such as the end of a call.
- The mobile app supports the previous version only. Older versions are forced to upgrade.

## Operations live in code

Anything an agent may need to read or change is defined in this repository: infrastructure, DNS and edge rules, Workers, alerts, environment configuration, feature flags, store listings and CI settings. `infrastructure/` holds one root per environment. Secret values never enter the repository: code declares a secret by name, infrastructure creates it without a value, and the value lives in the secret store. Production identifiers stay out of Git, as [AGENTS.md](../AGENTS.md) requires.

## Tracing

Every operation is a trace, and the request ID is the trace ID. A session is one run of a Chalk app on one device and covers dashboard use, API calls before a call and any number of joins, so every problem a user can report falls inside one. A session is never an Episode, even though the dashboard lists ended Episodes as "Past sessions". Session IDs, span attributes and journey IDs are described in [observability](observability.md).

## Moving a feature

1. Write the feature's `AGENTS.md` from its current invariants.
2. Move its server code, SDK code, screens, infrastructure, migrations, queries and tests into its folder. Shared code with two or more feature users moves to `foundation/` first.
3. Point each build at the new paths. Deleting the feature must mean deleting its folder and its line in each shell's feature list; if anything else has to change, something leaked out.
4. Run the full gate and compare generated contracts with the previous output.
5. Release from the new layout before moving the next feature.
