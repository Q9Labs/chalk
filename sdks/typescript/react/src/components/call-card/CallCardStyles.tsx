const styles = `.call-card-tabs {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2) 0 var(--space-2-5);
  border-bottom: 1px solid var(--chalk-line);
}
.call-card-tab {
  height: 46px;
  padding: 0 var(--space-2-5);
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
  border-radius: var(--corner-xs);
  background: var(--chalk-text);
}
.call-card-tab .call-card-count {
  color: var(--chalk-muted-text);
  font-weight: 500;
  margin-left: var(--space-1-5);
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
  padding: var(--space-2);
  scrollbar-width: thin;
  scrollbar-color: var(--chalk-hover) transparent;
}
.call-people-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 40px;
  margin: var(--space-0-5) var(--space-0-5) var(--space-2);
  padding: 0 var(--space-3);
  border-radius: var(--corner-pill);
  background: var(--chalk-hover);
  /* token-ratchet-ignore: ring drawn with box-shadow, the design system has no ring token */
  box-shadow: inset 0 0 0 1px transparent;
  color: var(--chalk-muted-text);
}
[data-theme="light"] .call-people-search,
[data-chalk-theme="light"] .call-people-search {
  background: var(--chalk-canvas);
  /* token-ratchet-ignore: ring drawn with box-shadow, the design system has no ring token */
  box-shadow: inset 0 0 0 1px var(--chalk-line);
}
.call-people-search:focus-within,
[data-theme="light"] .call-people-search:focus-within,
[data-chalk-theme="light"] .call-people-search:focus-within {
  /* token-ratchet-ignore: ring drawn with box-shadow, the design system has no ring token */
  box-shadow: 0 0 0 2px var(--chalk-accent);
}
.call-people-search svg {
  width: 18px;
  height: 18px;
  flex: none;
}
.call-people-search input {
  flex: 1;
  color: var(--chalk-text);
}
.call-people-search-clear {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  flex: none;
  background: var(--chalk-pressed);
}
.call-people-search-clear svg {
  width: 14px;
  height: 14px;
}
.call-people-count {
  padding: var(--space-1) var(--space-3);
  font-size: var(--type-caption);
  color: var(--chalk-muted-text);
}
.call-people-search input::placeholder,
.comp input::placeholder,
.lcard input::placeholder {
  color: var(--chalk-muted-text);
}
/* Rare bulk actions sit as small pills in one row above the list, not as the panel's biggest control. */
.call-host-controls {
  flex: none;
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}
.call-host-controls .chalk-pill-button {
  height: 36px;
}
.call-mute-confirm {
  width: 280px;
  padding: var(--space-2) var(--space-2) var(--space-1);
}
.call-mute-confirm b {
  font-size: var(--type-body-lg);
  font-weight: 600;
}
.call-mute-confirm p {
  font-size: var(--type-body-sm);
  color: var(--chalk-soft-text);
  margin: var(--space-1) 0 var(--space-2-5);
}
.call-mute-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin: var(--space-1) var(--space-1-5) 0;
}
.call-mute-actions .chalk-pill-button {
  height: 32px;
  padding: 0 var(--space-3);
}
.call-people-section {
  display: flex;
  align-items: baseline;
  gap: var(--space-1-5);
  padding: var(--space-3) var(--space-3) var(--space-1);
  font-size: var(--type-caption);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--chalk-muted-text);
}
.call-people-section span {
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}
.call-person-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 48px;
  padding: 0 var(--space-1) 0 var(--space-3);
  border-radius: var(--corner-xl);
}
.call-person-row:hover,
.call-person-row[data-open] {
  background: var(--chalk-hover);
}
.call-person-row[data-reconnecting] .call-person-avatar,
.call-person-row[data-reconnecting] .call-person-who {
  opacity: 0.5;
}
.call-person-avatar {
  flex: none;
  display: grid;
  border-radius: 50%;
}
.call-person-avatar[data-speaking] {
  /* token-ratchet-ignore: ring drawn with box-shadow, the design system has no ring token */
  box-shadow: 0 0 0 2px var(--chalk-surface), 0 0 0 4px var(--chalk-accent-speaking);
}
.call-person-who {
  display: grid;
  min-width: 0;
  flex: 1;
}
.call-person-name-line {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
}
.call-person-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: start;
  font-size: var(--type-body);
  font-weight: 500;
  color: var(--chalk-text);
}
.call-person-name mark {
  background: color-mix(in srgb, var(--chalk-accent) 30%, transparent);
  color: inherit;
  border-radius: var(--corner-sm);
}
.call-person-name-input {
  width: 100%;
  min-width: 0;
  height: 28px;
  padding: 0 var(--space-1-5);
  border-radius: var(--corner-sm);
  border: 1px solid var(--chalk-line-strong);
  background: var(--chalk-raised);
  color: var(--chalk-text);
  font-size: var(--type-body);
  outline: none;
}
.call-person-name-input:focus {
  border-color: var(--chalk-text);
}
.call-person-you {
  flex: none;
  color: var(--chalk-muted-text);
  font-size: var(--type-body);
}
.call-person-host {
  display: grid;
  flex: none;
  place-items: center;
  color: var(--chalk-muted-text);
}
.call-person-host svg {
  width: 14px;
  height: 14px;
}
.call-person-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--type-caption);
  line-height: 1.3;
  color: var(--chalk-muted-text);
}
.call-person-state-slots {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}
.call-person-state {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  color: var(--chalk-muted-text);
}
.call-person-state svg {
  width: 18px;
  height: 18px;
}
.call-person-state[data-off] {
  color: var(--chalk-danger-text);
}
.call-eq {
  display: inline-flex;
  align-items: center;
  gap: var(--space-0-5);
  height: 14px;
}
.call-eq i {
  width: 3px;
  border-radius: var(--corner-xs);
  background: var(--chalk-positive);
}
.call-eq i:nth-child(1) {
  height: 6px;
}
.call-eq i:nth-child(2) {
  height: 13px;
}
.call-eq i:nth-child(3) {
  height: 9px;
}
.call-person-options,
.call-person-options-slot {
  width: 32px;
  height: 32px;
  flex: none;
}
.call-person-options {
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--chalk-muted-text);
}
.call-person-options:hover,
.call-person-options[aria-expanded="true"] {
  background: var(--chalk-pressed);
  color: var(--chalk-text);
}
.call-no-people {
  padding: var(--space-4) var(--space-2);
  color: var(--chalk-muted-text);
  font-size: var(--type-body-sm);
}
.call-message-group {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
  margin: var(--space-3) var(--space-1) 0;
}
.call-message-group.is-local {
  flex-direction: row-reverse;
}
.call-message-column {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
  min-width: 0;
}
.call-message-column > :not(.call-message),
.call-message > * {
  max-width: 240px;
}
.is-local .call-message-column {
  align-items: flex-end;
}
.call-message-heading {
  font-size: var(--type-caption);
  color: var(--chalk-muted-text);
  margin: 0 var(--space-1) 1px;
  font-variant-numeric: tabular-nums;
}
.call-message-heading b {
  color: var(--chalk-text);
  font-weight: 600;
  margin-right: var(--space-1-5);
}
.call-message-bubble {
  background: var(--chalk-raised);
  border-radius: var(--corner-2xl);
  padding: var(--space-2) var(--space-3);
  line-height: 1.4;
  overflow-wrap: anywhere;
  user-select: text;
}
.call-message-status {
  font-size: var(--type-caption);
  color: var(--chalk-muted-text);
  margin: 0 var(--space-1-5);
}
/* The message spans the row, so its reaction bar opens at the far edge, away from the sender name and time. */
.call-message {
  position: relative;
  display: flex;
  flex-direction: column;
  align-self: stretch;
  align-items: flex-start;
  gap: var(--space-1);
  max-width: 100%;
  border-radius: var(--corner-xl);
}
.is-local .call-message {
  align-items: flex-end;
}
.call-message-body {
  display: flex;
  flex-direction: column;
  align-items: inherit;
  gap: var(--space-1);
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
  gap: var(--space-1);
  color: var(--chalk-danger-text);
  font-size: var(--type-caption);
}
.call-message-status.err svg {
  width: 14px;
  height: 14px;
}
.call-attachments {
  display: grid;
  gap: var(--space-0-5);
  width: 240px;
  max-width: 100%;
  border-radius: var(--corner-xl);
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
  border-radius: var(--corner-xs);
}
.call-attachments.one .call-photo {
  border-radius: var(--corner-xl);
}
.call-photo::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: var(--elevation-hairline-inset);
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
  gap: var(--space-2-5);
  width: 240px;
  max-width: 100%;
  min-height: 56px;
  padding: var(--space-2) var(--space-1-5) var(--space-2) var(--space-2-5);
  border-radius: var(--corner-xl);
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
  font-size: var(--type-body-sm);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.call-file-name small {
  font-size: var(--type-caption);
  color: var(--chalk-muted-text);
  line-height: 1.25;
}
.call-file-name small.er {
  color: var(--chalk-danger-text);
}
.call-file-type {
  width: 36px;
  height: 36px;
  border-radius: var(--corner-lg);
  flex: none;
  display: grid;
  place-items: center;
  font-size: var(--type-micro);
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.04em;
  color: var(--chalk-on-overlay);
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
  gap: var(--space-1);
  max-width: 240px;
}
.is-local .call-message-reactions {
  justify-content: flex-end;
}
.call-reaction {
  height: 26px;
  padding: 0 var(--space-2) 0 var(--space-1-5);
  border-radius: var(--corner-pill);
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  background: var(--chalk-raised);
  border: 1px solid var(--chalk-line);
  font-size: var(--type-caption);
  transition: transform 0.12s ease-out;
}
.call-reaction .call-reaction-emoji {
  font-size: var(--type-body);
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
  inset-inline-end: 0;
  z-index: 3;
  display: flex;
  padding: var(--space-1);
  border-radius: var(--corner-pill);
  background: var(--chalk-popover);
  border: 1px solid var(--chalk-line-strong);
  box-shadow: var(--chalk-shadow);
  opacity: 0;
  visibility: hidden;
  transform: translateY(3px);
  transition:
    opacity 0.12s ease-out,
    transform 0.12s ease-out,
    visibility 0s 0.12s;
}
.is-local .call-reaction-bar {
  inset-inline-start: 0;
  inset-inline-end: auto;
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
  font-size: var(--type-lead);
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
  font-size: var(--type-body);
}
.call-card-close {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  font-size: var(--type-title);
  color: var(--chalk-muted-text);
}
.call-card-close:hover {
  background: var(--chalk-hover);
}
.call-people {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  font-size: var(--type-body);
}
.call-people-list {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--space-2);
  scrollbar-width: thin;
  scrollbar-color: var(--chalk-hover) transparent;
}
.call-people-list > * {
  flex-shrink: 0;
}
.call-people-search input {
  min-width: 0;
  background: transparent;
  outline: none;
}
.call-hand {
  display: inline-flex;
  align-items: center;
  gap: var(--space-0-5);
  height: 22px;
  padding: 0 var(--space-2) 0 var(--space-1-5);
  margin-inline-end: var(--space-1);
  border-radius: var(--corner-pill);
  background: color-mix(in srgb, var(--chalk-warning) 16%, transparent);
  color: var(--chalk-warning);
  font-size: var(--type-caption);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.call-hand[data-solo] {
  padding: 0 var(--space-1-5);
}
.call-hand svg {
  width: 14px;
  height: 14px;
}
.call-wait {
  margin: var(--space-1) 0 var(--space-2);
  padding: var(--space-1-5);
  border-radius: var(--corner-2xl);
  background: var(--chalk-raised);
}
[data-theme="light"] .call-wait,
[data-chalk-theme="light"] .call-wait {
  /* token-ratchet-ignore: ring drawn with box-shadow, the design system has no ring token */
  box-shadow: inset 0 0 0 1px var(--chalk-line);
}
.call-wait-label {
  padding-top: var(--space-2);
}
.call-wait-label i {
  align-self: center;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--chalk-accent);
}
.call-wait-row {
  min-height: 56px;
  padding-inline-end: var(--space-1-5);
}
.call-wait-row:hover {
  background: transparent;
}
.call-wait-actions {
  display: flex;
  gap: var(--space-1-5);
  flex: none;
}
.call-wait-actions .chalk-pill-button,
.call-wait-bulk .chalk-pill-button {
  height: 32px;
  padding: 0 var(--space-3);
}
.call-wait-bulk {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-1-5);
}
.call-wait-bulk .chalk-pill-button {
  flex: 1;
  height: 36px;
}
.call-wait-error {
  padding: var(--space-1) var(--space-3);
  font-size: var(--type-body-sm);
  color: var(--chalk-danger-text);
}
.call-chat-messages {
  min-height: 0;
}
.call-message-group {
  font-size: var(--type-body);
}
.call-message-group.is-continuation {
  margin-top: var(--space-1);
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
  gap: var(--space-1);
}
.call-attachments:is(.image-2,.image-3,.image-4) {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-0-5);
}
.call-attachments .call-file { grid-column: 1/-1; }
.call-attachments.image-1 .call-photo { border-radius: var(--corner-xl); aspect-ratio: auto; }
.call-attachments.image-1 .call-photo img { height: auto; min-height: 150px; max-height: 320px; }
.call-attachments.image-3 .call-photo:nth-child(3) { grid-column: span 2; aspect-ratio: 2; }
.call-photo-more { position: absolute; inset: 0; display: grid; place-items: center; background: var(--chalk-scrim); color: var(--chalk-on-overlay); font-size: var(--type-title-sm); font-weight: 600; }
.call-file > span:not(.call-file-type) {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.call-file b {
  font-size: var(--type-body-sm);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.call-file small {
  font-size: var(--type-caption);
  color: var(--chalk-muted-text);
  line-height: 1.25;
}
.call-file-type { background: var(--chalk-file-other); }
.call-file-type[data-extension="pdf"] { background: var(--chalk-file-pdf); }
.call-file-type:is([data-extension="doc"],[data-extension="docx"]) { background: var(--chalk-file-doc); }
.call-file-type:is([data-extension="xls"],[data-extension="xlsx"]) { background: var(--chalk-file-xls); }
.call-file-type:is([data-extension="ppt"],[data-extension="pptx"]) { background: var(--chalk-file-ppt); }
.call-reaction > span {
  font-size: var(--type-body);
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
  font-size: var(--type-lead);
  transition: transform 0.12s ease-out;
}
.call-reaction-bar button:hover {
  background: var(--chalk-hover);
  transform: scale(1.12);
}
.call-emoji-picker {
  display: grid;
  grid-template-columns: repeat(6, 40px);
  gap: var(--space-0-5);
}
.call-emoji-picker button {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  font-size: var(--type-title-sm);
}
.call-emoji-picker button:hover {
  background: var(--chalk-hover);
}
.call-composer {
  display: flex;
  align-items: flex-end;
  gap: var(--space-1-5);
  padding: var(--space-2);
  border-top: 1px solid var(--chalk-line);
}
.call-message-input {
  flex: 1;
  min-width: 0;
  min-height: 40px;
  max-height: 120px;
  padding: var(--space-2-5) var(--space-3);
  resize: none;
  border-radius: var(--corner-2xl);
  background: var(--chalk-raised);
  font-size: var(--type-body);
  line-height: 20px;
  outline: none;
}
/* An enlarged placeholder ends in an ellipsis instead of wrapping into a line the field cannot show. */
.call-message-input::placeholder {
  overflow: hidden;
  color: var(--chalk-muted-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.call-message-input:focus-visible {
  box-shadow: var(--elevation-focus-ring);
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
  gap: var(--space-2-5);
  min-height: 44px;
  padding: var(--space-1) var(--space-1) var(--space-1) var(--space-1-5);
  border-radius: var(--corner-xl);
  background: var(--chalk-raised);
  border: 1px solid var(--chalk-line);
  width: 100%;
  min-width: 0;
}
.call-staged-file img {
  height: 32px;
  width: 32px;
  border-radius: var(--corner-md);
  object-fit: cover;
}
.call-staged-file > span {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
}
.call-staged-file b {
  font-size: var(--type-body-sm);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.call-staged-file small {
  font-size: var(--type-caption);
  line-height: 1.25;
  color: var(--chalk-muted-text);
}
.call-staged-file button {
  width: 28px;
  height: 28px;
  border-radius: 50%;
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
  background: var(--chalk-photo-viewer-overlay);
  color: var(--chalk-on-overlay);
}
.call-photo-viewer::backdrop { background: transparent; }
.call-photo-viewer { opacity: 0; visibility: hidden; transition: opacity .18s ease-out, visibility 0s .18s; }
.call-photo-viewer[open] { display: flex; flex-direction: column; opacity: 1; visibility: visible; transition: opacity .18s ease-out; }
.call-photo-viewer[open][data-closing] { opacity: 0; visibility: hidden; transition: opacity .18s ease-out, visibility 0s .18s; }
@starting-style { .call-photo-viewer[open] { opacity: 0; } }
.call-photo-viewer :focus-visible { outline-color: var(--chalk-on-overlay); }
.call-photo-viewer-bar { flex: none; display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3) var(--space-3) var(--space-3) var(--space-5); }
.call-photo-viewer-name { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.call-photo-viewer-name b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.call-photo-viewer-name small { font-size: var(--type-caption); color: var(--chalk-on-overlay); }
.call-photo-viewer-control { width: 40px; height: 40px; border-radius: 50%; flex: none; display: grid; place-items: center; color: var(--chalk-on-overlay); background: color-mix(in srgb, var(--chalk-on-overlay) 8%, transparent); }
.call-photo-viewer-control svg { width: 20px; height: 20px; }
.call-photo-viewer-control:hover { background: color-mix(in srgb, var(--chalk-on-overlay) 16%, transparent); }
.call-photo-viewer-stage { position: relative; flex: 1; min-height: 0; }
.call-photo-viewer-stage img { position: absolute; inset: 0 76px 36px; margin: auto; max-width: calc(100% - 152px); max-height: calc(100% - 36px); border-radius: var(--corner-lg); user-select: none; }
.call-photo-previous, .call-photo-next { position: absolute; top: 50%; width: 44px; height: 44px; margin-top: calc(var(--space-10) * -1); }
.call-photo-previous { left: 16px; }
.call-photo-next { right: 16px; }
@media (max-width: 767px) {
 /* The phone sheet sits 32px below the screen edge, so the pinned footer clears it. */
 .call-people-list:last-child { padding-bottom: var(--space-10); }
 .call-person-row { min-height: 52px; }
 .call-people-search { height: 44px; }
 .call-wait-row { min-height: 60px; }
 .call-wait-actions .chalk-pill-button { height: 40px; }
 .call-wait-bulk .chalk-pill-button { height: 48px; }
 .call-photo-viewer-bar { padding: var(--space-12) var(--space-2) var(--space-2) var(--space-4); }
 .call-photo-viewer-control { width: 44px; height: 44px; }
 .call-photo-viewer-stage img { inset: 0 0 108px; max-width: 100%; max-height: calc(100% - 108px); border-radius: 0; }
 .call-photo-previous, .call-photo-next { top: auto; bottom: 40px; margin: 0; }
 .call-photo-previous { left: calc(50% - 60px); }
 .call-photo-next { right: calc(50% - 60px); }
}
@media (pointer: coarse) {
  .call-card-close,
  .call-person-row button,
  .call-staged-file button,
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
  .call-photo-viewer[open], .call-photo-viewer[open][data-closing] { transition: none; }
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

.call-composer{display:block;gap:normal;padding:var(--space-2) var(--space-3) var(--space-3);border-top:0}
.call-composer-field{display:flex;align-items:center;min-height:44px;padding:0 var(--space-1);border-radius:var(--corner-pill);background:var(--chalk-raised);border:1px solid var(--chalk-line)}
.call-composer-field:focus-within{border-color:var(--chalk-text)}
.call-composer .call-attach-button{width:36px;height:36px;min-width:36px;background:transparent;color:var(--chalk-muted-text)}
.call-composer .call-send-button{width:36px;height:36px;min-width:36px;border:0 solid currentColor;font-weight:400;line-height:1.4;transition:transform .15s ease-out}
.call-composer .call-send-button:active{transform:scale(.94)}
.call-composer .call-send-button:disabled{opacity:1;background:var(--chalk-hover);color:var(--chalk-muted-text);cursor:default;transform:none}
/* token-ratchet-ignore: none !important is the reset that beats the host page, not a design value */
.call-message-input{min-height:40px;padding:var(--space-2-5) var(--space-1);border-radius:0;background:transparent;box-shadow:none!important}
@media(max-width:640px){.call-composer{padding-bottom:var(--space-10)}}
@media(pointer:coarse){.call-composer .call-send-button,.call-composer .call-attach-button{min-width:44px;min-height:44px}}
`;

export function CallCardStyles() {
  return <style>{styles}</style>;
}
