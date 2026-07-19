# @q9labsai/chalk-react

React UI components for Chalk meeting surfaces.

This package is intentionally presentational. It does not own joining, room
state, transport, permissions, diagnostics, recordings, transcripts, or other
meeting behavior. Applications pass real data and callbacks into the components.
Shared meeting behavior belongs in `@q9labsai/chalk-client` or the consuming
application.

## Installation

```bash
pnpm add @q9labsai/chalk-react @q9labsai/chalk-ui
```

## Setup

```tsx
import "@q9labsai/chalk-ui/styles.css";
```

## Import Surface

Use the narrowest import that matches the UI layer you need:

```tsx
import { Avatar, VideoTile } from "@q9labsai/chalk-react/atomic";
import { ChatPanel, ControlBar } from "@q9labsai/chalk-react/composite";
import { EndScreen, LoadingScreen } from "@q9labsai/chalk-react/full";
```

The root import is kept for convenience, but bundle-sensitive apps should prefer
the layer subpaths.

## What Is Not Here

There are no React meeting hooks, provider/session facades, turnkey join flows,
or debug export helpers in this package. The package does include the styled
`WhiteboardPanel`, backed by `@q9labsai/chalk-whiteboard`; callers still own its
room state and transport wiring.
