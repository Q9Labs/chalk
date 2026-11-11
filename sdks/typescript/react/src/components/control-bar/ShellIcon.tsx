import { useId } from "react";

const GLYPHS = {
  flip: (
    <>
      <path d="M3 8h3l2-3h8l2 3h3v12H3z" />
      <path d="M8 14a4 4 0 0 1 7-2l1 1M16 10v3h-3M16 15a4 4 0 0 1-7 2l-1-1M8 19v-3h3" />
    </>
  ),
  hang: (
    <path
      fill="currentColor"
      stroke="none"
      transform="translate(12 12.4) scale(1.12) translate(-12 -12.4)"
      d="M12 9c3.6 0 6.9 1.3 9.1 3.4.6.6.6 1.5.1 2.1l-1.3 1.5c-.5.6-1.4.7-2 .3l-2-1.3c-.5-.3-.7-.8-.7-1.4v-1.5a12 12 0 0 0-6.4 0v1.5c0 .6-.2 1.1-.7 1.4l-2 1.3c-.6.4-1.5.3-2-.3l-1.3-1.5c-.5-.6-.5-1.5.1-2.1C5.1 10.3 8.4 9 12 9z"
    />
  ),
  down: (
    <>
      <path d="M6 9l6 6 6-6" />
    </>
  ),
  up2: (
    <>
      <path d="M18 15l-6-6-6 6" />
    </>
  ),
  right: (
    <>
      <path d="M9 18l6-6-6-6" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </>
  ),
  spot: (
    <>
      <rect x="3" y="3" width="18" height="12.5" rx="2" />
      <path d="M4 20.5h3M10.5 20.5h3M17 20.5h3" />
    </>
  ),
  smile: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5s1.3 1.8 3.5 1.8 3.5-1.8 3.5-1.8M9 9.5h.01M15 9.5h.01" />
    </>
  ),
  hand: (
    <>
      <path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15" />
    </>
  ),
  pen: (
    <>
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
      <path d="M15 5l4 4" />
    </>
  ),
  rec: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" />
    </>
  ),
  chat: (
    <>
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />
    </>
  ),
  share: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4M9 10l3-3 3 3M12 7v6" />
    </>
  ),
  shareOff: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4M9.5 7.5l5 5M14.5 7.5l-5 5" />
    </>
  ),
};

type PathLength = { readonly pathLength?: 1 };
const MEDIA_BODY = {
  mic: (p: PathLength) => (
    <>
      <rect x="9" y="2" width="6" height="12" rx="3" {...p} />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" {...p} />
    </>
  ),
  cam: (p: PathLength) => (
    <>
      <path d="M16 10.5l5-3v9l-5-3z" {...p} />
      <rect x="2" y="6" width="14" height="12" rx="2" {...p} />
    </>
  ),
};

/**
 * The microphone or camera glyph. A slash draws across it while the device is off, and while the
 * device starts a light runs along its outline (`busy`), so the button needs no separate loader.
 * Motion lives in ShellStyles, keyed on the data attributes.
 */
export function MediaGlyph({ kind, slashed, busy }: { readonly kind: keyof typeof MEDIA_BODY; readonly slashed: boolean; readonly busy: boolean }) {
  const cut = useId();
  const body = MEDIA_BODY[kind];
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="chalk-shell-media" data-slashed={slashed} data-busy={busy} aria-hidden="true">
      <mask id={cut} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        {/* token-ratchet-ignore: mask luminance (white keeps, black cuts), not a theme colour */}
        <rect width="24" height="24" fill="white" stroke="none" />
        {/* token-ratchet-ignore: mask luminance (white keeps, black cuts), not a theme colour */}
        <path className="chalk-shell-media-cut" d="M3 3l18 18" pathLength={1} stroke="black" strokeWidth="5" />
      </mask>
      <g className="chalk-shell-media-body" mask={`url(#${cut})`}>
        {body({})}
      </g>
      <g className="chalk-shell-media-trace" mask={`url(#${cut})`}>
        {body({ pathLength: 1 })}
      </g>
      <path className="chalk-shell-media-slash" d="M3 3l18 18" pathLength={1} />
    </svg>
  );
}

export function ShellIcon({ name, size = 20, className }: { readonly name: keyof typeof GLYPHS; readonly size?: number; readonly className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {GLYPHS[name]}
    </svg>
  );
}
