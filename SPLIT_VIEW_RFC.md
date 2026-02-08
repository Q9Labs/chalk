# Split View Architecture (Whiteboard + Screen Share)

## 1. Objective
Enable users to view **Screen Share** and **Whiteboard** simultaneously to facilitate workflows like:
*   **Lectures:** Teacher shares slides (Screen), students take notes (Whiteboard).
*   **Code Review:** Reviewer shares IDE (Screen), team diagrams architecture (Whiteboard).

## 2. Core Layout Architecture
The "Main Stage" (currently mutually exclusive Video/Screen/Board) will be upgraded to a **Split Stage**.

### Current vs New
*   **Current:** `VideoGrid` XOR `ScreenShare` XOR `Whiteboard`
*   **New:** `SplitContainer` containing `[LeftPane]` and `[RightPane]`.

### Conflict Resolution Matrix
How the Split View interacts with existing UI modes:

| Scenario | Behavior | Visual |
| :--- | :--- | :--- |
| **Grid + Split** | Video Grid collapses to **Filmstrip**. | `[ Split View ] / [ Filmstrip (Bottom) ]` |
| **Spotlight + Split** | Content overrides Spotlight. Spotlighted user goes to Filmstrip. | `[ Split View ] / [ Filmstrip (Bottom) ]` |
| **Sidebar (Chat) + Split** | Sidebar pushes the Split View, compressing both panes. | `[ Screen (35%) ][ Board (35%) ][ Sidebar (30%) ]` |
| **Mobile (Portrait)** | Split View is disabled. Uses **Tabbed** mode. | `[ Tab: Screen ] [ Tab: Board ]` |
| **Tablet (Landscape)** | Split View is allowed, but Sidebar (Chat) overlays content. | `[ Screen ][ Board ]` + `(Floating Chat)` |

## 3. Interaction Design: "The Smart Docket" (Selected)
We will use a **Central Divider Docket** to manage the split state without menu diving. It sits on the `react-resizable-panels` handle.

### Visual Specification

**State 1: Default Split (50/50)**
```ascii
+---------------------------------------+
|                   |                   |
|   SCREEN SHARE    |   WHITEBOARD      |
|     (Left)        |     (Right)       |
|                   |                   |
|                .-----.                |
|               ( < | > )               | <--- The Docket (Center)
|                '-----'                |
|                   |                   |
+---------------------------------------+
```

**State 2: Maximize Left (Screen Share Focus)**
User clicks `<` or drags handle to the right edge.
```ascii
+---------------------------------------+
|                                       |
|                                       |
|          SCREEN SHARE (FULL)          |
|                                     .---.
|                                    (  <  ) <--- Docked to Right Edge
|                                     '---'
|                                       |
+---------------------------------------+
```

**State 3: Maximize Right (Whiteboard Focus)**
User clicks `>` or drags handle to the left edge.
```ascii
+---------------------------------------+
|                                       |
|                                       |
|           WHITEBOARD (FULL)           |
.---.                                   |
(  >  )                                   | <--- Docked to Left Edge
'---'                                   |
|                                       |
+---------------------------------------+
```

### Controls & Tooltips
*   **`<` (Left Chevron):** "Expand Screen Share" (Hotkeys: `Alt + [`)
    *   *Action:* Right pane collapses to 0 width. Docket sticks to right edge.
*   **`>` (Right Chevron):** "Expand Whiteboard" (Hotkeys: `Alt + ]`)
    *   *Action:* Left pane collapses. Docket sticks to left edge.
*   **`|` (Grip):** "Drag to Resize"
    *   *Action:* Drag to resize split ratio.
    *   *Double Click:* Resets to 50/50.

## 4. Future Considerations (Sidelined Options)
These interaction models are preserved for reference if the "Smart Docket" proves insufficient or confusing in user testing.

### Option B: Floating Headers (Picture-in-Picture Style)
Each view behaves like an independent window with its own controls overlaying the content.

**Visual:**
```ascii
+---------------------------------------+-------------------------------+
| SCREEN SHARE                          | WHITEBOARD                    |
| +-----------------------------------+ | +---------------------------+ |
| | [Icon: Expand] [Icon: Close]      | | | [Icon: Expand] [Icon: Close]|
| |                                   | | |                           | |
| |       Content                     | | |        Content            | |
| |                                   | | |                           | |
| +-----------------------------------+ | +---------------------------+ |
+---------------------------------------+-------------------------------+
```
*   **Pros:** Explicit control per window; familiar to OS window management.
*   **Cons:** Visual clutter overlaying content; difficult to manage shared edges (e.g., resizing one doesn't clearly imply resizing the other).

### Option C: Tabbed Switcher (Top Bar)
A mode toggle explicitly separated from the content area.

**Visual:**
```ascii
+-----------------------------------------------------------------------+
|                    (  Split  |  Screen  |  Board  )                   |
+-----------------------^-------------^---------------------------------+
|                       |             |                                 |
|    [Tooltip: Both]____|             |____[Tooltip: Focus Screen]      |
|                                                                       |
|      SCREEN SHARE                   WHITEBOARD                        |
|                                                                       |
+-----------------------------------------------------------------------+
```
*   **Pros:** Very clear "Mode" state; impossible to "lose" a view (unlike dragging off-screen).
*   **Cons:** Consumes vertical space; disconnects control from the content interaction; feels more "app-like" and less "immersive".

### Option D: The "Vertical Stack" (Portrait Friendly)
Best for vertical monitors or coding (top) + notes (bottom).

**Visual:**
```ascii
+-----------------------------------------------------------------------+
|   SCREEN SHARE (Presentation Mode)                                    |
|  +-----------------------------------------------------------------+  |
|  |  import React from 'react';                                     |  |
|  +-----------------------------------------------------------------+  |
+============================[ DRAG HANDLE ]============================+
|   WHITEBOARD (Notes)                                                  |
|                                                 [ Tools: (P) (E) (T)] |
+-----------------------------------------------------------------------+
```
*   **Pros:** Great for "Tall" content like code or documents.
*   **Cons:** Poor fit for standard 16:9 videos or slide decks.

## 5. Implementation Plan
1.  **Dependencies:** `react-resizable-panels` (Standard in Shadcn UI).
2.  **Components:**
    *   `SplitStage.tsx`: Wrapper for the panels.
    *   `DocketControl.tsx`: The custom handle component.
3.  **State Logic:**
    *   Update `VideoConference.tsx` to support implicit `layout: "split"`.
    *   Logic: `const isSplit = showScreenShare && isWhiteboardOpen;`
