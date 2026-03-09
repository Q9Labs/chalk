# Whiteboard AI Agent Support: Excalidraw MCP Research

Date: 2026-02-12

Goal: understand how the "official" Excalidraw MCP works (data model, tools, transport, iteration loop) and whether it fits Chalk's existing Excalidraw-based whiteboard.

Repos reviewed (cloned locally):

- `excalidraw/excalidraw-mcp` (official org repo; MCP App style)
- `yctimlin/mcp_excalidraw` (non-official; "live canvas toolkit" MCP server + canvas app)
- `i-tozer/excalidraw-mcp` (non-official; simpler MCP server)

Links:

```text
https://github.com/excalidraw/excalidraw-mcp
https://github.com/yctimlin/mcp_excalidraw
https://github.com/i-tozer/excalidraw-mcp
```

---

## Executive Summary

`excalidraw/excalidraw-mcp` is an MCP App server meant to render an interactive Excalidraw diagram _inline in chat_, not to control an existing Excalidraw instance embedded in another product.

Key properties:

- "Prompt in, diagram out" via a **single** rendering tool (`create_view`).
- The model outputs a **JSON array of Excalidraw-like elements** (plus a few pseudo-elements for camera + delete + restore).
- Persistence exists only via a **checkpoint** mechanism so the model can append/edit without resending everything.
- User can edit fullscreen inside the widget; the widget sends a **text diff** back into model context and persists checkpoint state server-side.

If Chalk needs "user types prompt; Chalk whiteboard changes live", the official MCP is more of a reference implementation for:

- element JSON conventions to feed Excalidraw
- incremental update strategies (checkpoint/restore + delete pseudo-element)
- closed-loop edits (user edits captured; model context updated)

But it is not a drop-in integration to drive Chalk's in-room Excalidraw canvas.

---

## Official Excalidraw MCP (`excalidraw/excalidraw-mcp`)

### What it ships

MCP App server that returns an interactive HTML widget (Excalidraw viewer/editor) rendered directly inside MCP-capable clients.

Main dependencies visible in `package.json`:

- `@modelcontextprotocol/ext-apps` (MCP Apps UI extension)
- `@modelcontextprotocol/sdk` (transport: stdio + streamable HTTP)
- `@excalidraw/excalidraw` (element conversion + svg export + serialization)

### Transports / deployment modes

`src/main.ts`:

- Default: Streamable HTTP server at `/mcp` (intended for remote hosting, e.g. Vercel).
- Optional: `--stdio` to run as a local stdio MCP server.

### Tool surface (model-facing)

Model-visible tools:

- `read_me`
- `create_view`

App-only (widget-only) tools:

- `export_to_excalidraw` (uploads encrypted payload to `json.excalidraw.com`, returns a share URL)
- `save_checkpoint` (persist user-edited elements into the checkpoint store)
- `read_checkpoint` (read persisted state when restoring)

### Element format: "real" elements + pseudo-elements

The server guides the model via a large inlined cheat-sheet string (`RECALL_CHEAT_SHEET` in `src/server.ts`) returned by `read_me`.

The element array passed into `create_view` is a JSON string (`elements: z.string()`), parsed server-side.

Pseudo-element types supported (seen in `src/server.ts` and `src/mcp-app.tsx`):

- `cameraUpdate`
- `restoreCheckpoint`
- `delete`

Core semantics:

- `cameraUpdate` defines the viewport rectangle (x, y, width, height).
- `restoreCheckpoint` loads a previous saved scene and appends new elements on top.
- `delete` removes elements by id (also removes bound text via `containerId` matching). In the viewer, deleted elements may be hidden via near-zero opacity rather than removed to preserve SVG node order for morph-based animation.

### Checkpoints: incremental editing without resending the full scene

`create_view`:

- Generates a `checkpointId`.
- Persists a resolved `elements[]` array into a checkpoint store.
- Returns `checkpointId` to the model (and also in `structuredContent`).

When the model wants to edit an existing diagram:

- It sends `[{"type":"restoreCheckpoint","id":"<checkpointId>"}, ...new elements...]`.
- It can include `delete` pseudo-elements to remove specific ids while restoring.

