const GLYPHS = {
  select: <path d="M5 3l14 7-6.5 2L10 19z" />,
  hand: <path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15" />,
  pen: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />,
  highlighter: (
    <>
      <path d="M9 11l-6 6v3h9l3-3" />
      <path d="M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
    </>
  ),
  rectangle: <rect x="3" y="5" width="18" height="14" rx="2" />,
  ellipse: <ellipse cx="12" cy="12" rx="9" ry="6.5" />,
  diamond: <path d="M12 3l9 9-9 9-9-9z" />,
  arrow: <path d="M5 19L19 5M9 5h10v10" />,
  line: <path d="M4 20L20 4" />,
  text: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,
  note: (
    <>
      <path d="M5 3h14a2 2 0 0 1 2 2v9l-7 7H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M14 21v-5a2 2 0 0 1 2-2h5" />
    </>
  ),
  eraser: <path d="M7 21h10M5.5 13.5l7-7a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8L11 19H8l-2.5-2.5a2 2 0 0 1 0-3z" />,
  laser: (
    <>
      <circle cx="12" cy="12" r="2.5" fill="currentColor" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </>
  ),
  redo: (
    <>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  plus: <path d="M12 5v14M5 12h14" />,
  fit: <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />,
  download: <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />,
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </>
  ),
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12l5 5 9-10" />,
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  wifiOff: <path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5-2.7M10.7 5.1A16 16 0 0 1 22 9M2 8.8a15 15 0 0 1 4.2-2.5M12 20h.01" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </>
  ),
  chevron: <path d="M6 9l6 6 6-6" />,
} as const;

export type BoardGlyph = keyof typeof GLYPHS;

export function BoardIcon({ name, size = 20, className }: { readonly name: BoardGlyph; readonly size?: number; readonly className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {GLYPHS[name]}
    </svg>
  );
}

/** Six dots in two columns: the island's drag handle. */
export function GripIcon({ className }: { readonly className?: string }) {
  return (
    <svg width="10" height="18" viewBox="0 0 10 18" fill="currentColor" className={className} aria-hidden="true">
      {[3, 9, 15].flatMap((y) => [<circle key={`l${y}`} cx="2.5" cy={y} r="1.5" />, <circle key={`r${y}`} cx="7.5" cy={y} r="1.5" />])}
    </svg>
  );
}

/** The remote cursor: a rounded arrow with a white outline, filled in the person's colour. */
export function CursorArrow({ color }: { readonly color: string }) {
  const path = "M3.2 2.6V20.2L8 15.7L11.3 22.6L14.6 21L11.4 14.2L17.9 13.6Z";
  return (
    <svg className="chalk-board-cursor-arrow" width="22" height="26" viewBox="0 0 22 26" fill="none" aria-hidden="true">
      <path d={path} fill="#fff" stroke="#fff" strokeWidth="5" strokeLinejoin="round" />
      <path d={path} fill={color} stroke={color} strokeWidth="2.2" strokeLinejoin="round" />
    </svg>
  );
}
