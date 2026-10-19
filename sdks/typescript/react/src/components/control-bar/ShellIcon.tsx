const GLYPHS = {
  flip: (
    <>
      <path d="M3 8h3l2-3h8l2 3h3v12H3z" />
      <path d="M8 14a4 4 0 0 1 7-2l1 1M16 10v3h-3M16 15a4 4 0 0 1-7 2l-1-1M8 19v-3h3" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
    </>
  ),
  micOff: (
    <>
      <path d="M2 2l20 20M15 9.3V5a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 5.1 2.1M17 17a7 7 0 0 1-12-6v-1M19 10v1a7 7 0 0 1-.1 1.2M12 18v4" />
    </>
  ),
  cam: (
    <>
      <path d="M16 10.5l5-3v9l-5-3z" />
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </>
  ),
  camOff: (
    <>
      <path d="M2 2l20 20M10.7 6H14a2 2 0 0 1 2 2v3.3l1 1 4-2.8v8M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" />
    </>
  ),
  hang: (
    <>
      <path transform="rotate(135 12 12)" d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />
    </>
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
  max: (
    <>
      <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
    </>
  ),
  min: (
    <>
      <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
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

export function ShellIcon({ name, size = 20, className }: { readonly name: keyof typeof GLYPHS; readonly size?: number; readonly className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {GLYPHS[name]}
    </svg>
  );
}
