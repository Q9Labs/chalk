#!/usr/bin/env bash
#
# ralph.sh - The Ralph Wiggum Technique
#
# "Deterministically bad in an undeterministic world."
#   - Geoffrey Huntley
#
# Files:
#   prd.json      Project roadmap with user stories (passes: true/false)
#   activity.txt  Append-only learnings between iterations
#   prompt.md     Instructions for the agent (optional, has defaults)
#
# Usage:
#   ./ralph.sh [project-dir]
#
# Environment:
#   RALPH_AGENT       CLI agent command (default: claude --dangerously-skip-permissions --chrome)
#   RALPH_MAX_ITERS   Max iterations, 0=unlimited (default: 5)

set -euo pipefail

PROJECT_DIR="${1:-.}"
PRD_FILE="$PROJECT_DIR/prd.json"
ACTIVITY_FILE="$PROJECT_DIR/activity.txt"
PROMPT_FILE="$PROJECT_DIR/prompt.md"
LOG_FILE="$PROJECT_DIR/ralph-output.log"
TRANSCRIPT_FILE="$PROJECT_DIR/ralph.log"

AGENT="${RALPH_AGENT:-claude --dangerously-skip-permissions}"
MAX_ITERATIONS="${RALPH_MAX_ITERS:-5}"
ITERATION=0

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${GREEN}[ralph]${NC} $1"; }
warn() { echo -e "${YELLOW}[ralph]${NC} $1"; }
err() { echo -e "${RED}[ralph]${NC} $1" >&2; }
info() { echo -e "${CYAN}[ralph]${NC} $1"; }

cleanup() {
    echo
    log "Stopped after $ITERATION iteration(s)"
    exit 0
}
trap cleanup SIGINT SIGTERM

# Check for jq
if ! command -v jq &> /dev/null; then
    err "jq is required. Install with: brew install jq"
    exit 1
fi

# Initialize files if missing
init_project() {
    if [[ ! -f "$PRD_FILE" ]]; then
        err "prd.json not found in $PROJECT_DIR"
        echo
        echo "Create prd.json with your user stories:"
        cat << 'EOF'
{
  "project": "my-project",
  "description": "What this project does",
  "userStories": [
    {
      "id": "story-1",
      "title": "First feature",
      "description": "Implement X that does Y",
      "acceptanceCriteria": ["Tests pass", "Feature works"],
      "priority": 1,
      "passes": false
    }
  ]
}
EOF
        exit 1
    fi

    # Create activity.txt if missing
    [[ ! -f "$ACTIVITY_FILE" ]] && touch "$ACTIVITY_FILE"

    # Create default prompt.md if missing
    if [[ ! -f "$PROMPT_FILE" ]]; then
        cat > "$PROMPT_FILE" << 'EOF'

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
When ALL stories have `passes: true`, output exactly: RALPH_DONE

## Golden Rules
1. One story per iteration - focus
2. Verify before marking done - no assumptions
3. Log everything useful - you'll forget
4. Commit working code only - protect future iterations
5. Read activity.txt - past you left notes for a reason
EOF
        log "Created default prompt.md"
    fi
}

# Get next incomplete story
get_next_story() {
    jq -r '.userStories | map(select(.passes == false)) | sort_by(.priority) | .[0] // empty' "$PRD_FILE"
}

# Check if all stories complete
all_done() {
    local remaining
    remaining=$(jq '[.userStories[] | select(.passes == false)] | length' "$PRD_FILE")
    [[ "$remaining" -eq 0 ]]
}

# Count stories
count_stories() {
    local total done
    total=$(jq '.userStories | length' "$PRD_FILE")
    done=$(jq '[.userStories[] | select(.passes == true)] | length' "$PRD_FILE")
    echo "$done/$total"
}

# Main
init_project

PROJECT_NAME=$(jq -r '.project // "unknown"' "$PRD_FILE")

# Clear transcript for fresh run
> "$TRANSCRIPT_FILE"
echo "# Ralph Transcript - $(date)" >> "$TRANSCRIPT_FILE"
echo "# Project: $PROJECT_NAME" >> "$TRANSCRIPT_FILE"
echo "# Watch live: tail -f $TRANSCRIPT_FILE" >> "$TRANSCRIPT_FILE"

log "Starting Ralph loop"
log "Project: $PROJECT_NAME"
log "Agent: $AGENT"
log "Stories: $(count_stories)"
log "Transcript: $TRANSCRIPT_FILE"
[[ $MAX_ITERATIONS -gt 0 ]] && log "Max iterations: $MAX_ITERATIONS"
echo

# The Loop
while :; do
    ((ITERATION++))

    # Check if done
    if all_done; then
        log "All stories complete!"
        log "Finished in $ITERATION iteration(s)"
        exit 0
    fi

    # Get next story
    NEXT_STORY=$(get_next_story)
    STORY_ID=$(echo "$NEXT_STORY" | jq -r '.id // "unknown"')
    STORY_TITLE=$(echo "$NEXT_STORY" | jq -r '.title // "unknown"')

    log "=== Iteration $ITERATION === [$(count_stories)]"
    info "Working on: $STORY_ID - $STORY_TITLE"
    info "Transcript: tail -f $TRANSCRIPT_FILE"

    # Build the prompt with context
    FULL_PROMPT=$(cat "$PROMPT_FILE")
    FULL_PROMPT+="\n\n---\n## Current Story\n\`\`\`json\n$NEXT_STORY\n\`\`\`"

    # Log iteration start to transcript
    {
        echo ""
        echo "========================================"
        echo "ITERATION $ITERATION - $(date)"
        echo "Story: $STORY_ID - $STORY_TITLE"
        echo "========================================"
        echo ""
    } >> "$TRANSCRIPT_FILE"

    # Run the agent, capture output separately to check for completion
    AGENT_OUTPUT_FILE=$(mktemp)
    echo -e "$FULL_PROMPT" | $AGENT 2>&1 | tee -a "$TRANSCRIPT_FILE" | tee "$AGENT_OUTPUT_FILE"
    cat "$AGENT_OUTPUT_FILE" >> "$LOG_FILE"

    # Log iteration
    echo -e "\n--- Iteration $ITERATION completed at $(date) ---" >> "$ACTIVITY_FILE"

    # Check for completion signal in agent's actual output only (not the prompt)
    if grep -q "___RALPH_ALL_STORIES_COMPLETE___" "$AGENT_OUTPUT_FILE"; then
        echo
        log "Completion signal detected!"
        log "Finished in $ITERATION iteration(s)"
        rm -f "$AGENT_OUTPUT_FILE"
        exit 0
    fi
    rm -f "$AGENT_OUTPUT_FILE"

    # Check iteration limit
    if [[ $MAX_ITERATIONS -gt 0 && $ITERATION -ge $MAX_ITERATIONS ]]; then
        warn "Max iterations ($MAX_ITERATIONS) reached"
        warn "Stories remaining: $(jq '[.userStories[] | select(.passes == false)] | length' "$PRD_FILE")"
        exit 1
    fi

    # Brief pause
    sleep 2
done
