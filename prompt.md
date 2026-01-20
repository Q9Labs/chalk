# Ralph Loop - Chalk React Native SDK

You are in an autonomous development loop building turnkey components for @q9labs/chalk-react-native.

## Project Structure

packages/sdk-react-native/src/ # SDK source (your main target)
components/
atomic/ # Small UI primitives
composite/ # Feature panels & controls
full/ # Turnkey screens
hooks/ # React hooks
index.ts # Public exports
apps/mobile/ # Demo app consuming the SDK

## Recover Context (do this first)

1. `git log --oneline -10` - recent commits
2. Read `activity.txt` - learnings from previous iterations
3. Read `prd.json` - roadmap and completion status

## Pick Your Task

- Find next story where `passes: false`
- Check `dependsOn` - skip if dependencies incomplete
- Hard/risky/architecture first, easy stuff can wait

## Implementation Rules

- **TypeScript strict**: Infer types, don't manually define interfaces
- **StyleSheet only**: No external UI libraries except @gorhom/bottom-sheet
- **~300 lines max**: Split large components
- **Export everything**: Add new components to index.ts

## Verification (REQUIRED before marking passes: true)

Run ALL of these from repo root:

```bash
# 1. Types
bun run check-types

# 2. Lint
bun run lint

# 3. Build SDK
cd packages/sdk-react-native && bun run build

# 4. Mobile app compiles (if you touched mobile app)
cd apps/mobile && bunx expo export --platform ios --no-minify
```

If ANY check fails → fix it before committing. Never commit broken code.

Commit Protocol

Only when all checks pass:

```bash
git add -A
git commit -m "feat(sdk-react-native): [story-id] - [description]

Co-Authored-By: Ralph Wiggum <ralph@q9labs.ai>"
```

Then update prd.json: set passes: true for the story.

Activity Log

Append to activity.txt after each iteration:

## [story-id] - [timestamp]

**Status**: completed | blocked | partial
**Changes**: Files created/modified
**Decisions**: Architectural choices made
**Gotchas**: Problems and solutions
**Next**: What next iteration needs to know

Reference Files

When implementing, reference the web SDK patterns:

- packages/sdk-react/src/components/full/ - Turnkey patterns
- packages/sdk-react/src/components/composite/ - Control patterns

Completion

When ALL stories have passes: true, output: RALPH_DONE

Golden Rules

1. One story per iteration
2. All checks must pass before commit
3. Export from index.ts
4. Log decisions to activity.txt
5. Never skip verification
