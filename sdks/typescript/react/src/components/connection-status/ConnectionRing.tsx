/** A calm arc that turns while the call finds its way back. It stands still under reduced motion. */
export function ConnectionRing() {
  return (
    <span className="chalk-connection-ring" aria-hidden="true">
      <style href="chalk-connection-ring" precedence="default">
        {RING_CSS}
      </style>
      <svg viewBox="0 0 28 28">
        <circle className="chalk-connection-ring-track" cx="14" cy="14" r="11" />
        <circle className="chalk-connection-ring-arc" cx="14" cy="14" r="11" />
      </svg>
    </span>
  );
}

const RING_CSS = `.chalk-connection-ring {display:block;width:28px;height:28px;flex:none;}
.chalk-connection-ring svg {display:block;width:100%;height:100%;}
.chalk-connection-ring circle {fill:none;stroke-width:3;}
.chalk-connection-ring-track {stroke:var(--chalk-line-strong);}
.chalk-connection-ring-arc {stroke:var(--chalk-muted-text);stroke-linecap:round;stroke-dasharray:30 100;}
@media (prefers-reduced-motion: no-preference) {
  .chalk-connection-ring svg {animation:chalk-connection-spin 1.1s linear infinite;}
}
@keyframes chalk-connection-spin {to {transform:rotate(360deg);}}
`;
