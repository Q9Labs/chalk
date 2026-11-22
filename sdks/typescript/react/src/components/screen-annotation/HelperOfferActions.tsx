import type { ScreenAnnotationHelper, ScreenAnnotationHelperStatus } from "./model";

export type HelperScreen =
  | { readonly kind: "idle" | "looking" }
  | { readonly kind: "attaching"; readonly fingerprint?: string }
  | { readonly kind: "confirm"; readonly fingerprint: string; readonly submit: (code: string) => void }
  | { readonly kind: "code"; readonly error?: string }
  | { readonly kind: "fingerprint"; readonly value: string; readonly approve: () => Promise<void> }
  | { readonly kind: "device"; readonly name: string; readonly fingerprint?: string; readonly approve: () => Promise<void> }
  | { readonly kind: "status"; readonly status: ScreenAnnotationHelperStatus };

export function HelperOfferActions({ screen, helper, dismiss, useCode }: { readonly screen: HelperScreen; readonly helper: ScreenAnnotationHelper; readonly dismiss: () => void; readonly useCode: () => void }) {
  return (
    <div className="chalk-ann-card-actions">
      {helper.installUrl && (screen.kind === "idle" || screen.kind === "code" || (screen.kind === "status" && screen.status === "update_required")) ? (
        <a className="chalk-ann-textbtn" href={helper.installUrl} target="_blank" rel="noopener noreferrer">
          Get Chalk Helper
        </a>
      ) : null}
      {helper.lookupCode && screen.kind !== "idle" && screen.kind !== "code" && screen.kind !== "device" && (screen.kind !== "status" || screen.status !== "ready") ? (
        <button type="button" className="chalk-ann-textbtn" onClick={useCode}>
          Use a device code
        </button>
      ) : null}
      <button type="button" className="chalk-ann-textbtn" onClick={dismiss}>
        {screen.kind === "status" && (screen.status === "ready" || screen.status === "device_approved") ? "Disconnect" : "Not now"}
      </button>
    </div>
  );
}
