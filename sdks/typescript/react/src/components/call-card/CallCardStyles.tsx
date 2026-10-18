const styles = `.call-card-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px 0 10px;
  border-bottom: 1px solid var(--chalk-line);
}
.call-card-tab {
  height: 46px;
  padding: 0 10px;
  color: var(--chalk-muted-text);
  font-weight: 600;
  position: relative;
}
.call-card-tab:hover {
  color: var(--chalk-text);
}
.call-card-tab[aria-selected="true"] {
  color: var(--chalk-text);
}
.call-card-tab[aria-selected="true"]::after {
  content: "";
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--chalk-text);
}
.call-card-tab .call-card-count {
  color: var(--chalk-muted-text);
  font-weight: 500;
  margin-left: 5px;
  font-variant-numeric: tabular-nums;
}
.call-card-tab.unread::before {
  content: "";
  position: absolute;
  right: 0;
  top: 13px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--chalk-accent);
}
.call-card-tabs .call-card-close {
  margin-left: auto;
}
.call-chat-messages {
  flex: 1;
  overflow: auto;
  padding: 8px;
  scrollbar-width: thin;
  scrollbar-color: var(--chalk-hover) transparent;
}
.call-people-search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  margin: 2px 2px 8px;
  padding: 0 14px;
  border-radius: 999px;
  background: var(--chalk-raised);
  color: var(--chalk-muted-text);
}
.call-people-search:focus-within {
  box-shadow: 0 0 0 2px var(--chalk-text);
}
.call-people-search svg {
  width: 16px;
  height: 16px;
}
.call-people-search input {
  flex: 1;
}
.call-people-search input::placeholder,
.comp input::placeholder,
.lcard input::placeholder {
  color: var(--chalk-muted-text);
}
.call-host-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 2px 2px 8px;
}
.call-host-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 12px 0 10px;
  border-radius: 999px;
  background: var(--chalk-raised);
  font-size: 13px;
  font-weight: 600;
  transition: transform 0.15s ease-out;
}
.call-host-button:hover,
.call-host-button[aria-expanded="true"] {
  background: var(--chalk-hover);
}
.call-host-button:active {
  transform: scale(0.97);
}
.call-host-button:disabled {
  opacity: 0.45;
  cursor: default;
  transform: none;
}
.call-host-button svg {
  width: 16px;
  height: 16px;
  color: var(--chalk-muted-text);
}
.call-host-button .chev {
  width: 14px;
  height: 14px;
}
.call-mute-confirm {
  width: 280px;
  padding: 8px 8px 4px;
}
.call-mute-confirm b {
  font-size: 15px;
  font-weight: 600;
}
.call-mute-confirm p {
  font-size: 13px;
  color: var(--chalk-soft-text);
  margin: 4px 0 10px;
}
.call-people-section {
  font-size: 12px;
  font-weight: 600;
  color: var(--chalk-muted-text);
  padding: 10px 8px 6px;
}
.call-person-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 52px;
  padding: 0 4px 0 8px;
  border-radius: 12px;
}
.call-person-row:hover {
  background: var(--chalk-raised);
}
.call-person-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.call-person-name small {
  font-size: 13px;
  color: var(--chalk-muted-text);
  font-weight: 400;
  margin-left: 5px;
}
.call-person-state {
  display: grid;
  place-items: center;
}
.call-person-state svg {
  width: 16px;
  height: 16px;
}
.call-person-state.mo {
  color: var(--chalk-danger-text);
}
.call-person-state.hd {
  color: var(--chalk-warning);
}
.call-person-options {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--chalk-muted-text);
  flex: none;
}
.call-person-options:hover,
.call-person-options[aria-expanded="true"] {
  background: var(--chalk-hover);
  color: var(--chalk-text);
}
.call-no-people {
  padding: 16px 8px;
  color: var(--chalk-muted-text);
  font-size: 13px;
}
.call-message-group {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin: 12px 4px 0;
}
.call-message-group.is-local {
  flex-direction: row-reverse;
}
.call-message-column {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  max-width: 240px;
  min-width: 0;
}
.is-local .call-message-column {
  align-items: flex-end;
}
.call-message-heading {
  font-size: 12px;
  color: var(--chalk-muted-text);
  margin: 0 4px 1px;
  font-variant-numeric: tabular-nums;
}
.call-message-heading b {
  color: var(--chalk-text);
  font-weight: 600;
  margin-right: 6px;
}
.call-message-bubble {
  background: var(--chalk-raised);
  border-radius: 18px;
  padding: 8px 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
  user-select: text;
}
.call-message-status {
  font-size: 11px;
  color: var(--chalk-muted-text);
  margin: 0 6px;
}
.call-message {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  max-width: 100%;
  border-radius: 14px;
}
.is-local .call-message {
  align-items: flex-end;
}
.call-message-body {
  display: flex;
  flex-direction: column;
  align-items: inherit;
  gap: 4px;
  max-width: 100%;
  transition: opacity 0.15s ease-out;
}
.call-message.sending .call-message-body,
.call-message.failed .call-message-body {
  opacity: 0.55;
}
.call-message-status.err {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--chalk-danger-text);
  font-size: 12px;
}
.call-message-status.err svg {
  width: 14px;
  height: 14px;
}
.call-attachments {
  display: grid;
  gap: 2px;
  width: 240px;
  max-width: 100%;
  border-radius: 14px;
  overflow: hidden;
}
.call-attachments.two,
.call-attachments.three,
.call-attachments.four {
  grid-template-columns: 1fr 1fr;
}
.call-photo {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  background: var(--chalk-raised);
  border-radius: 3px;
}
.call-attachments.one .call-photo {
  border-radius: 14px;
}
.call-photo::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 0 0 1px var(--chalk-line);
  pointer-events: none;
}
.call-attachments.three .call-photo:nth-child(3) {
  grid-column: span 2;
  aspect-ratio: 2;
}
.call-photo img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.call-photo:not(:disabled):hover img {
  transform: scale(1.03);
}
.call-photo:disabled {
  cursor: default;
}
.call-photo.load {
  display: grid;
  place-items: center;
  color: var(--chalk-muted-text);
  animation: shim 1s ease-in-out infinite alternate;
}
@keyframes shim {
  to {
    opacity: 0.45;
  }
}
.call-file {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 240px;
  max-width: 100%;
  min-height: 56px;
  padding: 8px 6px 8px 10px;
  border-radius: 14px;
  background: var(--chalk-raised);
  border: 1px solid var(--chalk-line);
}
.call-file.exp {
  background: none;
  border-style: dashed;
  border-color: var(--chalk-line-strong);
}
.call-file.exp b {
  color: var(--chalk-muted-text);
}
.call-file-name {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.call-file-name b {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.call-file-name small {
  font-size: 12px;
  color: var(--chalk-muted-text);
  line-height: 1.25;
}
.call-file-name small.er {
  color: var(--chalk-danger-text);
}
.call-file-type {
  width: 36px;
  height: 36px;
  border-radius: 9px;
  flex: none;
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.04em;
  color: #fff;
}
.call-file-type.ti,
.call-file-type.tx {
  background: var(--chalk-hover);
  color: var(--chalk-muted-text);
}
.call-file-type svg {
  width: 18px;
  height: 18px;
}
.call-message-reactions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-width: 240px;
}
.is-local .call-message-reactions {
  justify-content: flex-end;
}
.call-reaction {
  height: 26px;
  padding: 0 8px 0 6px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--chalk-raised);
  border: 1px solid var(--chalk-line);
  font-size: 12px;
  transition: transform 0.12s ease-out;
}
.call-reaction .call-reaction-emoji {
  font-size: 14px;
  line-height: 1;
}
.call-reaction b {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--chalk-soft-text);
}
.call-reaction:hover {
  background: var(--chalk-hover);
}
.call-reaction.is-local {
  background: color-mix(in srgb, var(--chalk-accent) 20%, var(--chalk-surface));
  border-color: color-mix(in srgb, var(--chalk-accent) 65%, transparent);
}
.call-reaction.is-local b {
  color: var(--chalk-text);
}
.call-reaction:active {
  transform: scale(0.94);
}
.call-reaction-bar {
  position: absolute;
  bottom: calc(100% - 8px);
  left: 0;
  z-index: 3;
  display: flex;
  padding: 3px;
  border-radius: 999px;
  background: var(--chalk-popover);
  border: 1px solid var(--chalk-line-strong);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
  opacity: 0;
  visibility: hidden;
  transform: translateY(3px);
  transition:
    opacity 0.12s ease-out,
    transform 0.12s ease-out,
    visibility 0s 0.12s;
}
.is-local .call-reaction-bar {
  left: auto;
  right: 0;
}
.call-message:hover .call-reaction-bar,
.call-message:focus-visible .call-reaction-bar,
.call-message:has(:focus-visible) .call-reaction-bar,
.call-message.on .call-reaction-bar {
  opacity: 1;
  visibility: visible;
  transform: none;
  transition:
    opacity 0.12s ease-out 0.06s,
    transform 0.12s ease-out 0.06s;
}
.call-reaction-option {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 17px;
  transition: transform 0.12s ease-out;
}
.call-reaction-option:hover {
  background: var(--chalk-hover);
}
.call-reaction-option:hover {
  transform: scale(1.12);
}
.call-reaction-option:active {
  transform: scale(0.92);
}
.call-reaction-option.more {
  color: var(--chalk-muted-text);
}
.call-reaction-option.more svg {
  width: 18px;
  height: 18px;
}
.call-message.on .call-message-bubble {
  background: var(--chalk-hover);
}
.call-card-tabs {
  flex: none;
}
.call-card-tab {
  font-size: 14px;
}
.call-card-close {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  font-size: 24px;
  color: var(--chalk-muted-text);
}
.call-card-close:hover {
  background: var(--chalk-hover);
}
.call-people {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
  font-size: 14px;
  scrollbar-width: thin;
  scrollbar-color: var(--chalk-hover) transparent;
}
.call-people-search input {
  min-width: 0;
  background: transparent;
  outline: none;
}
.call-edit-name {
  display: none;
}
.call-person-row:hover .call-edit-name,
.call-person-row:focus-within .call-edit-name {
  display: block;
}
.call-hand {
  color: var(--chalk-warning);
  font-size: 12px;
}
.call-raised-row {
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 52px;
  padding: 0 4px 0 8px;
  border-radius: 12px;
}
.call-hand-number {
  display: grid;
  place-items: center;
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #dcb740;
  color: #16140c;
  font-size: 12px;
  font-weight: 700;
}
.call-chat-messages {
  min-height: 0;
}
.call-message-group {
  font-size: 14px;
}
.call-message-group.is-continuation {
  margin-top: 3px;
}
.call-message-avatar {
  width: 28px;
  flex: none;
}
.call-message-bubble {
  white-space: pre-wrap;
}
.call-message-bubble a {
  text-decoration: underline;
}
.call-attachments {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.call-attachments:is(.image-2,.image-3,.image-4) {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
}
.call-attachments .call-file { grid-column: 1/-1; }
.call-attachments.image-1 .call-photo { border-radius: 14px; }
.call-attachments.image-3 .call-photo:nth-child(3) { grid-column: span 2; aspect-ratio: 2; }
.call-photo-more { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.5); color: #fff; font-size: 20px; font-weight: 600; }
.call-file > span:not(.call-file-type) {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.call-file b {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.call-file small {
  font-size: 12px;
  color: var(--chalk-muted-text);
  line-height: 1.25;
}
.call-file-type { background: #5c5d65; }
.call-file-type[data-extension="pdf"] { background: #c42b2b; }
.call-file-type:is([data-extension="doc"],[data-extension="docx"]) { background: #2f5fb3; }
.call-file-type:is([data-extension="xls"],[data-extension="xlsx"]) { background: #1e7a46; }
.call-file-type:is([data-extension="ppt"],[data-extension="pptx"]) { background: #b8481e; }
.call-reaction > span {
  font-size: 14px;
  line-height: 1;
}
.call-reaction[aria-pressed="true"] {
  background: color-mix(in srgb, var(--chalk-accent) 20%, var(--chalk-surface));
  border-color: color-mix(in srgb, var(--chalk-accent) 65%, transparent);
}
.call-message:focus-within .call-reaction-bar {
  opacity: 1;
  visibility: visible;
  transform: none;
}
.call-reaction-bar button {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 17px;
  transition: transform 0.12s ease-out;
}
.call-reaction-bar button:hover {
  background: var(--chalk-hover);
  transform: scale(1.12);
}
.call-emoji-picker {
  display: grid;
  grid-template-columns: repeat(6, 40px);
  gap: 2px;
}
.call-emoji-picker button {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  font-size: 20px;
}
.call-emoji-picker button:hover {
  background: var(--chalk-hover);
}
.call-composer {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  padding: 8px;
  border-top: 1px solid var(--chalk-line);
}
.call-message-input {
  flex: 1;
  min-width: 0;
  min-height: 40px;
  max-height: 120px;
  padding: 10px 12px;
  resize: none;
  border-radius: 20px;
  background: var(--chalk-raised);
  font-size: 14px;
  line-height: 20px;
  outline: none;
}
.call-message-input::placeholder {
  color: var(--chalk-muted-text);
}
.call-message-input:focus-visible {
  box-shadow: 0 0 0 2px var(--chalk-text);
}
.call-composer .call-send-button,
.call-composer .call-attach-button {
  width: 40px;
  height: 40px;
  min-width: 40px;
  border-radius: 50%;
  padding: 0;
  flex: none;
}
.call-composer .call-send-button {
  background: var(--chalk-text);
  color: var(--chalk-canvas);
}
.call-composer .call-send-button:hover {
  background: var(--chalk-soft-text);
}
.call-staged-file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 14px;
  background: var(--chalk-raised);
  width: 100%;
  min-width: 0;
}
.call-staged-file img {
  height: 40px;
  width: 40px;
  border-radius: 8px;
  object-fit: cover;
}
.call-staged-file > span {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
}
.call-staged-file b {
  font-size: 13px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.call-staged-file small {
  font-size: 12px;
  color: var(--chalk-muted-text);
}
.call-staged-file button {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  flex: none;
}
.call-photo-viewer {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100dvh;
  max-width: none;
  max-height: none;
  padding: 0;
  border: 0;
  margin: 0;
  background: rgba(8, 8, 10, .94);
  color: #ececee;
}
.call-photo-viewer::backdrop { background: #08080a; }
.call-photo-viewer[open] { display: flex; flex-direction: column; }
.call-photo-viewer :focus-visible { outline-color: #ececee; }
.call-photo-viewer-bar { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 12px 12px 20px; }
.call-photo-viewer-name { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.call-photo-viewer-name b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.call-photo-viewer-name small { font-size: 12px; color: #a1a2a9; }
.call-photo-viewer-control { width: 40px; height: 40px; border-radius: 50%; flex: none; display: grid; place-items: center; color: #ececee; background: rgba(255,255,255,.08); }
.call-photo-viewer-control svg { width: 20px; height: 20px; }
.call-photo-viewer-control:hover { background: rgba(255,255,255,.16); }
.call-photo-viewer-stage { position: relative; flex: 1; min-height: 0; }
.call-photo-viewer-stage img { position: absolute; inset: 0 76px 36px; margin: auto; max-width: calc(100% - 152px); max-height: calc(100% - 36px); border-radius: 8px; user-select: none; }
.call-photo-previous, .call-photo-next { position: absolute; top: 50%; width: 44px; height: 44px; margin-top: -40px; }
.call-photo-previous { left: 16px; }
.call-photo-next { right: 16px; }
@media (max-width: 767px) {
 .call-photo-viewer-bar { padding: 52px 8px 8px 16px; }
 .call-photo-viewer-control { width: 44px; height: 44px; }
 .call-photo-viewer-stage img { inset: 0 0 108px; max-width: 100%; max-height: calc(100% - 108px); border-radius: 0; }
 .call-photo-previous, .call-photo-next { top: auto; bottom: 40px; margin: 0; }
 .call-photo-previous { left: calc(50% - 60px); }
 .call-photo-next { right: calc(50% - 60px); }
}
@media (pointer: coarse) {
  .call-card-close,
  .call-host-button,
  .call-person-row button,
  .call-reaction,
  .call-reaction-bar button,
  .call-emoji-picker button,
  .call-composer .call-send-button,
  .call-composer .call-attach-button {
    min-width: 44px;
    min-height: 44px;
  }
  .call-message:not(.on):not(:focus-visible):not(:has(:focus-visible)) .call-reaction-bar {
    opacity: 0;
    visibility: hidden;
    transform: translateY(3px);
  }
  .call-emoji-picker {
    grid-template-columns: repeat(6, 44px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .call-host-button,
  .call-reaction,
  .call-reaction-bar,
  .call-reaction-bar button,
  .call-photo img {
    transition: none;
    transform: none !important;
  }
}

[data-chalk] .call-card-tabs button:focus-visible,
[data-chalk] .call-people button:focus-visible,
[data-chalk] .call-message button:focus-visible {
  outline: 2px solid var(--chalk-focus);
  outline-offset: 2px;
}

.call-composer{display:block;padding:8px 12px 12px;border-top:0}
.call-composer-field{display:flex;align-items:center;min-height:44px;padding:0 4px;border-radius:999px;background:var(--chalk-raised);border:1px solid var(--chalk-line)}
.call-composer-field:focus-within{border-color:var(--chalk-text)}
.call-composer .call-attach-button{width:36px;height:36px;min-width:36px;background:transparent;color:var(--chalk-muted-text)}
.call-composer .call-send-button{width:36px;height:36px;min-width:36px;transition:transform .15s ease-out}
.call-composer .call-send-button:active{transform:scale(.94)}
.call-composer .call-send-button:disabled{background:var(--chalk-hover);color:var(--chalk-muted-text);cursor:default;transform:none}
.call-message-input{min-height:40px;padding:10px 4px;border-radius:0;background:transparent;box-shadow:none!important}
@media(max-width:640px){.call-composer{padding-bottom:42px}}
@media(pointer:coarse){.call-composer .call-send-button,.call-composer .call-attach-button{min-width:44px;min-height:44px}}
`;

export function CallCardStyles() {
  return <style>{styles}</style>;
}
