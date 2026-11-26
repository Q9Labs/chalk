export const callFileStyles = `.call-file-wrap { position: relative; display: block; }
.call-file-wrap .call-file { width: 100%; }
.call-file-actions { position: absolute; right: var(--space-1-5); top: var(--space-1-5); display: none; gap: var(--space-1); }
.call-file-wrap:hover .call-file-actions, .call-file-wrap:focus-within .call-file-actions { display: flex; }
.call-file-actions button { border-radius: var(--corner-pill); background: var(--chalk-overlay-strong); color: var(--chalk-on-overlay); padding: var(--space-1-5) var(--space-2-5); font-size: var(--type-caption); font-weight: 600; box-shadow: var(--chalk-shadow); }
.call-file-actions button:hover { background: var(--chalk-on-overlay); color: var(--chalk-overlay); }

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
`;
