export function ShellStyles() {
  return (
    <style href="chalk-call-shell" precedence="default">
      {CALL_SHELL_CSS}
    </style>
  );
}
const CALL_SHELL_CSS = `.chalk-shell-dock {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 44px;
  width: 100%;
  pointer-events: none;
}
.chalk-shell-layout.chalk-icon-button {width:40px;height:40px;background:var(--chalk-surface);}
.chalk-shell-layout.chalk-icon-button:hover {background:var(--chalk-raised);}
.chalk-shell-danger {color:var(--chalk-danger-text);}
.chalk-shell-dock > * {
  pointer-events: auto;
  flex-shrink: 0;
}
.chalk-shell-split {
  display: flex;
  height: 44px;
  border-radius: 999px;
  background: var(--chalk-raised);
  position: relative;
}
.chalk-shell-split > button,
.chalk-shell-split > span > button {
  height: 44px;
  display: grid;
  place-items: center;
  transition: transform 0.15s ease-out;
}
.chalk-shell-main {
  width: 48px;
  padding-inline-start: 4px;
  border-radius: 999px 0 0 999px;
}
.chalk-shell-caret {
  width: 36px;
  padding-inline-end: 6px;
  border-radius: 0 999px 999px 0;
  color: var(--chalk-muted-text);
}
.chalk-shell-caret svg {
  width: 16px;
  height: 16px;
}
.chalk-shell-split button:hover,
.chalk-shell-caret[aria-expanded="true"] {
  background: var(--chalk-hover);
}
.chalk-shell-split button:active {
  background: var(--chalk-pressed);
}
.chalk-shell-split[data-active="true"] {
  background: var(--chalk-text);
  color: var(--chalk-canvas);
}
.chalk-shell-split[data-active="true"] .chalk-shell-caret {
  color: inherit;
}
.chalk-shell-split[data-off="true"] .chalk-shell-main {
  color: var(--chalk-danger-text);
}
.chalk-shell-split svg {
  width: 20px;
  height: 20px;
}
.chalk-shell-warning {
  position: absolute;
  top: -3px;
  inset-inline-start: 30px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--chalk-warning, #dcb740);
  color: #16140c;
  font-size: 11px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  box-shadow: 0 0 0 2px var(--chalk-canvas);
  pointer-events: none;
}
.chalk-shell-muted-hint {
  position: absolute;
  bottom: 56px;
  inset-inline-start: 0;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--chalk-text);
  color: var(--chalk-canvas);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}
.chalk-shell-gap {
  width: 8px;
}
.chalk-shell-dot {
  position: absolute;
  top: 6px;
  inset-inline-end: 6px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--chalk-warning, #dcb740);
  box-shadow: 0 0 0 2px var(--chalk-raised);
}
.chalk-shell-corner {
  position: absolute;
  bottom: 0;
  pointer-events: auto;
}
.chalk-shell-people {
  inset-inline-start: 20px;
}
.chalk-shell-chat {
  inset-inline-end: 20px;
}
.chalk-shell-phone {
  display: none;
}
.chalk-shell-preview {
  position: relative;
  height: 150px;
  margin: 0 0 6px;
  overflow: hidden;
  border-radius: 8px;
  background: var(--chalk-canvas);
}
.chalk-shell-preview video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.chalk-shell-preview small {
  position: absolute;
  left: 8px;
  bottom: 8px;
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  background: rgba(12,14,18,.75);
  font-size: 12px;
  display: flex;
  align-items: center;
  color: #fff;
}
.chalk-shell-menu-separator {height:1px;background:var(--chalk-line);margin:6px 4px;}
.chalk-shell-level {
  display: block;
  height: 4px;
  width: 100%;
  background: var(--chalk-pressed);
  border-radius: 2px;
  overflow: hidden;
}
.chalk-shell-level i {
  display: block;
  height: 100%;
  background: var(--chalk-positive);
  transform-origin: left;
  transition: transform 80ms linear;
}
.chalk-shell-device-label {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 5px;
  min-width: 0;
}
.chalk-shell-source {min-height:52px;}
.chalk-shell-source .chalk-shell-device-label {gap:2px;}
.chalk-shell-device-label small {display:block;font-size:12px;color:var(--chalk-muted-text);white-space:normal;line-height:1.3;}
.chalk-shell-menu-switch {
  display: flex;
  margin-inline-start: auto;
  pointer-events: none;
}
.chalk-shell-menu-switch .chalk-switch {display:block;}
.chalk-shell-more-group .chalk-sheet-row + .chalk-sheet-row {box-shadow:inset 0 1px 0 var(--chalk-line);}
.chalk-shell-sheet-end {margin-inline-start:auto;color:var(--chalk-muted-text);}
.chalk-shell-section {
  padding: 4px 0 8px;
  border-top: 1px solid var(--chalk-line);
}
.chalk-shell-details-heading + .chalk-shell-section {
  border: 0;
}
.chalk-shell-label {
  padding: 8px 10px 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--chalk-muted-text);
}
.chalk-shell-link {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 6px;
  justify-content: space-between;
  height: 44px;
  padding: 0 4px 0 14px;
  border-radius: 999px;
  background: var(--chalk-hover);
  font-weight: 500;
}
.chalk-shell-link > span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  user-select: text;
}
.chalk-shell-qr-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 10px 6px 2px;
}
.chalk-shell-qr-row p {font-size:13px;color:var(--chalk-soft-text);}
.chalk-shell-diagnostics {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 5px 14px;
  margin: 0 10px 10px;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}
.chalk-shell-diagnostics dt {
  color: var(--chalk-muted-text);
}
.chalk-shell-diagnostics dd {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}
.chalk-shell-detail-action {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 40px;
  padding: 0 10px;
  gap: 10px;
  border-radius: 9px;
  font-size: 14px;
  text-align: start;
}
.chalk-shell-detail-action:hover {
  background: var(--chalk-hover);
}
.chalk-shell-connection {justify-content:flex-start;}
.chalk-shell-connection > span:nth-child(2) {font-weight:500;}
.chalk-shell-connection .chalk-shell-connection-details {margin-inline-start:auto;color:var(--chalk-muted-text);font-size:12px;}
.chalk-shell-connection-bars {display:inline-flex;align-items:flex-end;gap:2px;height:15px;}
.chalk-shell-connection-bars i {width:3px;border-radius:1px;background:var(--chalk-positive);}
.chalk-shell-modal-heading .chalk-icon-button,.chalk-shell-details-heading .chalk-icon-button {background:transparent;color:var(--chalk-muted-text);}
.chalk-shell-modal-heading .chalk-icon-button:hover,.chalk-shell-details-heading .chalk-icon-button:hover {background:var(--chalk-hover);}
.chalk-shell-details-heading {display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 0 4px 10px;}
.chalk-shell-details-heading h2 {font-size:15px;font-weight:600;margin:0;}
.chalk-shell-diagnostics-copy {margin-left:6px;}
.chalk-shell-diagnostics-copy .chalk-copy {display:inline-flex;width:auto;height:32px;padding:0 12px;gap:6px;border-radius:999px;background:var(--chalk-raised);font-weight:600;}
.chalk-shell-diagnostics-copy .chalk-copy-label {font-size:13px;}
.chalk-shell-quality {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 15px;
}
.chalk-shell-quality i {
  width: 3px;
  border-radius: 1px;
  background: var(--chalk-pressed);
}
.chalk-shell-quality i:first-child {
  background: var(--chalk-warning, #dcb740);
}
.chalk-shell-modal-backdrop {
  position: absolute;
  inset: 0;
  z-index: 96;
  background: var(--chalk-scrim);
}
.chalk-shell-modal {
  position: absolute;
  top: 50%;
  left: 50%;
  translate: -50% -50%;
  z-index: 97;
  width: 400px;
  max-width: calc(100% - 32px);
  padding: 10px 12px 14px;
  background: var(--chalk-surface);
  border: 1px solid var(--chalk-line-strong);
  border-radius: 16px;
  box-shadow: 0 16px 40px rgba(0,0,0,.5);
  transition:transform .2s cubic-bezier(.16,1,.3,1);
}
.chalk-shell-modal[data-starting-style],.chalk-shell-modal[data-ending-style] {transform:translateY(8px);}
.chalk-shell-modal-backdrop {transition:opacity .18s ease-out;}
.chalk-shell-modal-backdrop[data-starting-style],.chalk-shell-modal-backdrop[data-ending-style] {opacity:0;}
[data-chalk-theme="light"] .chalk-shell-modal {box-shadow:0 0 0 1px var(--chalk-line),0 12px 32px rgba(0,0,0,.12);}
.chalk-shell-modal-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 0 4px 10px;
  font-size: 15px;
  font-weight: 600;
}
.chalk-shell-shortcuts {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px 16px;
  margin: 8px 10px 4px;
  font-size: 13px;
  align-items: center;
}
.chalk-shell-modal-heading h2,.chalk-shell-details-heading h2 {font-family:inherit;font-size:15px;font-weight:600;line-height:1.4;letter-spacing:normal;text-wrap:wrap;}
.chalk-shell-shortcuts dd {
  margin: 0;
  display: flex;
  gap: 4px;
  justify-content: flex-end;
}
.chalk-shell-shortcuts kbd {
  font:
    600 12px Figtree,
    system-ui,
    sans-serif;
  min-width: 24px;
  height: 24px;
  padding: 0 6px;
  display: inline-grid;
  place-items: center;
  border-radius: 6px;
  background: var(--chalk-hover);
  color: var(--chalk-text);
  box-shadow: inset 0 -1px 0 rgba(0,0,0,.4);
}
.chalk-shell-report {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}
.chalk-shell-report textarea {
  min-height: 96px;
  padding: 10px 12px;
  background: var(--chalk-raised);
  border: 1px solid var(--chalk-line-strong);
  border-radius: 10px;
  resize: none;
  margin:0 6px;
  font:inherit;
}
.chalk-shell-report label {
  font-size: 13px;
}
.chalk-shell-report textarea:focus {border-color:var(--chalk-text);}
.chalk-shell-report > label {font-weight:600;margin:4px 10px 0;}
.chalk-shell-report .chalk-shell-report-check {display:flex;align-items:center;gap:10px;min-height:40px;margin:4px 10px 0;padding:0 4px;font-size:13px;font-weight:600;}
.chalk-shell-report-check input {width:18px;height:18px;margin:0;accent-color:var(--chalk-text);}
.chalk-shell-report-actions {display:flex;justify-content:flex-end;gap:8px;margin:4px 6px 0;}
.chalk-shell-report-sent {display:flex;flex-direction:column;align-items:center;gap:6px;padding:18px 10px 6px;text-align:center;}
.chalk-shell-report-sent > svg {color:var(--chalk-positive);}
.chalk-shell-report-sent h2 {font-family:inherit;font-size:17px;font-weight:600;line-height:1.4;letter-spacing:normal;text-wrap:wrap;}
.chalk-shell-report-sent p {color:var(--chalk-text-soft);margin-bottom:10px;}
[data-chalk-theme="light"] .chalk-shell-split {
  box-shadow: 0 0 0 1px var(--chalk-line);
}
[data-chalk-theme="light"] .chalk-shell-dock .chalk-icon-button:not([data-chalk-tone="danger"]),
[data-chalk-theme="light"] .chalk-shell-people-pill,
[data-chalk-theme="light"] .chalk-shell-layout.chalk-icon-button {
  box-shadow: 0 0 0 1px var(--chalk-line);
}
[data-chalk-theme="light"] .chalk-shell-reactions {
  box-shadow: 0 0 0 1px var(--chalk-line), 0 12px 32px rgba(0, 0, 0, 0.12);
}
@media (max-width: 640px) {
  .chalk-shell-details-heading {display:none;}
  .chalk-shell-detail-action {min-height:48px;}
  .chalk-shell-diagnostics-copy .chalk-copy {height:44px;}
  .chalk-shell-dock {
    height: 52px;
    justify-content: space-between;
    gap: 0;
    padding-inline: 22px;
  }
  .chalk-frame-dock .chalk-shell-dock {width:calc(100% + 44px);margin-inline:-22px;}
  .chalk-shell-dock .chalk-shell-desktop,
  .chalk-shell-corner {
    display: none;
  }
  .chalk-shell-phone {
    display: contents;
  }
  .chalk-shell-split {
    height: 52px;
    background: none !important;
    box-shadow: none;
  }
  [data-chalk-theme="light"] .chalk-shell-split {box-shadow:0 0 0 1px var(--chalk-line);}
  .chalk-shell-split .chalk-shell-main {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    padding: 0;
    background: var(--chalk-raised);
  }
  .chalk-shell-split .chalk-shell-caret {
    display: none;
  }
  .chalk-shell-dock .chalk-icon-button {
    width: 52px;
    height: 52px;
  }
  .chalk-shell-modal {
    top: auto;
    bottom: 0;
    left: 0;
    translate: none;
    transform: none;
    width: 100%;
    max-width: none;
    border-radius: 24px 24px 0 0;
    padding-bottom: 42px;
  }
  .chalk-shell-detail-action {
    min-height: 48px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .chalk-shell-split button {
    transition: none;
  }
}
.chalk-shell-more-actions {
  display: flex;
  gap: 8px;
  padding: 8px;
}
.chalk-shell-recording {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.chalk-shell-recording i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--chalk-danger);
}
@media (max-width: 640px) {
  .chalk-shell-recording {
    display: none;
  }
}
.chalk-shell-people-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 14px 0 8px;
  border-radius: 999px;
  background: var(--chalk-surface);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  transition: transform 0.15s ease-out;
}
.chalk-shell-people-pill:hover {
  background: var(--chalk-raised);
}
.chalk-shell-people-pill:active {
  transform: scale(0.97);
}
.chalk-shell-faces {
  display: flex;
}
.chalk-shell-faces > * {
  box-shadow: 0 0 0 2px var(--chalk-surface);
}
.chalk-shell-faces > * + * {
  margin-inline-start: -7px;
}
.chalk-shell-reactions {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  padding: 6px;
  border: 1px solid var(--chalk-line-strong);
  border-radius: 999px;
  background: var(--chalk-popover);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
}
.chalk-shell-reactions-enter {animation:chalk-shell-reactions-in .18s cubic-bezier(.16,1,.3,1);}
@keyframes chalk-shell-reactions-in {from{opacity:0;translate:0 4px;}}
.chalk-shell-emoji {
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 50%;
  font-size: 22px;
  display: grid;
  place-items: center;
  transition: transform 0.12s ease-out;
}
.chalk-shell-emoji:hover {
  background: var(--chalk-hover);
}
.chalk-shell-emoji:active {
  transform: scale(0.9);
}
.chalk-shell-raise {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  border-radius: 999px;
  padding: 0 14px 0 10px;
  margin-inline-end: 4px;
  background: var(--chalk-hover);
  white-space: nowrap;
  font-size: 14px;
}
.chalk-shell-raise svg {width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round;}
.chalk-shell-raise svg {color:var(--chalk-muted-text);}
.chalk-shell-raise:hover {background:var(--chalk-pressed);}
.chalk-shell-raise[aria-pressed="true"] svg {color:#16140c;}
.chalk-shell-raise[aria-pressed="true"] {
  background: var(--chalk-warning, #dcb740);
  color: #16140c;
}
.chalk-shell-reactions-expanded {
  display: grid;
  grid-template-columns: repeat(6, 40px);
  border-radius: 16px;
}
.chalk-shell-reactions-expanded .chalk-shell-raise {
  grid-column: 1/-1;
}
@media (max-width: 640px) {
  .chalk-shell-reactions {
    flex-wrap: wrap;
    justify-content: center;
    width: 300px;
    border-radius: 22px;
  }
  .chalk-shell-raise {
    width: 100%;
    min-height:48px;
    justify-content: center;
    margin: 0 0 4px;
  }
  .chalk-shell-reactions-expanded {
    width: auto;
  }
  .chalk-shell-emoji::after {
    content: "";
    position: absolute;
    width: 44px;
    height: 44px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .chalk-shell-emoji,
  .chalk-shell-people-pill {
    transition: none;
  }
}
`;
