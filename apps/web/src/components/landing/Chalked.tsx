export function Chalked({ children }: { children: React.ReactNode }) {
  return (
    <span className="chalked">
      {children}
      <svg viewBox="0 0 200 12" preserveAspectRatio="none" aria-hidden="true">
        <path d="M4 8 C 52 3, 122 3, 196 6" />
        <path d="M8 11 C 62 7, 132 6, 192 9" />
      </svg>
    </span>
  );
}
