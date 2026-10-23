import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useRef, useState, type RefObject } from "react";
import { ChalkButton, ChalkCopyButton, ChalkIconButton, ChalkSegmentedControl } from "../chalk-ui";
import { shareQr } from "./share-qr";
import { ShellIcon } from "../control-bar/ShellIcon";
import type { SpaceHeaderProps } from "./space-header-contract";

export const CALL_SHORTCUTS = [
  ["Mute or unmute", "⌘ D"],
  ["Turn camera on or off", "⌘ E"],
  ["Raise or lower hand", "⌃ ⌘ H"],
  ["Open or close chat", "⌃ ⌘ C"],
  ["Open or close people", "⌃ ⌘ P"],
  ["Switch layout", "⌃ ⌘ L"],
  ["Talk while muted", "Hold Space"],
  ["Show shortcuts", "?"],
  ["Close a menu or panel", "Esc"],
] as const;

export function CallDialog({
  kind,
  open,
  onClose,
  onReportProblem,
  diagnostics,
  returnFocus,
  unavailableReason,
}: {
  readonly kind: "shortcuts" | "report";
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onReportProblem?: SpaceHeaderProps["onReportProblem"];
  readonly diagnostics: string;
  readonly returnFocus: RefObject<HTMLButtonElement | null>;
  readonly unavailableReason?: string;
}) {
  const container = useRef<HTMLElement>(null);
  const reportInput = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");
  useEffect(() => {
    if (open && kind === "report") {
      setText("");
      setIncludeDiagnostics(false);
      setError("");
      setStatus("idle");
    }
  }, [kind, open]);
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
          <Dialog.Popup initialFocus={kind === "report" ? reportInput : undefined} finalFocus={returnFocus} className="chalk-shell-modal">
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
                <label htmlFor="chalk-problem">What went wrong?</label>
                <textarea ref={reportInput} id="chalk-problem" rows={4} required disabled={status === "sending"} value={text} onChange={(event) => setText(Array.from(event.target.value).slice(0, 1000).join(""))} placeholder="Tell us what happened…" />
                {diagnostics.trim() ? (
                  <label className="chalk-shell-report-check">
                    <input type="checkbox" disabled={status === "sending"} checked={includeDiagnostics} onChange={(event) => setIncludeDiagnostics(event.target.checked)} /> Include diagnostics
                  </label>
                ) : null}
                {error ? <p role="alert">{error}</p> : null}
                {unavailableReason ? <p role="alert">{unavailableReason}</p> : null}
                <div className="chalk-shell-report-actions">
                  <ChalkButton onClick={onClose} disabled={status === "sending"}>
                    Cancel
                  </ChalkButton>
                  <ChalkButton type="submit" variant="solid" disabled={!text.trim() || status === "sending" || Boolean(unavailableReason)}>
                    {status === "sending" ? "Sending…" : "Send"}
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

export function CallDetails({
  shareUrl,
  spaceName,
  onClose,
  diagnostics = [],
  colorScheme = "dark",
  onColorSchemeChange,
  sounds,
  onSoundsChange,
  onDialog,
  onReportProblem,
}: Pick<SpaceHeaderProps, "spaceName" | "shareUrl" | "diagnostics" | "colorScheme" | "onColorSchemeChange" | "onReportProblem"> & {
  readonly onClose: () => void;
  readonly sounds: boolean;
  readonly onSoundsChange: (enabled: boolean) => void;
  readonly onDialog: (kind: "shortcuts" | "report") => void;
}) {
  const link = shareUrl ?? (typeof location === "undefined" ? "" : location.href);
  const qr = shareQr(link);
  const [details, setDetails] = useState(false);
  return (
    <div className="chalk-details">
      <div className="chalk-shell-details-heading">
        <h2>{spaceName}</h2>
        <ChalkIconButton aria-label="Close" size="sm" onClick={onClose}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </ChalkIconButton>
      </div>
      <section className="chalk-shell-section">
        <h3 className="chalk-shell-label">Share</h3>
        <div className="chalk-shell-link">
          <span dir="ltr">{link.replace(/^https?:\/\//, "")}</span>
          <ChalkCopyButton text={link} label="Copy link" />
        </div>
        {qr ? (
          <div className="chalk-shell-qr-row">
            <svg data-part="share-qr" className="chalk-shell-qr" viewBox={`0 0 ${qr.length + 8} ${qr.length + 8}`} role="img" aria-label="Scan to join this call" shapeRendering="crispEdges">
              <rect width="100%" height="100%" fill="white" />
              <path d={qr.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x + 4},${y + 4}h1v1h-1z`] : []))).join("")} />
            </svg>
            <p>Scan with a phone camera to join this call.</p>
          </div>
        ) : null}
      </section>
      {diagnostics.length ? (
        <section className="chalk-shell-section">
          <button type="button" className="chalk-shell-detail-action chalk-shell-connection" aria-expanded={details} onClick={() => setDetails(!details)}>
            <span className="chalk-shell-connection-bars" aria-hidden="true">
              {[6, 9, 12, 15].map((height) => (
                <i key={height} style={{ height }} />
              ))}
            </span>
            <span>Connection: {diagnostics[0]?.value.toLowerCase()}</span>
            <span className="chalk-shell-connection-details">{details ? "Hide details" : "Details"}</span>
            <ShellIcon name={details ? "up2" : "down"} size={18} />
          </button>
          {details ? (
            <>
              <dl className="chalk-shell-diagnostics">
                {diagnostics.map(({ label, value }) => (
                  <div key={label} style={{ display: "contents" }}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="chalk-shell-diagnostics-copy">
                <ChalkCopyButton text={diagnostics.map(({ label, value }) => `${label}: ${value}`).join("\n")} label="Copy diagnostics" announcement="Diagnostics copied" showLabel />
              </div>
            </>
          ) : null}
        </section>
      ) : null}
      <section className="chalk-shell-section">
        <div className="chalk-details-row">
          <span>Appearance</span>
          <ChalkSegmentedControl
            size="compact"
            label="Appearance"
            value={colorScheme}
            options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
            ]}
            onValueChange={(next) => onColorSchemeChange?.(next)}
          />
        </div>
        <button type="button" role="switch" aria-label="Sounds" aria-checked={sounds} className="chalk-shell-detail-action" onClick={() => onSoundsChange(!sounds)}>
          <span>Sounds</span>
          <span className="chalk-switch" aria-checked={sounds} aria-hidden="true">
            <span />
          </span>
        </button>
        <button type="button" className="chalk-shell-detail-action" aria-haspopup="dialog" onClick={() => onDialog("shortcuts")}>
          Keyboard shortcuts
          <ShellIcon name="right" size={18} />
        </button>
        {onReportProblem ? (
          <button type="button" className="chalk-shell-detail-action" aria-haspopup="dialog" onClick={() => onDialog("report")}>
            Report a problem
            <ShellIcon name="right" size={18} />
          </button>
        ) : null}
      </section>
    </div>
  );
}
