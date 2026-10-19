const DUST = [
  [10.5, 41.5, 1.7, 0.55],
  [6.5, 37, 1.2, 0.4],
  [4, 43.5, 0.85, 0.28],
] as const;

/** The B2 chalk stick and the wordmark. Its size follows the font size of `.lockup`. */
export function Lockup() {
  return (
    <span className="lockup">
      <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
        <g transform="rotate(28 24 24)" fill="currentColor">
          <path d="M18 8h12v28a6 6 0 0 1-12 0z" />
          <path d="M18 8h12l-1.5 4.5h-9z" opacity=".45" />
        </g>
        {DUST.map(([cx, cy, r, opacity]) => (
          <circle key={cx} cx={cx} cy={cy} r={r} fill="currentColor" opacity={opacity} />
        ))}
      </svg>
      <b>chalk</b>
    </span>
  );
}