This is "stateful enough for iteration", but not element-level CRUD tools.

### Rendering approach (client widget)

`src/mcp-app.tsx` is the UI.

Notable techniques:

- Streaming-friendly parse:
  - `parsePartialElements()` tries to parse partial JSON arrays while a response is still streaming.
  - Drops incomplete last item to avoid crashes.
- Conversion:
  - `convertRawElements()` uses `convertToExcalidrawElements(..., { regenerateIds: false })`.
  - Preserves pseudo-elements (cameraUpdate/delete/restoreCheckpoint) alongside converted Excalidraw elements.
- SVG pipeline:
  - Uses `exportToSvg` from `@excalidraw/excalidraw`.
  - Uses `morphdom` to morph old SVG DOM into new SVG DOM for smooth, incremental animation without hard re-mounting.
- Viewport control:
  - Extracts `cameraUpdate` and uses it to control the "camera" effect.
  - Fixes SVG viewBox toward 4:3 for nicer framing.
- Fullscreen editing + feedback loop:
  - `src/edit-context.ts` tracks initial element snapshot, computes a compact diff of user edits (added/removed/moved).
  - Debounced (`DEBOUNCE_MS = 2000`) calls:
    - `app.callServerTool(save_checkpoint, ...)` to persist user-edited scene
    - `app.updateModelContext(...)` to feed text diff into the model's context
  - Also persists into localStorage for the widget instance.

### Export/share to excalidraw.com

`export_to_excalidraw` server tool (app-only):

- Serializes the scene JSON.
- Packs it in Excalidraw v2 binary format, deflates it, encrypts with AES-GCM, uploads to `https://json.excalidraw.com/api/v2/post/`.
- Returns a URL like `https://excalidraw.com/#json=<id>,<key>`.

### What this implies for Chalk

Useful as reference / building blocks:

- element JSON conventions (including label binding behavior)
- checkpoint/restore model for iterative edits
- "user edited the diagram" diff -> push back into model context
- export pipeline to excalidraw.com (if we ever want it)

Mismatch with Chalk whiteboard:

- It renders a separate Excalidraw widget inside the chat client.
- It does not directly integrate with an existing Excalidraw canvas instance embedded in Chalk.
- Model updates are "send a new elements array"; no first-class CRUD tool surface.

---

## Non-Official: Live Canvas Toolkit (`yctimlin/mcp_excalidraw`)

Why this matters: it is explicitly designed to let an agent iteratively manipulate a _live_ canvas via element-level tools, including screenshot feedback. That aligns more closely with "AI draws on Chalk's whiteboard".

### Two-process architecture

Per `README.md`:

- Canvas server: web UI + REST + WebSocket updates (`http://localhost:3000` default)
- MCP server: stdio MCP tools; syncs to the canvas server via `EXPRESS_SERVER_URL`

### Tool surface

See `skills/excalidraw-skill/references/cheatsheet.md`:

- Element CRUD: create/update/delete/get/query, batch create, duplicate
- Layout: align/distribute, group/ungroup, lock/unlock
- Scene awareness: `describe_scene` + `get_canvas_screenshot`
- Import/export: `.excalidraw` JSON + PNG/SVG export
- State: snapshots, clear
- Viewport: `set_viewport`
- Mermaid -> Excalidraw: `create_from_mermaid`

### How it "draws" technically

Backend (`src/server.ts`):

- Keeps an in-memory `Map<id, element>` of a simplified element model (`ServerElement`).
- Exposes REST endpoints:
  - `POST /api/elements` create
  - `PUT /api/elements/:id` update
  - `DELETE /api/elements/:id` delete
  - `POST /api/elements/batch` batch create
  - `POST /api/elements/sync` overwrite scene
  - plus query, snapshot, export, viewport
- Broadcasts element events to connected browsers via WebSocket.

MCP server (`src/index.ts`):

- Defines tools and translates tool calls into REST calls against the canvas server.
- For screenshot/export/viewport it uses a request/response bridge:
  - MCP -> Express endpoint -> WS message to frontend -> frontend performs the Excalidraw API operation -> POSTs result back -> MCP returns it.

### What this implies for Chalk

The useful part is the _pattern_:

