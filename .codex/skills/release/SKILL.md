---
name: release
description: Create GitHub releases and publish SDK packages. Use when user says "/release".
---

# Release Skill (Codex)

## Phase 1: Gather (parallel)

```bash
awk '/## \[Unreleased\]/,/## \[0\.[0-9]+\.[0-9]+\]/{if(/## \[0\.[0-9]+\.[0-9]+\]/)exit; print}' CHANGELOG.md
grep '"version"' packages/*/package.json | head -5
git tag -l 'v*' | sort -V | tail -1
```

**Abort if:** Unreleased section is empty → "No unreleased changes to publish."

---

## Phase 2: Analyze, Present, and Ask

**Show the user your analysis, then ask in one interaction:**

1. **Categorize changes** (show as table):

| User-Facing (`<!-- whats-new -->`) | Technical (outside tags)                         |
| ---------------------------------- | ------------------------------------------------ |
| Added, Changed, Fixed              | Developer Experience, Refactoring, Infrastructure |

**User-facing tone rules:**
- Write for non-technical end users (teachers, students, admins)
- Describe **what changed for the user**, not how it was fixed
- NO: implementation details, API names, hook names, SSR, framework-specific terms
- YES: "Reactions now display properly", "Sound effects now play"
- NO: "Fixed `activeReactions` from `useInteractions` hook", "SSR compatibility"
- Move all technical details (code references, framework fixes, internal changes) to Technical Notes

2. **Suggest version:**

| Change Type     | Bump  |
| --------------- | ----- |
| Breaking change | Major |
| New feature     | Minor |
| Bug fix only    | Patch |

3. **Generate 3 codename options** — Latin-esque (e.g., "Nexus Primus", "Lumina Invicta")

4. **Generate image prompt** (show to user):

> Abstract minimalist illustration for video conferencing software release.  
> Soft gradients in [PALETTE]. Flowing organic shapes with subtle geometric elements.  
> Modern, clean, tech aesthetic, grainy, illustrative. No text, no people, no icons.  
> Aspect ratio 4:3 landscape.

| Theme               | Palette               |
| ------------------- | --------------------- |
| Video, Meetings     | teal, cyan, emerald   |
| Transcription       | blue, indigo, violet  |
| Recording, Export   | coral, peach, gold    |
| Collaboration       | purple, magenta, pink |
| Performance         | lime, mint, emerald   |
| UI, Design          | teal, purple, cyan    |

5. **AskUserQuestion** (after showing above):
   - Version: confirm or override
   - Codename: pick from 3
   - Image key: "Skip" or "Provide key" (user pastes in Other field)

R2 upload command (show before asking):
```bash
aws s3 cp hero.png s3://chalk-recordings/whats-new/vX.X.X/hero.png \
  --endpoint-url https://5281943bd26d5bdcf4c3915606cd6bfb.r2.cloudflarestorage.com
```

---

## Phase 3: Execute (Haiku Agent)

Spawn `model="haiku"`, `subagent_type="code-writer"` with this exact prompt structure:

````markdown
Execute release vX.X.X - [CODENAME]

## Inputs
- **version**: `X.X.X`
- **title**: `vX.X.X - [CODENAME]`
- **imageKey**: `[KEY or empty]`
- **date**: `YYYY-MM-DD`

## Release Body (save to scratchpad/release-notes.md)

```markdown
<!-- image: [IMAGE_KEY] -->

<!-- whats-new -->
## Features

- **[Feature Name]** — [1-sentence plain-language description, no code/framework terms]

## Improvements

- **[Enhancement]** — [1-sentence plain-language description, no code/framework terms]

## Bug Fixes

- [Plain-language fix description — what the user sees fixed, not how]
<!-- /whats-new -->

## Technical Notes

- [Technical change 1]
- [Technical change 2]
```

## Steps

### 1. Edit package.json (5 files)
Change `"version": "[OLD]"` to `"version": "[NEW]"` in:
- `packages/sdk-core/package.json`
- `packages/sdk-react/package.json`
- `packages/sdk-react-native/package.json`
- `packages/ui/package.json`
- `packages/chalk-whiteboard/package.json`

### 2. Edit CHANGELOG.md
Replace `## [Unreleased]` section with:
```
## [Unreleased]

### Added

### Changed

### Fixed

## [X.X.X] - YYYY-MM-DD
```

### 3. Git
```bash
git add packages/*/package.json CHANGELOG.md
git commit -m "chore: release vX.X.X"
git tag vX.X.X
git push origin master && git push origin vX.X.X
```

### 4. GitHub Release
```bash
gh release create vX.X.X --verify-tag --title "[TITLE]" --notes-file [SCRATCHPAD]/release-notes.md
```

### 5. Verify
```bash
gh run list --workflow=sdk.yml --limit=1
gh run watch [RUN_ID] --exit-status
```

Report: release URL + workflow status
````

---

## Troubleshooting

| Issue                    | Solution                                               |
| ------------------------ | ------------------------------------------------------ |
| Tag already exists       | `git tag -d vX.X.X && git push origin :vX.X.X`         |
| 403 on npm publish       | Check `NPM_TOKEN` secret has `packages:write`          |
| Workflow success, no pkg | Check logs — `continue-on-error: true` masks errors    |
| Release not in What's New| Clear Redis: `redis-cli DEL whats-new:latest`          |
