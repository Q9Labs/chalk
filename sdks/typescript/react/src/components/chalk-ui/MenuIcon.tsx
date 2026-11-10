import type { ReactNode } from "react";

const GLYPHS = {
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.8 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="13" height="13" rx="2.5" />
      <path d="M16 8V5.5A2.5 2.5 0 0 0 13.5 3h-8A2.5 2.5 0 0 0 3 5.5v8A2.5 2.5 0 0 0 5.5 16H8" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
};

/** One call-menu glyph on the same 24 grid and 1.75 stroke as ShellIcon. */
export function GlyphSvg({ size = 18, children }: { readonly size?: number; readonly children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/** The glyphs the invite link button shows, in the menu and on the invite card. */
export function MenuIcon({ name, size }: { readonly name: keyof typeof GLYPHS; readonly size?: number }) {
  return <GlyphSvg size={size}>{GLYPHS[name]}</GlyphSvg>;
}
