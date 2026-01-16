
# Ralph Loop Instructions

You are in an autonomous development loop. Each iteration you start with fresh context.
Your only memory between iterations: git history, activity.txt, and prd.json.

## Recover Context (do this first)
1. `git log --oneline -20` - see recent commits
2. Read `activity.txt` - learnings from previous iterations
3. Read `prd.json` - full roadmap and what's done

## Pick Your Task
- Find next story where `passes: false` (respect priority order)
- Check `dependsOn` - skip if dependencies aren't complete
- Hard/risky tasks first. Easy stuff can wait. Nail down unknowns early.

## Work Philosophy
- **Small steps**: Quality over speed. Break work into tiny, verifiable chunks.
- **Integrate early**: Build end-to-end, not layer by layer. Don't discover integration issues at the end.
- **Never commit broken code**: If tests fail, fix them. Broken commits hamstring future iterations.
- **No vibe coding**: Verify everything. Don't just assume it works.

## Implementation Flow
1. Understand the story and acceptance criteria fully
2. Implement in small, testable increments
3. Run ALL verification checks (see below)
4. Only if everything passes:
   - Commit with descriptive message
   - Update `prd.json`: set `passes: true`
   - Append learnings to `activity.txt` (architectural decisions, gotchas, patterns)
5. If blocked/failed: log to `activity.txt` what went wrong, for next iteration

## Verification Checks

### Always Run
- Type checking: `bun run check-types`
- Tests: `bun test` or equivalent
- Lint: `bun run lint`

### Frontend Work (REQUIRED)
For any UI/frontend changes, verify visually using agent-browser:
```bash
# Start dev server if not running
bun run dev &

# Verify with headless browser
agent-browser open http://localhost:3000
agent-browser snapshot -i                    # See interactive elements
agent-browser screenshot verify-[feature].png
# Test interactions as needed:
agent-browser click @e2
agent-browser fill @e3 "test input"
agent-browser wait --text "Expected text"
agent-browser close
```
Never mark frontend stories as `passes: true` without visual verification.

### Backend/API Work
- Test endpoints with curl
- Verify response shapes match expectations
- Check error handling paths

## Activity Log Format
When appending to `activity.txt`, include:
```
## Iteration N - [story-id] - [timestamp]
**Status**: completed | blocked | partial
**What I did**: Brief summary
**Decisions**: Any architectural choices made
**Gotchas**: Problems encountered, solutions found
**Next**: What the next iteration should know
```

## Completion
When ALL stories have `passes: true`, output exactly on its own line: ___RALPH_ALL_STORIES_COMPLETE___

## Golden Rules
1. One story per iteration - focus
2. Verify before marking done - no assumptions
3. Log everything useful - you'll forget
4. Commit working code only - protect future iterations
5. Read activity.txt - past you left notes for a reason
