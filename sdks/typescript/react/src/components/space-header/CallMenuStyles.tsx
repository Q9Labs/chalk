/** Rules only the call menu body uses, so they ship with it instead of with the header. */
export function CallMenuStyles() {
  return (
    <style href="chalk-call-menu" precedence="default">
      {CALL_MENU_CSS}
    </style>
  );
}

const CALL_MENU_CSS = `.chalk-shell-sep {height:1px;background:var(--chalk-line-strong);margin:var(--space-1) var(--space-3);}
.chalk-details-recording .chalk-shell-detail-lead i {width:8px;height:8px;border-radius:50%;background:var(--chalk-danger);}
.chalk-details-recording .chalk-shell-detail-label {display:flex;align-items:baseline;gap:var(--space-2);font-weight:600;}
.chalk-details-recording time {color:var(--chalk-muted-text);font-size:var(--type-body-sm);font-weight:500;font-variant-numeric:tabular-nums;}
.chalk-details-recording .chalk-details-recording-stop {height:32px;flex:none;padding-inline:var(--space-3);}
.chalk-shell-detail-value {display:inline-flex;align-items:center;gap:var(--space-1);color:var(--chalk-muted-text);font-size:var(--type-body-sm);}
.chalk-shell-detail-value[data-tone="good"] {color:var(--chalk-positive);}
.chalk-shell-detail-value[data-tone="warn"] {color:var(--chalk-warning);}
.chalk-shell-detail-value[data-tone="bad"] {color:var(--chalk-danger-text);}
.chalk-invite-link-slug {min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--chalk-muted-text);font-size:var(--type-body-sm);}
.chalk-invite-link[data-variant="menu"] .chalk-invite-link-label {flex:none;}
.chalk-invite-link[data-variant="menu"] .chalk-invite-link-slug {flex:1;text-align:end;}
.chalk-invite-link[data-variant="menu"] .chalk-invite-link-end {font-size:var(--type-body-sm);}
.chalk-invite-link[data-variant="menu"][data-copied="true"] .chalk-invite-link-label {flex:1;}
.chalk-shell-qr-card {margin:var(--space-1) 0;padding:var(--space-2) var(--space-4);display:grid;place-items:center;}
.chalk-shell-qr-card[hidden] {display:none;}
.chalk-shell-detail-action[data-ringed] {outline:1px solid var(--chalk-line-strong);outline-offset:-1px;}
.chalk-shell-detail-label small {display:block;padding-bottom:var(--space-1-5);margin-top:calc(var(--space-0-5) * -1);font-size:var(--type-caption);color:var(--chalk-muted-text);}
.chalk-shell-detail-action:has(.chalk-shell-detail-label small) {padding-top:var(--space-1-5);}
.chalk-shell-charts {display:grid;gap:var(--space-4);padding:var(--space-2) var(--space-3);}
.chalk-shell-chart-top {display:flex;justify-content:space-between;align-items:baseline;margin-bottom:var(--space-1-5);font-size:var(--type-caption);color:var(--chalk-muted-text);}
.chalk-shell-chart-top b {color:var(--chalk-text);font-size:var(--type-body-sm);font-weight:600;font-variant-numeric:tabular-nums;}
.chalk-shell-chart-top small {margin-inline-start:var(--space-0-5);color:var(--chalk-muted-text);font-size:var(--type-caption);font-weight:500;}
.chalk-shell-chart svg {display:block;width:100%;height:36px;overflow:visible;}
.chalk-shell-chart-legend {display:inline-flex;gap:var(--space-2);}
.chalk-shell-chart-legend i {display:inline-block;width:8px;height:2px;margin-inline-end:var(--space-1);border-radius:var(--corner-xs);vertical-align:middle;}
.chalk-shell-chart-axis {display:flex;justify-content:space-between;margin-top:calc(var(--space-1) * -1);font-size:var(--type-micro);color:var(--chalk-muted-text);}
.chalk-shell-diagnostics {
  display: grid;
  grid-template-columns: 84px 1fr;
  gap: var(--space-1-5) var(--space-3);
  margin: 0;
  padding: var(--space-3) var(--space-3) var(--space-2);
  font-size: var(--type-caption);
  font-variant-numeric: tabular-nums;
}
.chalk-shell-diagnostics dt {color:var(--chalk-muted-text);}
.chalk-shell-diagnostics dd {margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:text;}
.chalk-shell-diagnostics dd[data-mono] {font-family:var(--chalk-mono);}
`;
