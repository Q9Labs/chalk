export function MenuCheck({ on }: { readonly on: boolean }) {
  return (
    <span data-part="menu-check" className="chalk-menu-check" aria-hidden="true">
      {on ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : null}
    </span>
  );
}
