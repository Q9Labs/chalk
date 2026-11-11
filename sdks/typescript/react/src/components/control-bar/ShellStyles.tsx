export function ShellStyles() {
  return (
    <style href="chalk-call-shell" precedence="default">
      {CALL_SHELL_CSS}
    </style>
  );
}
/** Phone rules follow a narrow window, or a narrow call inside a wider window. */
const phoneRules = (rules: string) => `@media (max-width: 640px) {${rules}}
@container chalk-call (max-width: 640px) {${rules}}`;
const CALL_SHELL_CSS = `.chalk-shell-dock {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  height: 44px;
  width: 100%;
  pointer-events: none;
}
.chalk-shell-layout.chalk-icon-button {width:40px;height:40px;background:var(--chalk-surface);}
.chalk-shell-layout.chalk-icon-button:hover {background:var(--chalk-raised);}
.chalk-shell-danger {color:var(--chalk-danger-text);}
.chalk-sheet-label-text {
  flex: none;
  white-space: nowrap;
}
.chalk-sheet-value {
  flex: 1;
  min-width: 0;
  text-align: end;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--type-body);
  color: var(--chalk-muted-text);
}
.chalk-sheet-badge {
  display: grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 var(--space-1-5);
  border-radius: var(--corner-lg);
  background: var(--chalk-accent);
  color: var(--chalk-accent-text);
  font-size: var(--type-caption);
  font-weight: 700;
}
.chalk-shell-dock > * {
  pointer-events: auto;
  flex-shrink: 0;
}
.chalk-shell-split {
  display: inline-flex;
  width: max-content;
  height: 44px;
  border-radius: var(--corner-pill);
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
  padding-inline-start: var(--space-1);
  border-radius: var(--corner-pill) 0 0 var(--corner-pill);
}
.chalk-shell-caret {
  width: 36px;
  padding-inline-end: var(--space-1-5);
  border-radius: 0 var(--corner-pill) var(--corner-pill) 0;
  color: var(--chalk-muted-text);
}
.chalk-shell-caret svg {
  width: 16px;
  height: 16px;
}
.chalk-shell-muted-hint.chalk-shell-background-hint {inset-inline-start:50%;transform:translateX(-50%);width:max-content;max-width:calc(100vw - 32px);white-space:normal;}
[data-chalk] .chalk-shell-split button:focus {
  outline: 0;
  box-shadow: none;
}
.chalk-shell-split:has(button:focus-visible) {
  outline: 2px solid var(--chalk-focus);
  outline-offset: 3px;
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
.chalk-shell-split > .chalk-shell-main {
  transition: transform 0.15s ease-out, color 0.18s cubic-bezier(0.2, 0.7, 0.2, 1);
}
.chalk-shell-media-body {
  opacity: 1;
  transition: opacity 0.12s ease-out;
}
.chalk-shell-media-cut,
.chalk-shell-media-slash {
  stroke-dasharray: 1 1;
  stroke-dashoffset: 1;
  opacity: 0;
  transition: stroke-dashoffset 0.18s cubic-bezier(0.2, 0.7, 0.2, 1), opacity 0s 0.18s;
}
.chalk-shell-media[data-slashed="true"] .chalk-shell-media-cut,
.chalk-shell-media[data-slashed="true"] .chalk-shell-media-slash {
  stroke-dashoffset: 0;
  opacity: 1;
  transition: stroke-dashoffset 0.18s cubic-bezier(0.2, 0.7, 0.2, 1), opacity 0s;
}
.chalk-shell-media-trace {
  opacity: 0;
  stroke-dasharray: 0.24 0.76;
  transition: opacity 0.12s ease-out;
}
.chalk-shell-media[data-busy="true"] .chalk-shell-media-body {
  opacity: 0.4;
}
.chalk-shell-media[data-busy="true"] .chalk-shell-media-trace {
  opacity: 1;
  animation: chalk-shell-trace 1.1s linear infinite;
}
@keyframes chalk-shell-trace {
  to {stroke-dashoffset: -1;}
}
.chalk-shell-dock .chalk-shell-reactions-button {
  transition: transform 0.15s ease-out, background-color 0.18s ease-out, color 0.18s ease-out, box-shadow 0.18s ease-out;
}
.chalk-shell-reactions-button svg {
  grid-area: 1 / 1;
  transition: transform 0.32s cubic-bezier(0.3, 1.4, 0.5, 1), opacity 0.18s ease-out;
}
.chalk-shell-reactions-button .chalk-shell-reactions-hand {
  opacity: 0;
  transform: translateY(6px) rotate(-20deg) scale(0.6);
}
.chalk-shell-dock .chalk-shell-reactions-button[aria-expanded="true"] {
  background: var(--chalk-pressed);
}
.chalk-shell-dock .chalk-shell-reactions-button[data-hand-raised],
.chalk-shell-dock .chalk-shell-reactions-button[data-hand-raised]:hover,
.chalk-shell-dock .chalk-shell-reactions-button[data-hand-raised]:active {
  background: var(--chalk-warning);
  color: var(--chalk-accent-text);
}
.chalk-shell-dock .chalk-shell-reactions-button[data-hand-raised][aria-expanded="true"] {
  /* token-ratchet-ignore: a 3px ring in the pressed role colour; no ring token exists */
  box-shadow: 0 0 0 3px var(--chalk-pressed);
}
.chalk-shell-reactions-button[data-hand-raised] .chalk-shell-reactions-smile {
  opacity: 0;
  transform: rotate(90deg) scale(0.4);
}
.chalk-shell-reactions-button[data-hand-raised] .chalk-shell-reactions-hand {
  opacity: 1;
  transform: none;
  animation: chalk-shell-hand-wave 0.42s ease-out;
}
@keyframes chalk-shell-hand-wave {
  from {opacity: 0; transform: translateY(6px) rotate(-20deg) scale(0.6);}
  55% {opacity: 1; transform: rotate(12deg);}
  78% {transform: rotate(-8deg);}
}
.chalk-shell-warning {
  position: absolute;
  top: -3px;
  inset-inline-start: 30px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--chalk-warning);
  color: var(--chalk-accent-text);
  font-size: var(--type-caption);
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  box-shadow: var(--elevation-halo-canvas);
  pointer-events: none;
}
.chalk-shell-muted-hint {
  position: absolute;
  bottom: 56px;
  inset-inline-start: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--corner-xl);
  background: var(--chalk-text);
  color: var(--chalk-canvas);
  font-size: var(--type-body-sm);
  font-weight: 600;
  white-space: nowrap;
}
.chalk-shell-dot {
  position: absolute;
  top: 6px;
  inset-inline-end: 6px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--chalk-warning);
  box-shadow: var(--elevation-halo-raised);
}
.chalk-shell-corner {
  position: absolute;
  bottom: 0;
  pointer-events: auto;
}
.chalk-shell-people {
  inset-inline-start: 20px;
}
.chalk-shell-record {
  inset-inline-start: 72px;
}
@media (min-width: 641px) and (max-width: 800px) {
  .chalk-shell-record {
    inset-inline-start: 20px;
    bottom: 52px;
  }
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
  margin: 0 0 var(--space-1-5);
  overflow: hidden;
  border-radius: var(--corner-lg);
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
  padding: 0 var(--space-2);
  border-radius: var(--corner-md);
  background: var(--chalk-overlay);
  font-size: var(--type-caption);
  display: flex;
  align-items: center;
  color: var(--chalk-on-overlay);
}
.chalk-shell-menu-separator {height:1px;background:var(--chalk-line);margin:var(--space-1-5) var(--space-1);}
.chalk-shell-level {
  display: block;
  height: 4px;
  width: 100%;
  background: var(--chalk-pressed);
  border-radius: var(--corner-xs);
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
  gap: var(--space-1-5);
  min-width: 0;
}
.chalk-shell-source {min-height:52px;}
.chalk-shell-source .chalk-shell-device-label {gap:var(--space-0-5);}
.chalk-shell-device-label small {display:block;font-size:var(--type-caption);color:var(--chalk-muted-text);white-space:normal;line-height:1.3;}
.chalk-shell-menu-switch {
  display: flex;
  margin-inline-start: auto;
  pointer-events: none;
}
.chalk-shell-menu-switch .chalk-switch {display:block;}
.chalk-shell-more-group .chalk-sheet-row + .chalk-sheet-row {box-shadow: var(--elevation-divider-top);}
.chalk-shell-sheet-end {margin-inline-start:auto;color:var(--chalk-muted-text);}
.chalk-invite-link,.chalk-shell-detail-action,.chalk-details-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 40px;
  padding: 0 var(--space-3);
  border-radius: var(--corner-xl);
  font-size: var(--type-body);
  text-align: start;
}
.chalk-invite-link:hover,.chalk-shell-detail-action:hover,.chalk-shell-detail-action[aria-expanded="true"],.chalk-invite-link[data-copied="true"] {background:var(--chalk-hover);}
.chalk-shell-detail-lead,.chalk-invite-link-lead {width:18px;display:grid;place-items:center;flex:none;color:var(--chalk-muted-text);}
.chalk-shell-detail-label,.chalk-invite-link-label {flex:1;min-width:0;}
.chalk-shell-detail-trail,.chalk-invite-link-end {display:inline-flex;align-items:center;gap:var(--space-1);color:var(--chalk-muted-text);}
.chalk-invite-link[data-copied="true"] .chalk-invite-link-end {color:var(--chalk-positive);}
.chalk-invite-link[data-variant="card"] {
  height: 48px;
  padding: 0 var(--space-3) 0 var(--space-4);
  border-radius: var(--corner-2xl);
  background: var(--chalk-hover);
  font-weight: 500;
}
.chalk-invite-link[data-variant="card"]:hover {background:var(--chalk-pressed);}
.chalk-invite-link[data-variant="card"][data-copied="true"] {background:var(--chalk-hover);}
.chalk-invite-link[data-variant="card"][data-copied="true"] .chalk-invite-link-label {color:var(--chalk-positive);}
.chalk-details .chalk-switch,.chalk-shell-report .chalk-switch {width:40px;height:24px;}
.chalk-details .chalk-switch > span:first-child,.chalk-shell-report .chalk-switch > span:first-child {width:18px;height:18px;}
.chalk-details .chalk-switch[aria-checked="true"] > span:first-child,.chalk-shell-report .chalk-switch[aria-checked="true"] > span:first-child {transform:translateX(16px);}
.chalk-shell-modal-heading .chalk-icon-button,.chalk-shell-details-heading .chalk-icon-button {background:transparent;color:var(--chalk-muted-text);}
.chalk-shell-modal-heading .chalk-icon-button:hover,.chalk-shell-details-heading .chalk-icon-button:hover {background:var(--chalk-hover);}
.chalk-shell-details-heading {display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-2);padding:var(--space-2) var(--space-1) var(--space-3) var(--space-3);}
.chalk-shell-details-heading h2 {font-size:var(--type-body-lg);font-weight:600;line-height:1.3;margin:0;}
.chalk-shell-details-sub {display:flex;align-items:center;gap:var(--space-1-5);margin:var(--space-0-5) 0 0;color:var(--chalk-muted-text);font-size:var(--type-body-sm);}
.chalk-shell-details-sub i {width:8px;height:8px;border-radius:50%;background:var(--chalk-danger);}
.chalk-shell-diagnostics-copy {margin:0 0 var(--space-2) var(--space-2);}
.chalk-shell-diagnostics-copy .chalk-copy {display:inline-flex;width:auto;height:32px;padding:0 var(--space-3);gap:var(--space-1-5);border-radius:var(--corner-pill);background:var(--chalk-hover);font-weight:500;}
.chalk-shell-diagnostics-copy .chalk-copy:hover {background:var(--chalk-pressed);}
.chalk-shell-diagnostics-copy .chalk-copy-label {font-size:var(--type-caption);}
.chalk-shell-diagnostics-copy .chalk-copy-icon,.chalk-shell-diagnostics-copy .chalk-copy-icon svg {width:14px;height:14px;}
.chalk-shell-quality {
  display: inline-flex;
  align-items: flex-end;
  gap: var(--space-0-5);
  height: 15px;
}
.chalk-shell-quality i {
  width: 3px;
  border-radius: var(--corner-xs);
  background: var(--chalk-pressed);
}
.chalk-shell-quality i:first-child {
  background: var(--chalk-warning);
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
  padding: var(--space-2-5) var(--space-3) var(--space-3);
  background: var(--chalk-surface);
  border: 1px solid var(--chalk-line-strong);
  border-radius: var(--corner-2xl);
  box-shadow: var(--chalk-shadow);
  transition:transform .2s cubic-bezier(.16,1,.3,1);
}
.chalk-shell-modal[data-starting-style],.chalk-shell-modal[data-ending-style] {transform:translateY(8px);}
.chalk-shell-modal-backdrop {transition:opacity .18s ease-out;}
.chalk-shell-modal-backdrop[data-starting-style],.chalk-shell-modal-backdrop[data-ending-style] {opacity:0;}
[data-chalk-theme="light"] .chalk-shell-modal {box-shadow:var(--chalk-shadow);}
.chalk-shell-modal-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-0-5) 0 var(--space-1) var(--space-2-5);
  font-size: var(--type-body-lg);
  font-weight: 600;
}
.chalk-shell-shortcuts {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--space-2-5) var(--space-4);
  margin: var(--space-2) var(--space-2-5) var(--space-1);
  font-size: var(--type-body-sm);
  align-items: center;
}
.chalk-shell-modal-heading h2,.chalk-shell-details-heading h2 {font-family:inherit;font-size:var(--type-body-lg);font-weight:600;line-height:1.4;letter-spacing:normal;text-wrap:wrap;}
.chalk-shell-shortcuts dd {
  margin: 0;
  display: flex;
  gap: var(--space-1);
  justify-content: flex-end;
}
.chalk-shell-shortcuts kbd {
  font:
    600 var(--type-caption) Figtree,
    system-ui,
    sans-serif;
  min-width: 24px;
  height: 24px;
  padding: 0 var(--space-1-5);
  display: inline-grid;
  place-items: center;
  border-radius: var(--corner-md);
  background: var(--chalk-hover);
  color: var(--chalk-text);
  box-shadow: var(--elevation-divider-bottom);
}
.chalk-shell-report {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.chalk-shell-report-field {display:flex;flex-direction:column;min-height:72px;margin:0 var(--space-1-5);padding:var(--space-2-5) var(--space-3);border-radius:var(--corner-xl);background:var(--chalk-hover);font-size:var(--type-body);}
.chalk-shell-report-field:focus-within {box-shadow:var(--elevation-outline);}
.chalk-shell-report-field textarea {flex:1;min-height:0;padding:0;border:0;outline:0;background:transparent;resize:none;font:inherit;}
.chalk-shell-report-count {align-self:flex-end;margin-top:auto;font-size:var(--type-caption);color:var(--chalk-muted-text);}
.chalk-shell-report-check {display:flex;align-items:center;gap:var(--space-3);margin:0 var(--space-1-5);padding:var(--space-3) var(--space-1);font-size:var(--type-body-sm);}
.chalk-shell-report-check > span:first-child {flex:1;}
.chalk-shell-report-check small {display:block;color:var(--chalk-muted-text);font-size:var(--type-caption);}
.chalk-shell-report-actions {display:flex;justify-content:flex-end;gap:var(--space-2);margin:var(--space-1) var(--space-1-5) 0;}
.chalk-shell-report-sent {display:flex;flex-direction:column;align-items:center;gap:var(--space-1-5);padding:var(--space-4) var(--space-2-5) var(--space-1-5);text-align:center;}
.chalk-shell-report-sent > svg {color:var(--chalk-positive);}
.chalk-shell-report-sent h2 {font-family:inherit;font-size:var(--type-lead);font-weight:600;line-height:1.4;letter-spacing:normal;text-wrap:wrap;}
.chalk-shell-report-sent p {color:var(--chalk-text-soft);margin-bottom:var(--space-2-5);}
[data-chalk-theme="light"] .chalk-shell-split {
  box-shadow: var(--elevation-hairline);
}
[data-chalk-theme="light"] .chalk-shell-dock .chalk-icon-button:not([data-chalk-tone="danger"]),
[data-chalk-theme="light"] .chalk-shell-people-pill,
[data-chalk-theme="light"] .chalk-shell-layout.chalk-icon-button {
  box-shadow: var(--elevation-hairline);
}
[data-chalk-theme="light"] .chalk-shell-reactions {
  box-shadow: var(--chalk-shadow);
}
${phoneRules(`
  .chalk-shell-details-heading {display:none;}
  .chalk-shell-detail-action,.chalk-invite-link[data-variant="menu"],.chalk-details-row {min-height:48px;}
  .chalk-shell-diagnostics-copy .chalk-copy {height:44px;}
  .chalk-shell-dock {
    height: 52px;
    justify-content: space-between;
    gap: 0;
    padding-inline: var(--space-6);
  }
  .chalk-frame-dock .chalk-shell-dock {width:calc(100% + var(--space-6) * 2);margin-inline:calc(var(--space-6) * -1);}
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
  [data-chalk-theme="light"] .chalk-shell-split {box-shadow: var(--elevation-hairline);}
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
    border-radius: var(--corner-3xl) var(--corner-3xl) 0 0;
    padding-bottom: var(--space-10);
  }
  .chalk-shell-detail-action {
    min-height: 48px;
  }
