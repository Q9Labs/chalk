# SDK Package Release

**Scope:** Publish `@q9labs/*` packages to GitHub Packages.

## Packages

| Package | Path |
|---------|------|
| `@q9labs/chalk-core` | `packages/sdk-core/package.json` |
| `@q9labs/chalk-react` | `packages/sdk-react/package.json` |
| `@q9labs/chalk-react-native` | `packages/sdk-react-native/package.json` |
| `@q9labs/chalk-ui` | `packages/ui/package.json` |
| `@q9labs/chalk-whiteboard` | `packages/chalk-whiteboard/package.json` |

## Release Process

### Step 1: Check State

```bash
# Current versions
grep '"version"' packages/*/package.json packages/sdk-*/package.json

# Last published tag
git tag -l 'v*' | tail -1

# Commits since last tag
git log --oneline $(git tag -l 'v*' | tail -1)..HEAD --count

# Pending changes
git status --short
```

### Step 2: Stage Changes

```bash
# SDK packages only (for release commits)
git add packages/

# Or specific files
git add packages/sdk-core/ packages/sdk-react/ packages/chalk-whiteboard/
```

### Step 3: Bump Versions

All packages must have matching versions. Edit each `package.json`:

```bash
# Use Edit tool to change "version": "X.X.X" in each file
# packages/sdk-core/package.json
# packages/sdk-react/package.json
# packages/sdk-react-native/package.json
# packages/ui/package.json
# packages/chalk-whiteboard/package.json
```

### Step 4: Commit & Tag

```bash
# Commit version bump
git add packages/*/package.json
git commit -m "chore: bump packages to vX.X.X

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"

# Create tag
git tag vX.X.X

# Push both
git push origin master && git push origin vX.X.X
```

### Step 5: Monitor Workflow

```bash
# Find the tag-triggered run
gh run list --workflow=sdk.yml --limit=3

# Watch until completion
gh run watch <run-id> --exit-status
```

### Step 6: Verify Publish

```bash
# Check all packages published
gh run view <run-id> --log 2>&1 | grep -E "@q9labs.*@X.X.X"

# Expected output (5 lines):
# + @q9labs/chalk-core@X.X.X
# + @q9labs/chalk-react@X.X.X
# + @q9labs/chalk-react-native@X.X.X
# + @q9labs/chalk-ui@X.X.X
# + @q9labs/chalk-whiteboard@X.X.X
```

## Workflow Trigger

| Trigger | Condition | Jobs |
|---------|-----------|------|
| Tag push | `refs/tags/v*` | lint-and-test → build → **publish** |
| Branch push | `packages/**` | lint-and-test → build (no publish) |

Workflow: `.github/workflows/sdk.yml`

## Troubleshooting

| Issue | Check |
|-------|-------|
| Workflow shows success but package not published | All publish steps have `continue-on-error: true` - check logs for npm errors |
| `npm ERR! 403` | `NPM_TOKEN` secret expired or missing `packages:write` scope |
| Tag exists but no publish run | Tag must be pushed: `git push origin vX.X.X` |
| Version already exists | Bump to new version, can't republish same version |

## Client Installation

Clients need GitHub PAT with `read:packages` scope:

```bash
# .npmrc
@q9labs:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_TOKEN

# Then install
npm install @q9labs/chalk-core @q9labs/chalk-react
```
