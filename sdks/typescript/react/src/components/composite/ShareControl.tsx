import type { ReactNode } from "react";

export function ShareControl({ label, pressed, onClick, children }: { readonly label: string; readonly pressed?: boolean; readonly onClick: () => void; readonly children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className="relative grid h-8 w-8 place-items-center rounded-[50%] bg-[var(--chalk-overlay)] text-[var(--chalk-on-overlay)] outline-none hover:bg-[var(--chalk-overlay-hover)] aria-pressed:bg-[var(--chalk-on-overlay)] aria-pressed:text-[var(--chalk-overlay)] motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-[ease-out] active:scale-[.92] focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)] [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-1.5"
    >
      {children}
    </button>
  );
}
