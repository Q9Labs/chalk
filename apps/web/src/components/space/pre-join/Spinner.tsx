/** The call's ring spinner, drawn in the current text colour so it reads on both the solid and the outline pill. */
export function Spinner({ size }: { readonly size: number }) {
  return <span aria-hidden="true" style={{ width: size, height: size }} className="inline-block flex-none animate-spin rounded-full border-2 border-current/25 border-t-current motion-reduce:animate-none" />;
}
