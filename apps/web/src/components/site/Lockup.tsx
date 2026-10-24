import { MARK } from "../../lib/chalk-mark";

/** The B2 chalk stick and the wordmark. Its size follows the font size of `.lockup`. */
export function Lockup() {
  return (
    <span className="lockup">
      <svg viewBox={`0 0 ${MARK.viewBox} ${MARK.viewBox}`} aria-hidden="true" focusable="false">
        <g transform={`rotate(${MARK.rotation} 24 24)`} fill="currentColor">
          <path d={MARK.stick} />
          <path d={MARK.cap} opacity={MARK.capOpacity} />
        </g>
        {MARK.dust.map(([cx, cy, r, opacity]) => (
          <circle key={cx} cx={cx} cy={cy} r={r} fill="currentColor" opacity={opacity} />
        ))}
      </svg>
      <b>chalk</b>
    </span>
  );
}
