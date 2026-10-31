# Feature architecture

Chalk is organized by feature. A feature is a product capability such as
recording, chat or whiteboard, not a screen. Everything that makes a feature
work lives in one folder: its Go and Elixir code, its SDK code, its screens in
Chalk's own apps, its infrastructure, its tables and its tests. An agent working
on a feature finds all of it in one place, loads that feature's rules
automatically, and can tell from the folder what else the feature depends on.

The deployables don't change. The API binary, the Sync release, the web bundle,
the mobile app, the SDK packages and each worker image are still built as
before; each build collects its sources from the feature folders. Code that
hasn't moved yet keeps the app layout until its feature moves, as described in
[Moving a feature](#moving-a-feature).

## Layout

```text
features/        one folder per feature
  space/         core: the call (join, connection, participants, media,
                 admission, reconnect)
  access/        core: identity, grants, invites, memberships, API keys
  episodes/      core: the record of what happened in a Space
  chat/ whiteboard/ recording/ transcription/ webhooks/ ...
apps/            shells: one per deployable that combines features
  api/           Go entry point, feature registration, startup and shutdown
  sync/          Elixir application and supervision tree
  web/           routes, layout, landing pages, dashboard frame, docs site
  mobile/        navigation and app frame
sdks/typescript/ package roots: entry points, exports and build config
foundation/      code every feature builds on, with no product meaning
infrastructure/  one root per environment, composing feature modules
journeys/        end-to-end tests of the assembled product
tools/ scripts/  generators, gates and developer tools
```

The core features are the ones every call needs. Other features depend on them;
they never depend on other features.

## A feature folder

```text
features/recording/
  AGENTS.md        the feature's purpose, invariants and rules for agents
  contract/        wire schemas the feature owns
  api/             Go package with a Register function; api/internal is private
  sync/            Elixir modules, when the feature has live state
  sdk/client/      SDK plugin: state views, intents and lifecycle hooks
  sdk/react/       components customers embed
  sdk/react-native/
  app/web/         Chalk's own screens, built from the SDK components
  app/mobile/
  renderer/        a deployable that only this feature uses
  infra/           OpenTofu module
  db/migrations/   the feature's tables
  db/queries/
  tests/
```

A feature has only the parts it needs. A deployable that serves one feature,
such as the recording renderer or the transcription dispatcher, lives inside
that feature. Only deployables that combine features stay in `apps/`.

## Dependency rules

Dependencies point one way: shells, then features, then core features, then
`foundation/`. The gates enforce these rules in each language: Go's `internal/`
rule, dependency-cruiser for TypeScript, and a compile-time reference check for
Elixir.

- A feature imports another feature only through that feature's public entry:
  `api/` for Go, the `sdk/` entry points for TypeScript, and the feature's
  top-level module for Elixir.
- Feature dependencies form a graph without cycles. Core features never import
  other features.
- Nothing imports from `apps/`.
- `foundation/` never imports a feature and never uses a domain term from
  [GLOSSARY.md](../GLOSSARY.md). Every package in it has at least two feature
  users; a package with one user moves into that feature.

There is no hand-written dependency list. The imports are the declaration, and
the gates read them.

## How the shells assemble features

Every runtime uses the same pattern: the shell owns the lifecycle and holds one
list of features, and each feature plugs in.

- **API:** `apps/api/cmd/main.go` calls each feature's `Register` with the router and shared
  dependencies, and shuts features down in a written order.
- **Sync:** the supervision tree lists each feature's processes.
- **SDK:** the Space client runs join, reconnect and leave, and calls each
  plugin's hooks. Plugins reach shared state through typed stores, never
  through a global event channel.
- **Web and mobile:** screens define slots, such as the call screen's side
  panel, toolbar and overlays, and the dashboard's sections. Features fill
  slots. Route files stay in `apps/web/src/routes` because the router builds
  its route tree from that folder; each one imports a feature's page.

Landing pages, the dashboard frame, the docs site frame and app navigation
belong to the product as a whole, so they stay in the shells. A feature's
dashboard section, screens and customer docs live in the feature, and the
shells collect them.

## Lifecycles

Join, reconnect and leave are ordered stages. Hooks inside a stage run in
parallel; stages run one after another.

```ts
const leave = [stage("announce", [space.sendLeave]), stage("flush", [chat.onLeave, whiteboard.onLeave, recording.onLeave]), stage("close", [space.closeAfterAcknowledgement])];
```

- A plugin must implement `onJoin`, `onReconnect` and `onLeave`. The types make
  a missing reconnect hook a compile error.
- The lifecycle runner wraps every hook in a trace span with its stage, timing,
  result and remaining budget, so one leave reads as one trace.
- The shared lifecycle suite runs every plugin through join, network loss,
  reconnect and leave under a deadline. It runs each parallel stage in random
  orders with random delays; a hook that depends on another hook in its stage
  fails the suite and moves to a later stage.

## Authority

Sync, through Postgres, decides room state: participants, admission, chat,
whiteboard operations and call-visible recording status. The Go API decides
identity and access. The media provider decides what is actually published.

The client keeps a copy of the state the server decided, and handles what only
the device can do: capture, permissions, the media connection, noticing its own
network loss, instant feedback, and intents the user made that the server
hasn't received yet. The client never makes a decision the server also makes.
Permission checks in the client only change what the screen shows; the server's
answer is the only one that counts.

Media controls split the decision by direction, so the device and the server
never decide the same thing:

- Turning media off, such as muting the microphone, turning the camera off or
  stopping a screen share, is the device's decision. The device stops the track
  and the capture at once, then tells Sync, and resends until Sync shows it
  off. Sync accepts every off, so there is nothing to roll back.
- Turning media on is the server's decision. The control shows a pending state
  until Sync shows the media live, and shows the reason when Sync refuses, such
  as a host mute.
- After a reconnect, the device resends its offs and takes every on from Sync.

## Data

A feature owns its tables. Its migrations and queries live in its `db/`
folder, and only its own code reads and writes those tables. Another feature
gets that data through the owning feature's public entry. A table may reference
another feature's table only when the feature depends on that one.

Migration order is a property of the whole database. The migration runner
collects every feature's migrations and orders them by timestamp, and the gates
reject a migration older than the newest one on `master`. Removals keep the
previous release runnable, as the
[database workflow](../apps/api/docs/database-workflow.md) describes.

## Contracts and versions

A feature owns the contracts for its wire formats, and the generators write
bindings into each language that uses them. See
[contract codegen](contract-codegen.md).

Every contract and every migration stays compatible with the previous released
version, and the gates check it against the last released contract. That rule
is what makes changing both ends of a contract in one commit safe:

- The API and Sync release from the same commit. During a rolling deploy, old
  and new versions run side by side for minutes.
- The web app sends its build version when it connects, and reloads at the next
  safe moment, such as the end of a call.
- The mobile app supports the previous version only. Older versions are forced
  to upgrade.

The SDK's plugin interface is exported under an unstable subpath. Release notes
for a change to it include migration steps an agent can apply.

## Tests

- A feature's tests live in its `tests/` folder.
- A test that spans two features lives in the feature that depends on the
  other. A test that recording captures the whiteboard lives in recording.
- End-to-end user journeys test the assembled product and live in `journeys/`.
- The shared lifecycle suite lives in the Space feature and runs against every
  plugin.

## Operations live in code

Anything an agent may need to read or change is defined in this repository:
infrastructure, DNS and edge rules, Workers and their bindings, alerts and
dashboards, environment configuration, feature flags, store listings and CI
settings. A feature's infrastructure module, alerts and flags live in the
feature; `infrastructure/` holds one root per environment that composes them.

Secret values never enter the repository. Each secret is declared by name in
code, the infrastructure creates it without a value, the code that reads it is
explicit, and the value lives in the secret store. A scheduled drift check
compares live state with code and reports anything changed by hand.

Production identifiers stay out of Git, as [AGENTS.md](../AGENTS.md) requires.
Code refers to them through private deployment inputs.

## Tracing

Every operation is a trace, and the request ID is the trace ID. Each device
also has a session: one run of a Chalk app on one device, from opening the tab
or launching the app until it closes. A reload in the same tab keeps the
session. On mobile, a new session starts after 30 minutes in the background,
never during a call. A session covers dashboard use, API calls before a call
and any number of joins, so every problem a user can report falls inside one.

- The session ID travels with the trace context on every request and Sync
  connection, so server spans and logs carry it too. It uses the OpenTelemetry
  attribute `session.id`.
- Users see the session ID as their reference in help screens and problem
  reports, and diagnostic uploads are stored under it.
- Space, Episode, participant and recording IDs are attributes on spans, not a
  separate way to correlate.
- Every call to an outside provider gets its own span, which records the
  provider's request ID.
- Work without a user session, such as webhook delivery or a recording render,
  is found by trace ID and its domain IDs.

A session is never an Episode, even though the dashboard lists ended Episodes
as "Past sessions". Until the session ID ships,
[observability](observability.md) describes the IDs in use, including the
journey ID.

## The `chalk` command

Agents read the architecture through one developer command instead of
rebuilding it from the folders by hand. It reads the same imports and traces
the gates read, so it can't drift from them.

- `chalk graph` prints the feature dependency graph. Given a diff, it lists the
  features the change touches and the features that depend on them, and CI
  uses the same list to choose which feature tests to run.
- `chalk lifecycle` prints the stages of join, reconnect and leave and the
  hooks in each stage. Given a session ID, it shows how long each hook took and
  which one failed.
- `chalk trace` takes a session, trace or domain ID and prints the matching
  spans and logs from the apps, the API and Sync in time order. The shells tag
  every span and log with the feature that produced it, so a trace shows when
  work crosses from one feature to another.
- `chalk new feature <name>` creates a feature folder with its `AGENTS.md`,
  the parts it asks for and its line in each shell's feature list.

## Deleting a feature

Deleting a feature means deleting its folder and its line in each shell's
feature list. If anything else has to change, something leaked out of the
feature. This is the acceptance test for every move, and the gates run it on a
copy of the tree.

## Moving a feature

1. Write the feature's `AGENTS.md` from its current invariants.
2. Move the feature's server code, SDK code, screens, infrastructure,
   migrations, queries and tests into its folder. Shared code with two or more
   feature users moves to `foundation/` first.
3. Point each build at the new paths with globs over `features/*`, so later
   moves need no build changes.
4. Run the full gate and the deletion test, and compare generated contracts
   with the previous output.
5. Release from the new layout before moving the next feature.
