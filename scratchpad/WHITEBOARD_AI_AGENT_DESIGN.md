# Whiteboard AI Agent (Natural Language -> Draw) Design Notes

Date: 2026-02-12

Purpose: keep us aligned; avoid over-engineering; serve as the shared reference while we implement.

Non-goal: MCP integration. We are not using Excalidraw MCP for Chalk.

---

## One Rule (Prevents 80% of Footguns)

**LLM plans, client executes, existing whiteboard sync stays unchanged.**

That means:

- The model never directly mutates the canvas.
- The client applies deterministic actions via `ExcalidrawImperativeAPI`.
- Chalk’s current whiteboard sync broadcasts the resulting edits like any other local user edit.

---

## Core Split: Planner vs Executor

### High-Level Component Diagram

```text
User
  |
  v
[Prompt UI]  (WhiteboardPanel overlay)
  |
  v
[Planner]  (LLM call; usually via Chalk API)
  |
  v
actions[]  (create/update/delete/...)
  |
  v
[Executor] (client, deterministic)
  |
  v
ExcalidrawImperativeAPI.updateScene(...)
  |
  v
Chalk whiteboard sync (existing)
  |
  v
Other participants see the drawing
```

### Sequence Diagram (MVP)

```text
User            Client(UI+Executor)            Planner(LLM)            Excalidraw API          Chalk Sync
 |                    |                           |                       |                      |
 | "draw X"           |                           |                       |                      |
 |------------------->| build whiteboardContext   |                       |                      |
 |                    |-------------------------->| prompt + context      |                      |
 |                    |<--------------------------| actions[]             |                      |
 |                    | validate + guardrails     |                       |                      |
 |                    | apply actions             |                       |                      |
 |                    |----------------------------------------------->   | updateScene(...)     |
 |                    |                                                  |--------------------->|
 |                    |                                                  | local edits propagate |
 |                    |----------------------------------------------------------------------->  |
 |                    |                                                     others update        |
```

---

## Where This Lives (Decision)

Decision: implement in **React SDK** (not demo app code).

Primary integration point:

- `packages/sdk-react/src/components/full/WhiteboardPanel.tsx`

Rationale:

- It already owns the `ExcalidrawImperativeAPI` ref.
- It already wires onChange + sync (v1 and v2 paths).
- Agent can be a simple overlay that only renders when whiteboard is open.

---

## Permissions + UX (Decisions)

Permissions:

- Agent is usable by anyone with `canDraw === true`.

UX:

- Apply immediately (no preview).

Implication:

- We must enforce guardrails (caps + allowlist) because we’ve intentionally removed the “human review” step.

---

## Action Language (Keep It Tiny)

Start with 3-4 actions. This avoids “scene-replace” complexity.

```text
Action =
  - create: { elements: ElementSpec[] }
  - update: { updates: { id: string, patch: Patch }[] }
  - delete: { ids: string[] }
  - select: { ids: string[] }               (optional; UX)
```

### Patch Allowlist (Safety + Stability)

Executor must filter patches to a strict set (example):

- geometry: `x`, `y`, `width`, `height`, `angle`
- styling: `strokeColor`, `backgroundColor`, `opacity`, `strokeWidth`, `roughness`, `fillStyle`
- text: `text`, `fontSize`, `fontFamily`, `textAlign`, `verticalAlign`
- misc: `locked`, `roundness`

Hard rule: reject/strip anything outside the allowlist.

### Caps (Prevent Model “Explosions”)

Example caps (tune later):

- max create elements per prompt: 50
- max updates per prompt: 50
- max deletes per prompt: 200
- max total actions per prompt: 20

---

## Whiteboard Context (Don’t Send Full Scene)

Send only what the model needs for good tool calls:

```text
whiteboardContext = {
  viewport: { scrollX, scrollY, zoom },
  selectedElementIds: string[],
  visibleElements: [
    { id, type, x, y, width, height, text? }  // text truncated
  ]
}
```

Notes:

- `visibleElements` should be capped (e.g. 60) and text truncated (e.g. 200 chars).
- If we can cheaply include “current tool” or “theme”, do it, but not required.

---

## Executor Responsibilities (Client)

Executor is intentionally boring:

- validate action schema
- enforce caps
- filter patch allowlist
- apply to `ExcalidrawImperativeAPI` using:
  - `updateScene({ elements: [...] })` for create/update/delete
  - `updateScene({ appState: { selectedElementIds } })` for select

No LLM calls here.

Undo story (MVP):

- optionally keep a small local stack of snapshots (elements array) before apply.
- this is local-only; syncing “undo” across participants is a bigger feature (skip initially).

---

## Planner Responsibilities (LLM)

Planner is the “brains”, but it’s still constrained:

- return `actions[]` only, no free-form element JSON mutation outside our contract
- be conservative (few elements, readable sizes, avoid clutter)
- prefer editing existing elements when possible (use IDs from context)

Where planner runs:

- recommended: Chalk backend endpoint (keeps keys private), returning `actions[]`
- executor still runs client-side (requirement satisfied)

---

## Boundary: sdk-react vs chalk-whiteboard (Avoid Intermingling)

We keep responsibilities clean:

`packages/chalk-whiteboard`:

- sync engines (legacy + v2 collab)
- Excalidraw element types/utilities for sync
- (optional later) pure helpers for agent patch filtering (no React, no network)

`packages/sdk-react`:

- agent UI overlay in `WhiteboardPanel`
- collecting `whiteboardContext` from `ExcalidrawImperativeAPI`
- calling planner endpoint
- executing validated actions via `updateScene`

Rule of thumb:

- If it touches React, it stays in `sdk-react`.
- If it’s pure Excalidraw element math/filtering, it can move to `chalk-whiteboard` later, but only when we need reuse.

---

## Don’t Step On These Rakes

```text
Rake: separate canvas server                -> no; Chalk already has Excalidraw + sync
Rake: model returns arbitrary element JSON  -> no; actions + allowlist + caps
Rake: replace entire scene every prompt     -> no; element-level ops only
Rake: vision/screenshot loop in v1          -> skip; add later if needed
Rake: demo-app-only implementation          -> no; sdk-react WhiteboardPanel
```

---

## MVP Implementation Milestones

1. Overlay UI (WhiteboardPanel): input + submit; visible only if `canDraw`.
2. Executor: implement actions + guardrails; wire to `excalidrawRef.current`.
3. Planner stub: return a fixed `actions[]` to prove end-to-end + sync.
4. Real planner: backend endpoint that returns `actions[]` from LLM.
5. Hardening: rate limiting, abuse caps, better context summarization.

---

## Open Questions (Next Iteration)

1. Planner endpoint location:
   - `apps/api` (Go) vs `apps/web` (CF Pages functions) vs separate service.
2. Auth model:
   - require room token to call planner; tie calls to participant id.
3. Model/provider:
   - which model first; latency targets; fallback strategy.
4. Rendering quality:
   - do we prefer creating shapes+text vs Excalidraw “label binding” patterns.
5. Multi-user concurrency:
   - when multiple people run prompts, we rely on existing Excalidraw versioning/sync conflict behavior.
