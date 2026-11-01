import { lazy, Suspense } from "react";

const Code = lazy(() => import("./InviteQrCode"));

export function canEncodeInviteQr(value: string): boolean {
  return new TextEncoder().encode(value).length <= 858;
}

export function InviteQR({ value }: { readonly value: string }) {
  return (
    <Suspense
      fallback={
        <span role="status" className="inline-flex size-28 shrink-0 items-center justify-center text-center text-[13px] text-[var(--chalk-muted-text)]">
          Loading QR code…
        </span>
      }
    >
      <Code value={value} />
    </Suspense>
  );
}
