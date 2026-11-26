export const CHAT_FILE_DROP_STYLES = `.chalk-frame-overlays > .call-file-drop-dimmer {
  position: absolute;
  inset: 0;
  z-index: 35;
  pointer-events: none;
  background: color-mix(in srgb, var(--chalk-scrim) 72%, transparent);
}
.call-file-drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  padding: var(--space-2-5);
  border-radius: inherit;
  background: color-mix(in srgb, var(--chalk-surface) 97%, transparent);
  pointer-events: none;
}
.call-file-drop-zone {
  display: flex;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1-5);
  /* token-ratchet-ignore: the approved drop zone uses a 1.5px dashed rule and the design system has no border-width token */
  border: 1.5px dashed var(--chalk-accent);
  border-radius: var(--corner-xl);
  background: color-mix(in srgb, var(--chalk-accent) 7%, transparent);
  text-align: center;
}
.call-file-drop-icon {
  display: grid;
  width: var(--space-12);
  height: var(--space-12);
  margin-bottom: var(--space-2);
  place-items: center;
  border: 1px solid var(--chalk-line-strong);
  border-radius: 50%;
  background: var(--chalk-raised);
  color: var(--chalk-accent);
}
.call-file-drop-zone h3 {
  font-size: var(--type-body-lg);
  font-weight: 600;
}
.call-file-drop-zone p {
  font-size: var(--type-body-sm);
  color: var(--chalk-muted-text);
}
`;
