/** The host controls above the people list and the confirmation that mute everyone opens. */
export const HOST_CONTROLS_CSS = `/* Rare bulk actions sit as small pills in one row above the list, not as the panel's biggest control. */
.call-host-controls {
  flex: none;
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}
.call-host-controls .chalk-pill-button {
  height: 36px;
}
.call-who-option {
  display: grid;
  /* token-ratchet-ignore: optical gap inside the option, between the 0 and 4px steps */
  gap: 2px;
}
.call-who-option small {
  font-size: var(--type-caption);
  color: var(--chalk-muted-text);
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
}`;
