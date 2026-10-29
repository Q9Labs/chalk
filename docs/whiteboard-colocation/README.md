# Whiteboard colocation stopped at the Go boundary

The config-only spike failed claim (a). Do not merge this as a completed
relocation. No runtime file moved in the resulting diff. Claims (b) and (c),
manifest enforcement, and relocated per-app deploys remain unproven.

## Result

| Claim                                                                                                           | Result                                                         | Evidence                                                                                           |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| (a) A root Go module supports the relocated whiteboard package and the API binary                               | Failed after relocation; the root-module-only API build passed | Real package move rejects an API-private import; the API also loses the old whiteboard import path |
| (b) External Mix source paths compile Sync and pass its tests                                                   | Not run                                                        | Stopped after (a), as required                                                                     |
| (c) Workspace discovery, TypeScript paths, dependency-cruiser, gates, and per-app deploys work after relocation | Not run                                                        | Stopped after (a), as required                                                                     |

The [ownership map](FEATURE.md), [154-path inventory](inventory.md), and
[dependency manifest](dependencies.json) describe the existing feature. The
manifest is observational. No dependency guard was added after the stop.

## Reproduce the Go failure

The [probe](probe-go.sh) makes a detached disposable worktree from the caller's
HEAD. It uses `git mv`, moves the API module files to the root, changes only the
module declaration to `github.com/q9labs/chalk`, and leaves all source imports
unchanged. It builds the original API before moving the four domain files. It
then requires both expected errors below and removes its temporary checkout.
A successful probe exit means the failure was reproduced, not that the move
worked. There is no copied source tree or import-rewriting generator.

Run this from the pushed branch checkout:

```sh
box run -- 'bash docs/whiteboard-colocation/probe-go.sh'
```

Instabox ran the probe at `4fc740872` using Chalk's pinned Go toolchain. The
relevant output was:

```text
PASS: the API builds with a root module before moving whiteboard
$ go list ./features/whiteboard/api/whiteboardfiles
package github.com/q9labs/chalk/features/whiteboard/api/whiteboardfiles
    features/whiteboard/api/whiteboardfiles/cleanup.go:9:2: use of internal package github.com/q9labs/chalk/apps/api/internal/objectstorage not allowed
$ go build -o /tmp/chalk-api ./apps/api/cmd (whiteboard moved, imports unchanged)
apps/api/internal/adapters/postgres/whiteboard_files.go:12:2: no required module provides package github.com/q9labs/chalk/apps/api/internal/whiteboardfiles; to add it:
    go get github.com/q9labs/chalk/apps/api/internal/whiteboardfiles
REPRODUCED: config alone cannot relocate the existing Go package
box: exit 0 after 199s
```

The first attempt stopped before building because the snapshot set
`GOTOOLCHAIN=local` with Go 1.26.9, while Chalk requires 1.26.10. The probe now sets
`GOTOOLCHAIN=auto`. That environment failure is separate from the reproduced
language boundary failure.

## Why configuration is insufficient here

With one root module, moving a package directory changes its import path. A Go
module has no per-package alias configuration to preserve the old import string.
A `replace` directive applies to modules, not arbitrary packages. Synthesizing
nested modules to retain old import identities would not prove the council's
single-root-module claim.

The moved package imports `objectstorage`, `synctokens`, and `utilities` from
beneath the API's existing `internal/` directory. The moved feature is outside
that directory's allowed import parent. The first rejection is `objectstorage`.
Even changing consumer imports would not remove this private-dependency problem.

A later implementation would need to extract shared public dependencies, split
shared HTTP and Postgres packages, and update imports deliberately. Those are
architectural source changes outside this config-only spike. Symlink shims,
source copies, and rewritten imports were not used to bypass the result.

Go's built-in `internal/` restriction was observed rejecting the real moved
package. A new feature-private `internal/` package and a successful relocated API
binary were not established.

## Dependency enforcement was not attempted

TypeScript already has dependency-cruiser, but its present workspace rules target
existing application, package, and SDK roots. No rule was added for a migrated
feature because there is no migrated feature in this diff.

Go provides compiler-enforced `internal/` privacy. An import-manifest policy would
still need a separate check over resolved Go import edges. Sync has no `boundary`
dependency in its Mix configuration. No Elixir module-graph guard was implemented
or tested. The candidate manifest does not enforce any of these policies.

## Nightly is not a branch deployment entrypoint

The existing release nightly accepts only master and requires master Gate
evidence. Its dispatch cannot select this branch. The
[nightly investigation](nightly.md) gives source references and the cheapest safe
alternative: repeat a pinned-branch Instabox full Gate and disposable Sync
topology profile for a few days. That tests branch code without replacing shared
nightly. No recurring work or deployment was started.

## Verification limits

The final PR's Gate checks validate an evidence-only diff against unchanged
runtime code. A green Gate is not proof of relocated builds. The full relocation,
Elixir external-path compilation, moved TypeScript checks, Docker builds, sqlc
outputs, and codegen relocation were not run after the required stop.

The probe moved four Go domain files and two module files only inside its
temporary checkout. It removed that checkout. The final moved-file count is zero.