`)}
@media (prefers-reduced-motion: reduce) {
  .chalk-shell-split button,
  .chalk-shell-split > .chalk-shell-main,
  .chalk-shell-media-body,
  .chalk-shell-media-cut,
  .chalk-shell-media-slash,
  .chalk-shell-media-trace,
  .chalk-shell-dock .chalk-shell-reactions-button,
  .chalk-shell-reactions-button svg {
    transition: none;
  }
  .chalk-shell-media[data-busy="true"] .chalk-shell-media-trace {
    animation: none;
    opacity: 0;
  }
  .chalk-shell-reactions-button[data-hand-raised] .chalk-shell-reactions-hand {
    animation: none;
  }
}
.chalk-shell-more-actions {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2);
}
.chalk-shell-recording {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  font-size: var(--type-body-sm);
}
.chalk-shell-recording i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--chalk-danger);
}
${phoneRules(`
  .chalk-shell-recording {
    display: none;
  }
`)}
.chalk-shell-people-pill {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 40px;
  padding: 0 var(--space-3) 0 var(--space-2);
  border-radius: var(--corner-pill);
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
.chalk-shell-people-badge {
  display: grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 var(--space-1-5);
  border-radius: var(--corner-pill);
  background: var(--chalk-accent);
  color: var(--chalk-accent-text);
  font-size: var(--type-caption);
  font-weight: 700;
}
.chalk-shell-faces {
  display: flex;
}
.chalk-shell-faces > * {
  box-shadow: var(--elevation-halo-surface);
}
.chalk-shell-faces > * + * {
  margin-inline-start: calc(var(--space-2) * -1);
}
.chalk-shell-reactions {
  display: flex;
  align-items: center;
  gap: var(--space-0-5);
  min-width: 0;
  padding: var(--space-1-5);
  border: 1px solid var(--chalk-line-strong);
  border-radius: var(--corner-pill);
  background: var(--chalk-popover);
  box-shadow: var(--chalk-shadow);
}
.chalk-shell-reactions-enter {animation:chalk-shell-reactions-in .18s cubic-bezier(.16,1,.3,1);}
@keyframes chalk-shell-reactions-in {from{opacity:0;translate:0 4px;}}
.chalk-shell-emoji {
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 50%;
  font-size: var(--type-title);
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
/* A fixed 24px box with line-height 1 puts the glyph on the circle's true centre. */
.chalk-shell-emoji > span {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
  font-size: var(--type-title);
  line-height: 1;
  transform-origin: 50% 60%;
}
.chalk-shell-emoji:hover > span {
  animation: var(--chalk-shell-emoji-move, chalk-shell-emoji-pop) 0.9s cubic-bezier(0.3, 1.3, 0.5, 1) infinite;
}
.chalk-shell-emoji[data-move="nod"] {--chalk-shell-emoji-move: chalk-shell-emoji-nod;}
.chalk-shell-emoji[data-move="beat"] {--chalk-shell-emoji-move: chalk-shell-emoji-beat;}
.chalk-shell-emoji[data-move="shake"] {--chalk-shell-emoji-move: chalk-shell-emoji-shake;}
.chalk-shell-emoji[data-move="wiggle"] {--chalk-shell-emoji-move: chalk-shell-emoji-wiggle;}
.chalk-shell-emoji[data-move="clap"] {--chalk-shell-emoji-move: chalk-shell-emoji-clap;}
@keyframes chalk-shell-emoji-nod {
  0%, 100% {transform: scale(0.88) rotate(0);}
  40% {transform: scale(0.94) rotate(-14deg) translateY(-1px);}
}
@keyframes chalk-shell-emoji-beat {
  0%, 100% {transform: scale(0.88);}
  20% {transform: scale(1.04);}
  40% {transform: scale(0.9);}
  55% {transform: scale(1);}
}
@keyframes chalk-shell-emoji-shake {
  0%, 100% {transform: scale(0.9) rotate(0);}
  20% {transform: scale(0.9) rotate(-10deg);}
  40% {transform: scale(0.9) rotate(10deg);}
  60% {transform: scale(0.9) rotate(-6deg);}
}
@keyframes chalk-shell-emoji-pop {
  0%, 100% {transform: scale(0.88);}
  35% {transform: scale(1.04) translateY(-1px);}
}
@keyframes chalk-shell-emoji-wiggle {
  0%, 100% {transform: scale(0.9) rotate(0);}
  25% {transform: scale(0.9) rotate(-12deg);}
  60% {transform: scale(0.9) rotate(8deg);}
}
@keyframes chalk-shell-emoji-clap {
  0%, 100% {transform: scale(0.9);}
  15% {transform: scale(0.8, 0.98);}
  30% {transform: scale(0.94);}
  45% {transform: scale(0.8, 0.98);}
}
.chalk-shell-raise {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 40px;
  border-radius: var(--corner-pill);
  padding: 0 var(--space-3) 0 var(--space-2-5);
  white-space: nowrap;
  font-size: var(--type-body);
  font-weight: 500;
}
.chalk-shell-raise svg {width:18px;height:18px;flex:none;}
.chalk-shell-raise:not([aria-pressed="true"]):hover {background:var(--chalk-hover);}
.chalk-shell-raise[aria-pressed="true"] {
  background: var(--chalk-warning);
  color: var(--chalk-accent-text);
}
.chalk-shell-rule {
  width: 1px;
  height: 24px;
  margin: 0 var(--space-1);
  flex: none;
  background: var(--chalk-line-strong);
}
.chalk-shell-reactions-expanded {
  display: grid;
  grid-template-columns: repeat(6, 40px);
  border-radius: var(--corner-2xl);
}
.chalk-shell-reactions-expanded .chalk-shell-raise {
  grid-column: 1/-1;
}
.chalk-shell-reactions-expanded .chalk-shell-rule {
  display: none;
}
${phoneRules(`
  .chalk-shell-reactions {
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--space-0-5) 0;
    width: 300px;
    border-radius: var(--corner-3xl);
  }
  .chalk-shell-raise {
    width: 100%;
    height: 48px;
    justify-content: center;
    border-radius: 18px;
    background: var(--chalk-hover);
    margin: 0 0 var(--space-1);
  }
  .chalk-shell-raise:not([aria-pressed="true"]):hover {background:var(--chalk-pressed);}
  .chalk-shell-rule {
    display: none;
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
`)}
@media (prefers-reduced-motion: reduce) {
  .chalk-shell-emoji,
  .chalk-shell-people-pill {
    transition: none;
  }
  .chalk-shell-emoji:hover > span {
    animation: none;
  }
}
`;
