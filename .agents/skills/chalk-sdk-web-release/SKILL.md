---
name: chalk-sdk-web-release
description: "used when Hassan asks for shipping the SDK packages or the web application"
---

# Chalk SDK and Web Release

Ship only the requested targets. Use one pre-push gate, let each release workflow build its own artifact once, and prove the exact live revision afterward.

## Release Modes

- `sdk`: Publish the synchronized public Chalk packages. Do not deploy the web application.
- `web`: Deploy the web application through staging and then production. Do not publish packages.
- `sdk+web`: Dispatch both workflows from the same release SHA before waiting for either one.

An SDK release without an explicit version uses the next patch version. A web request means staging first and then production only when the active thread explicitly approves production shipping.

## Gate Mode

Choose the gate mode from the changed files, not from a release mode name. The
automatic command is `pnpm run gate`; it preserves the affected-workspace and
reverse-dependent plan. A target-compatible web app or web-platform change may
use `pnpm run gate -- --target web`, and a target-compatible mobile app or
React Native change may use `pnpm run gate -- --target mobile`. Use
`pnpm run gate -- --full` for the full safety net.

The CLI accepts `--target web|mobile` and `--target=web|mobile`.
`GATE_TARGET=web|mobile` provides the same target for automation. If both are
set, they must match. A missing, unknown, or repeated target, a CLI/environment
conflict, or `--full` with either a CLI target or `GATE_TARGET` is rejected
before checks start. Direct
opposite-platform changes, mixed web-and-mobile changes, gate definitions,
root dependency or workspace configuration, unknown paths, and other
full-required changes are also rejected for target mode. Follow the printed
`Run instead:` instruction: target mismatch and input errors use
`pnpm run gate`; full-required changes use `pnpm run gate -- --full`. Target
selection only bounds validation. It never changes the packages published or
the app deployed.

## Waste Budget

- Use one clean release worktree based on the current `origin/master`.
- Run `pnpm run gate` once against the final staged release diff.
- Do not run `pnpm run package:release -- --dry-run`. The npm workflow builds, checks, and packs or publishes the same packages.
- Do not run a separate local web build. The web release runner builds one artifact and reuses it for staging and production.
- Do not rerun a passing check unless its inputs changed.
- Dispatch SDK and web workflows before waiting when both targets were requested.
- Use `gh run watch <run-id> --exit-status`. Do not poll run status.
- Never omit `release_managed=false` from a web-only release. Its workflow default is `true` and would build unrelated API and Sync images.
- Never use `skip_staging=true` unless Hasan explicitly approves an emergency production repair.

## Prepare One Release SHA

1. Read the root `AGENTS.md`, confirm the requested mode, and state the npm version and production target before changing external state.
2. Fetch `origin/master`. Create a uniquely named clean worktree from that exact revision so unrelated changes in the shared root stay untouched.
3. Apply only the approved feature commits. If they are already on `origin/master`, do not replay them.
4. Reuse dogfood evidence for the same code. If a user-facing change has no browser evidence, run one focused browser pass before the gate.
5. For an SDK release, use `scripts/npm-release.mjs` as the release-set source of truth. Update:
   - The seven synchronized public Chalk package versions.
   - Internal `workspace:` ranges that point to those packages.
   - The SDK runtime release identifier and its focused test when the client version changes.
   - `scripts/npm-release.mjs`, `scripts/npm-release.test.mjs`, `pnpm-lock.yaml`, and `CHANGELOG.md`.
6. Keep `@q9labsai/diagnostics-contracts` at its independent version unless its contract actually changed.
7. Reject unrelated lockfile churn. A patch release should change only the affected workspace specifiers, not third-party resolutions.
8. Run the cheap release checks before the gate:

```bash
node --test scripts/npm-release.test.mjs
git diff --check
```

9. Stage only the release diff with `git add -p`, then run the selected gate once:

```bash
pnpm run gate
```

For a target-compatible platform-only release, use the matching target command
from the Gate Mode section. The synchronized `sdk` and `sdk+web` release modes
always use the automatic command because they change both platform lanes,
release tooling, and lock data. They never infer a web target. If target
validation refuses the change, run the command in its `Run instead:` line.

10. Commit the passing staged diff. Fetch `origin/master` again and stop if it moved. Rebase the release on the new revision and rerun the gate only if the release inputs changed.
11. Push the exact release commit to `master`, then store its full SHA:

```bash
RELEASE_SHA="$(git rev-parse HEAD)"
git push origin HEAD:master
```

## Publish SDK Packages

Dispatch the guarded npm workflow. It verifies that `RELEASE_SHA` is live `origin/master`, builds the packages, checks their publication layout and TypeScript resolution, and publishes only versions missing from npm.

```bash
NPM_RUN_URL="$(
  gh workflow run .github/workflows/npm-publish.yml \
    --repo Q9Labs/chalk \
    --ref master \
    -f dry_run=false \
    -f release_sha="$RELEASE_SHA"
)"
NPM_RUN_ID="${NPM_RUN_URL##*/}"
```

Wait once:

```bash
gh run watch "$NPM_RUN_ID" --repo Q9Labs/chalk --exit-status
```

Do not publish from the local machine. CI owns the npm token and provenance.

## Deploy the Web Application

Dispatch only the web job. The explicit `release_managed=false` input is mandatory.

```bash
WEB_RUN_URL="$(
  gh workflow run .github/workflows/ci.yml \
    --repo Q9Labs/chalk \
    --ref master \
    -f target_sha="$RELEASE_SHA" \
    -f release_managed=false \
    -f deploy_web=true \
    -f skip_staging=false
)"
WEB_RUN_ID="${WEB_RUN_URL##*/}"
```

Wait once:

```bash
gh run watch "$WEB_RUN_ID" --repo Q9Labs/chalk --exit-status
```

The web job must build one artifact, deploy it to `chalk-staging`, verify it, deploy the same artifact to `chalk`, and verify `https://chalkmeet.com`. If staging verification fails, production must not run.

## Prove the Release

For an SDK release, verify every synchronized package at the requested version with `pnpm view` against `https://registry.npmjs.org/`:

```text
@q9labsai/chalk-assets
@q9labsai/facehash
@q9labsai/chalk-ui
@q9labsai/chalk-whiteboard
@q9labsai/chalk-client
@q9labsai/chalk-react
@q9labsai/chalk-react-native
```

For a web release, run the canonical live verifier:

```bash
node scripts/deploy/verify-web-deploy.mjs \
  https://chalkmeet.com \
  "$RELEASE_SHA" \
  --production
```

Also verify that live `origin/master` still equals `RELEASE_SHA`. For a UI release, hand over the existing recording and durable screenshot paths for the exact feature build; do not record the same flow again unless deployment changed its behavior.

## Stop Conditions

Stop instead of improvising when:

- `origin/master` moved after the gate.
- The gate failed.
- The requested npm version exists before this release and the existing package is not the intended artifact.
- Staging verification failed.
- The production verifier reports a different SHA.
- The web workflow shows managed API or Sync jobs despite `release_managed=false`.

An interrupted npm workflow is safe to rerun for the same SHA because it skips exact versions already present in the registry. Do not invent a new version until the registry state is known.

## Handoff

Report only the evidence Hasan needs:

- Release mode, version, and full SHA.
- npm and web workflow links with green conclusions.
- Registry proof for SDK packages.
- Staging deployment URL and production URL for web.
- Production verifier result and exact live SHA.
- Recording link and durable screenshots when the release changed UI.
- Any requested target that was not shipped.

Clean the temporary worktree and stop only the processes created for this release. Preserve unrelated shared worktree changes and processes.
