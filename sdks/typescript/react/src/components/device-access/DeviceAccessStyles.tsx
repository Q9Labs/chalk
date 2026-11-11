export function DeviceAccessStyles() {
  return (
    <style href="chalk-device-access" precedence="default">
      {DEVICE_ACCESS_CSS}
    </style>
  );
}

const DEVICE_ACCESS_CSS = `
.chalk-shell-split[data-blocked],
.chalk-shell-split[data-blocked][data-off="true"] {
  outline: 1px solid var(--chalk-danger);
  outline-offset: -1px;
}
.chalk-shell-split[data-blocked]:has(button:focus-visible) {
  outline: 2px solid var(--chalk-focus);
  outline-offset: 3px;
}
.chalk-shell-split[data-blocked] .chalk-shell-main {
  color: var(--chalk-danger-text);
}
.chalk-access-badge {
  position: absolute;
  top: -2px;
  inset-inline-start: 34px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--chalk-danger);
  color: var(--chalk-on-overlay);
  font-size: var(--type-micro);
  font-weight: 700;
  line-height: 14px;
  text-align: center;
  box-shadow: var(--elevation-halo-canvas);
  pointer-events: none;
}
.chalk-access-positioner {
  z-index: 40;
}
.chalk-access-card {
  position: relative;
  width: 320px;
  max-width: 100%;
  padding: var(--space-2);
  border-radius: var(--corner-3xl);
  border: 1px solid var(--chalk-line-strong);
  background: var(--chalk-popover);
  color: var(--chalk-text);
  box-shadow: var(--chalk-shadow);
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-2);
  font-family: var(--chalk-font-family);
}
.chalk-access-card:focus-visible { outline: none; }
.chalk-access-arrow {
  width: 12px;
  height: 12px;
  background: var(--chalk-popover);
  border-inline-end: 1px solid var(--chalk-line-strong);
  border-bottom: 1px solid var(--chalk-line-strong);
  translate: -50% 0;
  transform: rotate(45deg);
}
.chalk-access-arrow[data-side="top"] { bottom: -7px; }
.chalk-access-arrow[data-side="bottom"] { top: -7px; transform: rotate(225deg); }
.chalk-access-sheet-body {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3) var(--space-6);
}
.chalk-access-head {
  display: grid;
  grid-template-columns: 40px 1fr 32px;
  gap: var(--space-3);
  align-items: start;
  padding: var(--space-2) var(--space-1) 0 var(--space-2);
}
.chalk-access-glyph {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--chalk-hover);
}
.chalk-access-glyph[data-danger] { color: var(--chalk-danger-text); }
.chalk-access-head h3 { font-size: var(--type-body-lg); font-weight: 600; line-height: 1.3; padding-top: 1px; margin: 0; }
.chalk-access-head p { font-size: var(--type-body-sm); color: var(--chalk-muted-text); margin: var(--space-0-5) 0 0; line-height: 1.4; }
.chalk-access-close {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--chalk-muted-text);
  margin-block-start: calc(var(--space-1) * -1);
}
.chalk-access-close svg { width: 18px; height: 18px; }
.chalk-access-close:hover { background: var(--chalk-hover); }
.chalk-access-actions { display: flex; gap: var(--space-2); }
.chalk-access-actions > * {
  flex: 1;
  height: 40px;
  border-radius: var(--corner-pill);
  font-weight: 600;
  font-size: var(--type-body);
  display: grid;
  place-items: center;
  text-decoration: none;
  cursor: pointer;
}
.chalk-access-primary { background: var(--chalk-text); color: var(--chalk-canvas); }
.chalk-access-secondary { background: var(--chalk-hover); color: var(--chalk-text); }
.chalk-access-actions > *:focus-visible { outline: 2px solid var(--chalk-focus); outline-offset: 2px; }
.chalk-access-ill {
  border-radius: var(--corner-2xl);
  background: var(--chalk-hover);
  padding: var(--space-3);
  display: grid;
  gap: var(--space-2);
  grid-template-columns: minmax(0, 1fr);
}
.chalk-access-ill svg { width: 16px; height: 16px; flex: none; }
.chalk-access-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 32px;
  padding: 0 var(--space-2);
  border-radius: var(--corner-pill);
  background: var(--chalk-popover);
  border: 1px solid var(--chalk-line-strong);
  font-size: var(--type-caption);
  color: var(--chalk-muted-text);
}
.chalk-access-bar .icon { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; color: var(--chalk-text); flex: none; }
.chalk-access-bar .icon[data-hit] { outline: 2px solid var(--chalk-accent); }
.chalk-access-bar .icon[data-off] { color: var(--chalk-danger-text); }
.chalk-access-bar .icon svg { width: 14px; height: 14px; }
.chalk-access-bar .grow, .chalk-access-menu .grow { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chalk-access-menu {
  margin-inline-start: var(--space-4);
  border-radius: var(--corner-xl);
  background: var(--chalk-popover);
  border: 1px solid var(--chalk-line-strong);
  padding: var(--space-1);
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-0-5);
  font-size: var(--type-body-sm);
}
.chalk-access-menu[data-flush] { margin-inline-start: 0; }
.chalk-access-row { display: flex; align-items: center; gap: var(--space-2); min-height: 34px; padding: var(--space-1) var(--space-2); border-radius: var(--corner-lg); }
.chalk-access-row .grow { min-width: 0; white-space: normal; overflow: visible; }
.chalk-access-row[data-hit] { background: var(--chalk-hover); }
.chalk-access-row .value { color: var(--chalk-muted-text); display: inline-flex; align-items: center; gap: var(--space-1); }
.chalk-access-row .value svg { width: 14px; height: 14px; }
.chalk-access-row img { width: 18px; height: 18px; display: block; }
.chalk-access-path { font-size: var(--type-caption); color: var(--chalk-muted-text); padding: var(--space-1) var(--space-2) 0; }
.chalk-access-switch { width: 32px; height: 20px; border-radius: var(--corner-pill); background: var(--chalk-pressed); position: relative; flex: none; }
.chalk-access-switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: var(--chalk-on-overlay); }
.chalk-access-step {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--chalk-accent);
  color: var(--chalk-accent-text);
  font-size: var(--type-micro);
  font-weight: 700;
  display: grid;
  place-items: center;
  flex: none;
}
.chalk-access-menubar { display: flex; align-items: center; gap: var(--space-3); font-size: var(--type-caption); padding: 0 var(--space-2); color: var(--chalk-muted-text); }
.chalk-access-menubar b { color: var(--chalk-text); font-weight: 700; border-radius: var(--corner-sm); padding: 0 var(--space-1); outline: 2px solid var(--chalk-accent); }
.chalk-access-menubar .chalk-access-step { margin-inline-start: auto; }
.chalk-access-dim { position: fixed; inset: 0; z-index: 30; background: var(--chalk-canvas); opacity: 0.45; pointer-events: none; }
.chalk-access-coach {
  position: fixed;
  inset-inline-start: var(--space-8);
  top: 112px;
  z-index: 31;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 36px;
  padding: 0 var(--space-4) 0 var(--space-3);
  border-radius: var(--corner-pill);
  background: var(--chalk-text);
  color: var(--chalk-canvas);
  font-weight: 600;
  font-size: var(--type-body-sm);
  pointer-events: none;
}
.chalk-access-coach::before {
  content: "";
  position: absolute;
  top: -5px;
  inset-inline-start: 22px;
  width: 10px;
  height: 10px;
  transform: rotate(45deg);
  background: var(--chalk-text);
}
@media (max-width: 640px) {
  .chalk-access-dim, .chalk-access-coach { display: none; }
  .chalk-access-actions > * { height: 48px; }
}
@media (prefers-reduced-motion: reduce) {
  .chalk-access-card { transition: none; }
}
`;
