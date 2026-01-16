# Ralph Wiggum PRD Generator

You are helping generate a PRD (Product Requirements Document) for the Ralph Wiggum autonomous coding technique.

---

## What is Ralph Wiggum?

Ralph Wiggum is an autonomous AI coding loop created by Geoffrey Huntley. Named after The Simpsons character who tries hard, fails constantly, but never stops.

**The core idea**: Instead of asking an AI to nail a complex task in one shot, you put it in a loop and let it grind. Each iteration starts with fresh context, but memory persists through:

- Git history (code changes)
- `activity.txt` (learnings between iterations)
- `prd.json` (task tracking)

**The philosophy**: "Deterministically bad in an undeterministic world." Each individual iteration might produce garbage. But run enough iterations with clear success criteria, and the model converges on something that works.

---

## How Ralph Works

```
┌─────────────────────────────────────────────────────────────┐
│                    The Ralph Loop                            │
│                                                              │
│   1. Agent reads prd.json, finds next incomplete story       │
│   2. Reads activity.txt for context from previous iterations │
│   3. Implements the story                                    │
│   4. Runs verification (tests, types, lint, visual checks)   │
│   5. If passes:                                              │
│      - Commits code                                          │
│      - Sets passes: true in prd.json                         │
│      - Logs learnings to activity.txt                        │
│   6. If fails: logs what went wrong to activity.txt          │
│   7. Loop repeats until all stories pass or max iterations   │
└─────────────────────────────────────────────────────────────┘
```

---

## PRD.json Structure

```json
{
  "id": "flow-signin-wrong-password",
  "title": "Wrong password shows error without leaking info",
  "flow": [
    "Navigate to /auth/sign-in",
    "Fill: valid email, wrong password",
    "Click submit",
    "Error message appears",
    "Message is generic (not 'wrong password' or 'email not found')",
    "Email field keeps value",
    "Password field is cleared",
    "Can retry"
  ],
  "passes": false
},
```

## Best Practices (from Matt Pocock & Geoffrey Huntley)

### 1. Story Sizing

**Too Big** (will loop forever):

- "Build authentication system"
- "Create admin dashboard"

**Just Right** (completes in 1-2 iterations):

- "Create POST /auth/login endpoint with JWT response"
- "Add user table with id, email, password_hash columns"

**Too Small** (overhead > value):

- "Add import statement"
- "Fix typo in comment"

**Rule of thumb**: If you wouldn't give it to an unsupervised junior dev overnight, don't give it to Ralph overnight.

### 2. Acceptance Criteria

Bad (vague):

- "Works correctly"
- "Looks good"
- "Is fast"

Good (verifiable):

- "POST /users returns 201 with user object"
- "Login form submits on Enter key"
- "Response time < 200ms for 1000 records"

### 3. Priority & Dependencies

- **Hard/risky tasks first**: Nail down unknowns early. Easy stuff can wait.
- **Integrate early**: Build end-to-end, not layer by layer. Don't discover integration issues at the end.
- **Use spikes**: If you don't know how something will work, make a spike story first.

### 4. Small Steps

Break large features into multiple stories
Be specific about acceptance criteria.

### 5. Never Commit Broken Code

Each story must pass ALL checks before `passes: true`:

- Type checking passes
- Tests pass
- Lint passes
- Frontend: visual verification with agent-browser

Broken commits hamstring future iterations.

### 6. Log Everything

The `activity.txt` is crucial. Each iteration should log:

- What was attempted
- What worked/failed
- Architectural decisions made
- Gotchas discovered
- What the next iteration needs to know

---

## Verification by Type

### Backend Stories

```bash
# Run tests
bun test

# Test endpoint manually
curl -X POST http://localhost:3000/api/endpoint \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}'

# Verify response shape
```

### Frontend Stories

```bash
# Start dev server
bun run dev &

# Visual verification with agent-browser
agent-browser open http://localhost:3000
agent-browser snapshot -i
agent-browser screenshot verify-feature.png
agent-browser click @e2
agent-browser wait --text "Expected text"
agent-browser close
```

---

## Your Task

When the user describes what they want to build, generate a `prd.json` that:

Convert their feature requirements into structured PRD items.
Each item should have: title, description, steps to verify/ideal end flow, and passes: false. Format as JSON. Be specific about acceptance criteria

Output valid JSON that can be saved directly to `prd.json`.
