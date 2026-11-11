import { lazy, Suspense } from "react";

const Code = lazy(() => import("./InviteQrCode"));

export function canEncodeInviteQr(value: string): boolean {
  return new TextEncoder().encode(value).length <= 858;
}

export function InviteQR({ value }: { readonly value: string }) {
  return (
    <Suspense
      fallback={
        <span role="status" className="chalk-invite-qr">
          Loading QR code…
        </span>
      }
    >
      <Code value={value} />
    </Suspense>
  );
}
