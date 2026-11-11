/** Four signal bars. Level 4 is a strong link, 2 is weak and 1 is very poor; the words next to them carry the meaning too. */
export function ConnectionBars({ level }: { readonly level: 1 | 2 | 3 | 4 }) {
  return (
    <span className="chalk-connection-bars" data-level={level} aria-hidden="true">
      <style href="chalk-connection-bars" precedence="default">
        {BARS_CSS}
      </style>
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

const BARS_CSS = `.chalk-connection-bars {display:inline-flex;align-items:flex-end;gap:var(--space-0-5);height:14px;flex:none;}
.chalk-connection-bars i {width:3px;border-radius:var(--corner-xs);background:var(--chalk-line-strong);}
.chalk-connection-bars i:nth-child(1) {height:5px;}
.chalk-connection-bars i:nth-child(2) {height:8px;}
.chalk-connection-bars i:nth-child(3) {height:11px;}
.chalk-connection-bars i:nth-child(4) {height:14px;}
.chalk-connection-bars[data-level="4"] > i {background:var(--chalk-positive);}
.chalk-connection-bars[data-level="3"] > i:nth-child(-n+3),.chalk-connection-bars[data-level="2"] > i:nth-child(-n+2) {background:var(--chalk-warning);}
.chalk-connection-bars[data-level="1"] > i:nth-child(1) {background:var(--chalk-danger-text);}
`;
