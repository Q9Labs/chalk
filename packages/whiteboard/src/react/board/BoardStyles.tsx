/** The board's look: the mockup's surfaces, island, zoom, chips and cursors, on the call's own tokens. */
export function BoardStyles() {
  return (
    <style href="chalk-board" precedence="default">
      {BOARD_CSS}
    </style>
  );
}

const BOARD_CSS = `.chalk-board {
  --board-shadow: 0 0 0 1px var(--chalk-line-strong), 0 8px 24px rgba(0,0,0,.35);
  --board-dot-gap: 24px;
  --board-dot-x: 0px;
  --board-dot-y: 0px;
  position: relative;
  height: 100%;
  overflow: clip;
  border-radius: inherit;
  background-color: var(--board-fill);
  color: var(--board-ink);
  font-family: var(--chalk-font-family, Figtree, system-ui, sans-serif);
  isolation: isolate;
}
.chalk-board[hidden] {display:none;}
.chalk-board[data-theme="light"] {--board-shadow: 0 0 0 1px var(--chalk-line-strong), 0 8px 24px rgba(0,0,0,.12);}
.chalk-board[data-surface="chalkboard"] {
  --board-fill: #1c2622;
  --board-ink: #f1f0ea;
  --board-muted: #aeb9b4;
  background-image: radial-gradient(120% 90% at 50% 35%, rgba(255,255,255,.05), transparent 70%), url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .05 0'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E");
}
.chalk-board[data-surface="paper"] {--board-fill: #eae6db; --board-ink: #1b1c1f; --board-muted: #5d5a52;}
.chalk-board[data-surface="paper"][data-theme="light"] {--board-fill: #f5f2ea;}
.chalk-board[data-surface="dots"] {
  --board-fill: var(--chalk-surface);
  --board-ink: var(--chalk-text);
  --board-muted: var(--chalk-muted-text);
  --board-dot: rgba(255,255,255,.11);
  background-image: radial-gradient(var(--board-dot) 1.3px, transparent 1.7px);
  background-size: var(--board-dot-gap) var(--board-dot-gap);
  background-position: var(--board-dot-x) var(--board-dot-y);
}
.chalk-board[data-surface="dots"][data-theme="light"] {--board-dot: rgba(0,0,0,.16);}

/* Excalidraw draws; none of its own interface shows. */
.chalk-board-engine {position:absolute; inset:0; transition:opacity .2s ease-out;}
.chalk-board:not([data-ready]) .chalk-board-engine:not(:has([role="alert"])) {opacity:0; pointer-events:none;}
.chalk-board-engine > [role="alert"] {background:var(--board-fill); color:var(--board-ink);}
.chalk-board:has(.chalk-board-engine > [role="alert"]) .chalk-board-loading {display:none;}
.chalk-board .excalidraw {--color-selection: var(--board-selection); background: transparent;}
.chalk-board .excalidraw :is(.layer-ui__wrapper, .context-menu, .HintViewer, .Modal, .welcome-screen-center, .library-menu, .sidebar, .App-toolbar, .App-bottom-bar, .FixedSideContainer, .popover, .scroll-back-to-content, .excalidraw-tooltip, .ToolIcon__hidden, .App-menu, .layer-ui__wrapper__footer) {display:none !important;}
body:has(.chalk-board) :is(.excalidraw-modal-container, .excalidraw-tooltip) {display:none !important;}
.chalk-board .excalidraw-wysiwyg {font-family: Nunito, var(--chalk-font-family, system-ui), sans-serif;}

.chalk-board-loading {position:absolute; inset:0; display:grid; place-content:center; justify-items:center; gap:12px; color:var(--board-muted); font-size:14px;}
.chalk-board-spinner {width:22px; height:22px; border-radius:50%; border:2px solid var(--board-muted); border-top-color:transparent; animation:chalk-board-spin .8s linear infinite; opacity:.8;}
@keyframes chalk-board-spin {to {transform:rotate(360deg);}}

.chalk-board-hint {position:absolute; inset:0; display:grid; place-content:center; justify-items:center; gap:14px; color:var(--board-muted); text-align:center; pointer-events:none; z-index:1;}
.chalk-board-hint p {margin:0; font-size:15px; max-width:280px; line-height:1.4; text-wrap:balance;}
.chalk-board-hint ul {list-style:none; margin:0; padding:0; display:flex; gap:18px; flex-wrap:wrap; justify-content:center; font-size:13px;}
.chalk-board-hint li {display:flex; align-items:center; gap:6px;}
.chalk-board-hint kbd {font:600 11px ui-monospace, SFMono-Regular, Menlo, monospace; padding:2px 6px; border-radius:5px; border:1px solid var(--board-muted); color:var(--board-muted);}

.chalk-board-note-layer {position:absolute; inset:0; z-index:2; cursor:crosshair; touch-action:none;}

.chalk-board-cursors {position:absolute; inset:0; z-index:3; pointer-events:none; overflow:hidden;}
.chalk-board-cursors[data-hidden] {display:none;}
.chalk-board-cursor {position:absolute; left:0; top:0; will-change:transform;}
.chalk-board-cursor-arrow {position:absolute; left:-3px; top:-3px; width:22px; height:26px; max-width:none; display:block; filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));}
.chalk-board-cursor-tag {position:absolute; left:12px; top:18px; display:flex; align-items:center; height:28px;}
.chalk-board-cursor-avatar {position:relative; z-index:1; box-shadow:0 0 0 2px rgba(255,255,255,.92); border-radius:50%;}
.chalk-board-cursor-name {position:absolute; left:14px; top:0; height:28px; display:flex; align-items:center; padding:0 11px 0 18px; border-radius:14px; white-space:nowrap; color:#fff; font:600 13px/1 var(--chalk-font-family, Figtree, system-ui, sans-serif); box-shadow:0 0 0 1.5px rgba(255,255,255,.92), 0 3px 10px rgba(0,0,0,.28); opacity:0; transform:translateX(-10px); transition:opacity .3s ease-out, transform .3s ease-out;}
.chalk-board-cursor[data-named="true"] .chalk-board-cursor-name {opacity:1; transform:none;}

.chalk-board :focus-visible {outline:2px solid var(--chalk-focus); outline-offset:2px;}
.chalk-board button {font:inherit; color:inherit; background:none; border:0; padding:0; cursor:pointer;}

.chalk-board-island, .chalk-board-zoom, .chalk-board .chalk-board-menu-button, .chalk-board-chip, .chalk-board-view-only {background:var(--chalk-surface); color:var(--chalk-text); box-shadow:var(--board-shadow);}
.chalk-board-chips {position:absolute; left:0; right:0; top:12px; z-index:5; display:flex; flex-direction:column; align-items:center; gap:8px; pointer-events:none;}
.chalk-board-chips[data-low] {top:76px;}
.chalk-board-chip {display:flex; align-items:center; gap:8px; height:36px; padding:0 6px 0 14px; border-radius:999px; font-size:13px; font-weight:600; pointer-events:auto;}
.chalk-board-chip[data-quiet] {padding:0 14px; font-weight:500;}
.chalk-board-chip svg {color:var(--chalk-muted-text);}
.chalk-board-chip-button {height:28px !important; padding:0 12px !important; border-radius:999px; background:var(--chalk-hover) !important; font-weight:600; font-size:13px;}
.chalk-board-view-only {position:absolute; left:12px; top:12px; z-index:5; height:30px; padding:0 12px; border-radius:999px; color:var(--chalk-soft-text); font-size:12px; font-weight:600; display:flex; align-items:center; gap:6px; box-shadow:0 0 0 1px var(--chalk-line-strong);}

.chalk-board-corner {position:absolute; right:12px; top:12px; z-index:5;}
.chalk-board-menu-button {width:40px; height:40px; border-radius:50%; display:grid; place-items:center; transition:transform .15s ease-out;}
.chalk-board-menu-button:hover {background:var(--chalk-raised);}
.chalk-board-menu-button:active {transform:scale(.94);}
.chalk-board-menu-button[aria-expanded="true"], .chalk-board-menu-button[data-popup-open] {background:var(--chalk-text); color:var(--chalk-canvas);}
.chalk-menu.chalk-board-menu {width:304px;}
.chalk-menu.chalk-board-menu-mobile {width:264px;}
.chalk-board-menu-mobile .chalk-menu-item {min-height:44px;}
.chalk-board-options {display:grid;}
.chalk-board-options .chalk-board-tile {display:flex; align-items:center; gap:10px; min-height:44px; padding:8px 10px; border:0; font-size:14px; font-weight:500; text-align:left;}
.chalk-board-options .chalk-board-tile-preview {width:22px; height:22px; flex:none;}
.chalk-board-options .chalk-board-tile-preview svg {display:none;}
.chalk-board-options .chalk-board-tile[data-checked] {border:0;}
.chalk-board-option-check {margin-left:auto;}
.chalk-board-menu-rule {border:0; border-top:1px solid var(--chalk-line); margin:4px 0;}
.chalk-board-menu-sublabel {padding:6px 10px 4px; font-size:12px; font-weight:600; color:var(--chalk-muted-text);}
.chalk-board-tiles {display:grid; grid-template-columns:repeat(3, 1fr); gap:6px; padding:2px 4px 8px;}
.chalk-board-tile {display:grid; gap:6px; justify-items:center; align-content:start; min-height:44px; padding:6px 4px 8px; border-radius:10px; border:2px solid transparent; font-size:12px; font-weight:600; color:var(--chalk-text); text-align:center; cursor:pointer; outline:none;}
.chalk-board-tile[data-highlighted], .chalk-board-tile:hover {background:var(--chalk-hover);}
.chalk-board-tile[data-checked] {border-color:var(--chalk-text);}
.chalk-board-tile-preview {display:block; position:relative; width:100%; height:38px; border-radius:6px; overflow:hidden; box-shadow:0 0 0 1px var(--chalk-line-strong);}
.chalk-board-tile-preview[data-surface="chalkboard"] {background:#1c2622; color:#f1f0ea;}
.chalk-board-tile-preview[data-surface="paper"] {background:#f5f2ea; color:#1b1c1f;}
.chalk-board-tile-preview[data-surface="dots"] {background:var(--chalk-surface) radial-gradient(var(--chalk-muted-text) 1px, transparent 1.5px) 0 0/8px 8px;}
.chalk-board-tile-preview[data-island] {background:var(--chalk-raised);}
.chalk-board-tile-preview[data-island] i {position:absolute; background:var(--chalk-text); border-radius:3px;}
.chalk-board-tile-preview[data-island="bottom"] i {left:30%; right:30%; bottom:5px; height:5px;}
.chalk-board-tile-preview[data-island="top"] i {left:30%; right:30%; top:5px; height:5px;}
.chalk-board-tile-preview[data-island="left"] i {left:5px; top:20%; bottom:20%; width:5px;}
.chalk-board-menu-kbd {margin-left:auto; padding-left:18px; font:600 11px ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--chalk-muted-text);}
.chalk-board-danger {display:contents; color:var(--chalk-danger-text);}
.chalk-board-picked {max-height:220px; overflow-y:auto; padding-left:16px;}
.chalk-board-picked-name {min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.chalk-board-picked-note {margin:0; padding:4px 10px 8px 26px; font-size:12px; line-height:1.4; color:var(--chalk-muted-text);}

.chalk-board-zoom {position:absolute; right:12px; bottom:12px; z-index:5; height:40px; display:flex; align-items:center; border-radius:999px; padding:0 4px; transition:translate .2s ease-out;}
.chalk-board-zoom button {height:32px; min-width:32px; border-radius:999px; display:grid; place-items:center; padding:0 6px !important; font-size:13px; font-weight:600; font-variant-numeric:tabular-nums;}
.chalk-board-zoom button:hover {background:var(--chalk-hover);}
.chalk-board-zoom-value {min-width:52px !important;}
.chalk-board-zoom-rule {width:1px; height:18px; background:var(--chalk-line-strong); margin:0 2px;}

.chalk-board-island {position:absolute; z-index:5; display:flex; align-items:center; gap:2px; padding:6px; border-radius:26px; max-width:calc(100% - 24px);}
.chalk-board-island[data-place="bottom"] {left:50%; bottom:12px; translate:-50% 0;}
.chalk-board-island[data-place="top"] {left:50%; top:12px; translate:-50% 0;}
.chalk-board-island[data-place="left"] {left:12px; top:50%; translate:0 -50%; flex-direction:column; max-height:calc(100% - 24px); overflow-y:auto; scrollbar-width:none;}
.chalk-board-island[data-place="compact"] {left:12px; bottom:12px; padding:4px;}
.chalk-board-island[data-place="expanded"] {left:12px; right:12px; bottom:12px; padding:4px; border-radius:28px; overflow-x:auto; scrollbar-width:none;}
.chalk-board-island[data-dragging] {z-index:6; cursor:grabbing; box-shadow:0 0 0 1px var(--chalk-line-strong), 0 14px 36px rgba(0,0,0,.45);}
.chalk-board:has(.chalk-board-island[data-place="expanded"]) .chalk-board-zoom {translate:0 -60px;}
.chalk-board[data-presentation="mobile"] .chalk-board-island {padding:4px; border-radius:28px;}
.chalk-board[data-presentation="mobile"]:has(.chalk-board-island[data-place="expanded"]) .chalk-board-zoom {translate:0 -64px;}
.chalk-board[data-presentation="mobile"][data-call-controls] :is(.chalk-board-island[data-place="compact"], .chalk-board-island[data-place="expanded"], .chalk-board-zoom) {bottom:76px;}
.chalk-board-group {display:contents;}
.chalk-board-separator {flex:none; width:1px; height:24px; margin:0 4px; background:var(--chalk-line-strong);}
.chalk-board-island[data-place="left"] .chalk-board-separator {width:24px; height:1px; margin:4px 0;}
.chalk-board-tool {width:40px; height:40px; flex:none; border-radius:50%; display:grid !important; place-items:center; position:relative; transition:transform .15s ease-out;}
.chalk-board-tool:hover {background:var(--chalk-hover);}
.chalk-board-tool:active {transform:scale(.92);}
.chalk-board-tool[aria-pressed="true"] {background:var(--chalk-text); color:var(--chalk-canvas);}
.chalk-board-tool[aria-pressed="true"]:hover {background:var(--chalk-text-strong);}
.chalk-board-tool:disabled {opacity:.35; cursor:default; transform:none; background:none;}
.chalk-board[data-compact] .chalk-board-tool {width:44px; height:44px;}
.chalk-board[data-presentation="mobile"] .chalk-board-tool {width:44px; height:44px;}
.chalk-board[data-presentation="mobile"] .chalk-board-zoom {height:52px;}
.chalk-board[data-presentation="mobile"] .chalk-board-zoom button {height:44px; min-width:44px;}
.chalk-board[data-presentation="mobile"] .chalk-board-menu-button {width:44px; height:44px;}
@media (pointer:coarse) {.chalk-board-tool {width:44px; height:44px;}}
.chalk-board-tool-caret {position:absolute; right:3px; bottom:3px;}
.chalk-board-tool-swatch {width:22px; height:22px; border-radius:50%; box-shadow:0 0 0 2px var(--chalk-surface), 0 0 0 3.5px var(--chalk-muted-text);}
.chalk-board-tool-dot {position:absolute; right:5px; bottom:5px; width:11px; height:11px; border-radius:50%; box-shadow:0 0 0 2px var(--chalk-surface);}
.chalk-board-grip {width:22px; height:40px; flex:none; display:grid !important; place-items:center; border-radius:12px; color:var(--chalk-muted-text) !important; cursor:grab !important; touch-action:none;}
.chalk-board-grip:hover {background:var(--chalk-hover); color:var(--chalk-text) !important;}
.chalk-board-island[data-place="left"] .chalk-board-grip {width:40px; height:22px;}
.chalk-board-island[data-place="left"] .chalk-board-grip svg {transform:rotate(90deg);}
@media (pointer:coarse) {.chalk-board-grip {width:26px; height:44px;} .chalk-board-island[data-place="left"] .chalk-board-grip {width:44px; height:26px;}}
.chalk-board-kbd {font:600 11px ui-monospace, monospace; margin-left:6px; padding:1px 5px; border-radius:4px; background:rgba(127,127,127,.28);}

.chalk-board-dropzone {position:absolute; z-index:4; border:2px dashed var(--board-selection); border-radius:28px; background:rgba(125,184,255,.08); opacity:.45; pointer-events:none; transition:opacity .15s ease-out;}
.chalk-board-dropzone[data-near] {opacity:1;}
.chalk-board-dropzone[data-zone="left"] {left:6px; top:12px; bottom:12px; width:70px;}
.chalk-board-dropzone[data-zone="bottom"] {left:12px; right:12px; bottom:6px; height:70px;}
.chalk-board-dropzone[data-zone="top"] {left:12px; right:12px; top:6px; height:70px;}

.chalk-board-colors {display:grid; gap:10px; padding:4px;}
.chalk-board-swatches {display:flex; gap:2px;}
.chalk-board-swatch, .chalk-board-width {width:40px; height:40px; border-radius:50%; display:grid; place-items:center; flex:none; color:var(--chalk-text); background:none; border:0; cursor:pointer;}
@media (pointer:coarse) {.chalk-board-swatch, .chalk-board-width {width:44px; height:44px;}}
.chalk-board-swatch:hover, .chalk-board-width:hover {background:var(--chalk-hover);}
.chalk-board-swatch i {width:24px; height:24px; border-radius:50%; box-shadow:0 0 0 1px var(--chalk-muted-text); display:grid; place-items:center;}
.chalk-board-swatch[aria-checked="true"] i {box-shadow:0 0 0 2px var(--chalk-popover), 0 0 0 4px var(--chalk-text);}
.chalk-board-width i {display:block; width:22px; border-radius:99px; background:var(--chalk-text);}
.chalk-board-width[aria-checked="true"] {background:var(--chalk-text);}
.chalk-board-width[aria-checked="true"] i {background:var(--chalk-canvas);}

.chalk-board-announcer {position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap;}

@media (max-width: 640px), (pointer: coarse) {
  .chalk-board-zoom {height:52px;}
  .chalk-board-zoom button {height:44px; min-width:44px;}
  .chalk-board-menu-button {width:44px; height:44px;}
}
@media (prefers-reduced-motion: reduce) {
  .chalk-board-spinner {animation:none;}
  .chalk-board-engine, .chalk-board-cursor-name, .chalk-board-zoom {transition:none;}
  .chalk-board-cursor-name {transform:none !important;}
}
`;
