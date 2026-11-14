import { ConnectionBars } from "../connection-notice/ConnectionBars";
import { ConnectionRing } from "../connection-status/ConnectionRing";

/** How a guest's own link reads on their tile. Level 2 is weak and level 1 is very poor. */
export function TileSignal({ name, level }: { readonly name: string; readonly level: 1 | 2 }) {
  const words = level === 1 ? "Very poor connection" : "Weak connection";
  return (
    <span role="img" data-part="tile-signal" aria-label={`${name}: ${words.toLowerCase()}`} title={words} className="chalk-tile-signal">
      <TileConnectionStyles />
      <ConnectionBars level={level} />
      <span className="chalk-tile-signal-words">{words}</span>
    </span>
  );
}

/** A guest who dropped out of the call and is trying to come back: the tile dims and shows a ring and their name. */
export function TileReconnecting({ name }: { readonly name: string }) {
  return (
    <>
      <div aria-hidden="true" className="chalk-tile-dim" />
      <div role="status" data-part="tile-reconnecting" className="chalk-tile-reconnecting">
        <TileConnectionStyles />
        <span className="chalk-tile-reconnecting-ring">
          <ConnectionRing />
        </span>
        <span className="chalk-tile-reconnecting-label">{name} is reconnecting…</span>
      </div>
    </>
  );
}

function TileConnectionStyles() {
  return (
    <style href="chalk-tile-connection" precedence="default">
      {TILE_CSS}
    </style>
  );
}

const TILE_CSS = `.chalk-tile-signal {position:absolute;top:var(--space-2);left:var(--space-2);z-index:30;display:inline-flex;align-items:center;gap:var(--space-2);height:24px;padding:0 var(--space-2);border-radius:var(--corner-md);background:var(--chalk-overlay);color:var(--chalk-on-overlay);font-size:var(--type-caption);font-weight:500;white-space:nowrap;pointer-events:auto;}
.chalk-tile-signal-words {display:none;}
@container (min-width: 200px) {
  .chalk-tile-signal {height:28px;padding:0 var(--space-3) 0 var(--space-2-5);}
  .chalk-tile-signal-words {display:inline;}
}
.chalk-tile-dim {position:absolute;inset:0;z-index:20;pointer-events:none;background:color-mix(in srgb, var(--chalk-canvas) 50%, transparent);}
.chalk-tile-reconnecting {position:absolute;z-index:30;left:50%;top:56%;transform:translate(-50%,-50%);display:grid;justify-items:center;gap:var(--space-2);max-width:calc(100% - 16px);color:var(--chalk-text);font-size:var(--type-body-sm);font-weight:500;text-align:center;pointer-events:none;}
.chalk-tile-reconnecting-ring {width:40px;height:40px;display:grid;place-items:center;border-radius:50%;background:color-mix(in srgb, var(--chalk-canvas) 78%, transparent);}
.chalk-tile-reconnecting-ring .chalk-connection-ring {width:24px;height:24px;}
.chalk-tile-reconnecting-label {padding:var(--space-1) var(--space-2-5);border-radius:var(--corner-pill);background:color-mix(in srgb, var(--chalk-canvas) 78%, transparent);}
@container (max-width: 199.98px) or (max-height: 119.98px) {
  .chalk-tile-reconnecting-label {position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;padding:0;}
}
`;