- Tool-calling interface is CRUD + "camera" + "visual feedback".
- Keep a tight allow-list of editable element keys.
- Closed loop verification: screenshot/describe before/after.

But we likely do not want their separate canvas server since Chalk already embeds Excalidraw and already has sync.

---

## Practical Takeaways (for a Chalk decision later)

1. "Natural language prompt to drawing" is not solved by MCP itself.
   The core is still: model -> element operations -> apply into Excalidraw -> sync to other participants.

2. Official MCP is an in-chat renderer/editor with checkpoint iteration.
   Great reference, not a direct "drive my in-product whiteboard" integration.

3. The live-canvas toolkit approach matches the product need better:
   element-level tools + visual feedback loop + permissioning.

Next decision inputs (not implemented here):

- Where should the agent run (client vs server) for Chalk rooms?
- What is the tool contract (create/update/delete/select/viewport/export) and permission model?
- How to prevent abuse (rate limits, max element count, allowed props, room scoping)?

---

## Chalk Recommendation (Client-Run Agent)

Constraint from Hasan: agent should run on the client.

Decision: **do not adopt the official Excalidraw MCP as-is** for Chalk.

Why:

- Official MCP is an MCP App: it renders its own Excalidraw widget inside the MCP client (Claude/ChatGPT/etc.).
- Chalk already has an embedded Excalidraw whiteboard (in-room) plus sync; we need to mutate that live instance.
- Official tool surface is basically `create_view` (send full element array). We want element-level ops and tight control.

What to borrow from the official MCP:

- "Pseudo-elements" idea for edits: `delete` + `restoreCheckpoint` (conceptually).
- Viewport framing as a first-class action (`cameraUpdate` concept).
- User edit feedback loop: compute a diff and feed back into agent context (but in Chalk we'd use actual element state + selection).

### Proposed Architecture

Client responsibilities (in-room):

- UI: prompt input + run/stop + "apply preview" toggle.
- Collect context from Excalidraw API:
  - selection ids
  - visible elements summary (ids/types/x/y/w/h/text)
  - optionally current viewport (scrollX/scrollY/zoom)
- Execute tool calls locally against `ExcalidrawImperativeAPI`:
  - create/update/delete/select
  - optional viewport changes (scroll/zoom)
- Let existing whiteboard sync broadcast the resulting element changes (same as any other local edit).

LLM responsibilities:

- Convert natural language intent into tool calls with constrained schemas.
- No direct access to the whiteboard; only via tool calls + provided context.

LLM call placement (still compatible with "client-run"):

- Recommend: **client calls a Chalk-owned backend endpoint** that talks to the model (keeps model keys private).
- If we truly require "no server", then need BYO key + direct client-to-model, which is a product/security decision.

### Tool Contract (minimal set)

Start with 4 tools (mirrors what we prototyped before, but as a stable SDK feature):

- `whiteboard_create(elements[], regenerateIds?)`
- `whiteboard_update(updates[{id, patch}])` with strict allow-list of patch keys
- `whiteboard_delete(ids[])` (soft delete via `isDeleted: true`)
- `whiteboard_select(ids[])` (optional; nice UX)

Later:

- `whiteboard_viewport({scrollX,scrollY,zoom}|{zoomToFit:true}|{centerOnIds:[...]})`
- `whiteboard_describe()` and/or screenshot-based verification for iterative refinement

### Safety / Abuse Controls (client-side + server-side)

Client:

- Max element operations per request (e.g. <= 50 creates/updates, <= 200 deletes).
- Patch allow-list (position/size/text/colors/stroke/etc; forbid anything that breaks sync or embeds external resources).
- Enforce min font sizes / avoid micro-elements (quality guardrails).

Server (if used for LLM):

- Rate-limit per room + per participant.
- Cap context size: summarize elements (top N) instead of full scene.
- Optional: require host permission to run agent, or require whiteboard draw permission.

### Integration Point In Chalk

Best home:

- `packages/sdk-react/src/components/full/WhiteboardPanel.tsx`
  - already owns the `ExcalidrawImperativeAPI` ref and sync wiring
  - agent UI can be an overlay inside this panel

Avoid:

- demo-app-only overlays (we removed the previous `apps/web` experiment already).
