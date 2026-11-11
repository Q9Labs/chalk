import { Dialog } from "@base-ui/react/dialog";
import { useRef, useState, type RefObject } from "react";
import { ChalkButton, ChalkIconButton, ChalkToggle } from "../chalk-ui";
import type { SpaceHeaderProps } from "./space-header-contract";

const REPORT_MAX_CHARACTERS = 1000;

export const CALL_SHORTCUTS = [
  ["Mute or unmute", "⌘ D"],
  ["Turn camera on or off", "⌘ E"],
  ["Raise or lower hand", "⌃ ⌘ H"],
  ["Open or close chat", "⌃ ⌘ C"],
  ["Open or close people", "⌃ ⌘ P"],
  ["Switch layout", "⌃ ⌘ L"],
  ["Full screen", "⌃ ⌘ F"],
  ["Talk while muted", "Hold Space"],
  ["Show shortcuts", "?"],
  ["Close a menu or panel", "Esc"],
] as const;

export function CallDialogContent({
  kind,
  open,
  onClose,
  onReportProblem,
  diagnostics,
  returnFocus,
  focusScope,
  unavailableReason,
}: {
  readonly kind: "shortcuts" | "report";
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onReportProblem?: SpaceHeaderProps["onReportProblem"];
  readonly diagnostics: string;
  readonly returnFocus?: RefObject<HTMLButtonElement | null>;
  readonly focusScope: RefObject<HTMLElement | null>;
  readonly unavailableReason?: string;
}) {
  const container = useRef<HTMLElement>(null);
  const reportInput = useRef<HTMLTextAreaElement>(null);
  const reportOpener = useRef<HTMLElement>(null);
  const [text, setText] = useState("");
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");
  const [session, setSession] = useState({ kind, open });
  if (session.kind !== kind || session.open !== open) {
    setSession({ kind, open });
    if (open && kind === "report") {
      setText("");
      setIncludeDiagnostics(false);
      setError("");
      setStatus("idle");
    }
  }
  return (
    <span
      ref={(element) => {
        container.current = element?.closest<HTMLElement>("[data-chalk]") ?? element;
      }}
      style={{ display: "contents" }}
    >
      <Dialog.Root
        open={open}
        onOpenChange={(open, event) => {
          if (!open && status === "sending") {
            event.cancel();
            return;
          }
          if (!open) onClose();
        }}
      >
        <Dialog.Portal container={container}>
          <Dialog.Backdrop className="chalk-shell-modal-backdrop" />
          <Dialog.Popup
            initialFocus={
              kind === "report"
                ? () => {
                    const opener = reportInput.current?.ownerDocument.activeElement;
                    reportOpener.current = opener instanceof HTMLElement && focusScope.current?.contains(opener) ? opener : null;
                    return reportInput.current;
                  }
                : undefined
            }
            finalFocus={kind === "report" ? () => reportFocusTarget(focusScope.current, reportOpener.current) : returnFocus}
            className="chalk-shell-modal"
          >
            {kind === "report" && status === "sent" ? null : (
              <div className="chalk-shell-modal-heading">
                <Dialog.Title>{kind === "shortcuts" ? "Keyboard shortcuts" : "Report a problem"}</Dialog.Title>
                <Dialog.Close
                  disabled={status === "sending"}
                  render={
                    <ChalkIconButton aria-label="Close" size="sm">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
                        <path d="m6 6 12 12M6 18 18 6" />
                      </svg>
                    </ChalkIconButton>
                  }
                />
              </div>
            )}
            {kind === "shortcuts" ? (
              <dl className="chalk-shell-shortcuts">
                {CALL_SHORTCUTS.map(([label, keys]) => (
                  <div key={label} style={{ display: "contents" }}>
                    <dt>{label}</dt>
                    <dd>
                      {keys.split(" ").map((key, index) => (
                        <kbd key={`${key}${index}`}>{key}</kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : status === "sent" ? (
              <div className="chalk-shell-report-sent" role="status">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m5 12 4 4L19 6" />
                </svg>
                <Dialog.Title>Sent</Dialog.Title>
                <p>Thanks. We’ll look into it.</p>
                <ChalkButton variant="solid" onClick={onClose}>
                  Done
                </ChalkButton>
              </div>
            ) : (
              <form
                className="chalk-shell-report"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!text.trim() || !onReportProblem || status === "sending" || unavailableReason) return;
                  setStatus("sending");
                  setError("");
                  void Promise.resolve()
                    .then(() => onReportProblem({ description: text.trim(), diagnostics: includeDiagnostics && diagnostics.trim() ? diagnostics : undefined }))
                    .then(
                      () => setStatus("sent"),
                      () => {
                        setStatus("idle");
                        setError("Your report could not be sent. Try again.");
                      },
                    );
                }}
              >
                <div className="chalk-shell-report-field">
                  <textarea ref={reportInput} id="chalk-problem" rows={2} required aria-label="What went wrong?" disabled={status === "sending"} value={text} onChange={(event) => setText(Array.from(event.target.value).slice(0, REPORT_MAX_CHARACTERS).join(""))} placeholder="What went wrong?" />
                  <span className="chalk-shell-report-count" aria-hidden="true">
                    {Array.from(text).length} / {REPORT_MAX_CHARACTERS}
                  </span>
                </div>
                {diagnostics.trim() ? (
                  <div className="chalk-shell-report-check">
                    <span id="chalk-report-diagnostics">
                      Include diagnostics<small>Session, connection and devices</small>
                    </span>
                    <ChalkToggle aria-labelledby="chalk-report-diagnostics" disabled={status === "sending"} pressed={includeDiagnostics} onPressedChange={setIncludeDiagnostics} />
                  </div>
                ) : null}
                {error ? <p role="alert">{error}</p> : null}
                {unavailableReason ? <p role="alert">{unavailableReason}</p> : null}
                <div className="chalk-shell-report-actions">
                  <ChalkButton onClick={onClose} disabled={status === "sending"}>
                    Cancel
                  </ChalkButton>
                  <ChalkButton type="submit" variant="solid" disabled={!text.trim() || status === "sending" || Boolean(unavailableReason)}>
                    {status === "sending" ? "Sending…" : "Send report"}
                  </ChalkButton>
                </div>
              </form>
            )}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </span>
  );
}

function reportFocusTarget(scope: HTMLElement | null, opener: HTMLElement | null): HTMLElement | false {
  if (usableReportFocusTarget(opener)) return opener;
  if (!scope?.isConnected) return false;
  for (const selector of ['button[data-part="call-name"]', '[data-part="status-actions"] button', 'main, [role="main"]']) {
    for (const target of [scope, ...scope.querySelectorAll<HTMLElement>(selector)]) {
      if (!target.matches(selector) || !usableReportFocusTarget(target)) continue;
      if (target.matches('main, [role="main"]')) target.tabIndex = -1;
      return target;
    }
  }
  return false;
}

function usableReportFocusTarget(target: HTMLElement | null): target is HTMLElement {
  if (!target?.isConnected || target.matches(':disabled, [aria-disabled="true"]') || target.closest("[inert]") || target.getClientRects().length === 0) return false;
  const visibility = getComputedStyle(target).visibility;
  if (visibility === "hidden" || visibility === "collapse") return false;
  for (let element: HTMLElement | null = target; element; element = element.parentElement) {
    if (getComputedStyle(element).opacity === "0") return false;
  }
  return true;
}
