import { Dialog } from "@base-ui/react/dialog";
import { useRef, useState } from "react";
import { ChalkButton, ChalkCopyButton, ChalkIconButton, ChalkSegmentedControl, ChalkToggle } from "../chalk-ui";
import { shareQr } from "./share-qr";
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

export function CallDialog({ kind, onClose, onReportProblem, diagnostics }: { readonly kind: "shortcuts" | "report" | null; readonly onClose: () => void; readonly onReportProblem?: SpaceHeaderProps["onReportProblem"]; readonly diagnostics: string }) {
  const container = useRef<HTMLElement>(null);
  const [text, setText] = useState("");
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");
  return (
    <span
      ref={(element) => {
        container.current = element?.closest<HTMLElement>("[data-chalk]") ?? element;
      }}
      style={{ display: "contents" }}
    >
      <Dialog.Root
        open={kind !== null}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <Dialog.Portal container={container}>
          <Dialog.Backdrop className="chalk-shell-modal-backdrop" />
          <Dialog.Popup className="chalk-shell-modal">
            <div className="chalk-shell-modal-heading">
              <Dialog.Title>{kind === "shortcuts" ? "Keyboard shortcuts" : "Report a problem"}</Dialog.Title>
              <Dialog.Close
                render={
                  <ChalkIconButton aria-label="Close" size="sm">
                    ×
                  </ChalkIconButton>
                }
              />
            </div>
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
              <p role="status">Your report was sent. Thank you.</p>
            ) : (
              <form
                className="chalk-shell-report"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!text.trim() || !onReportProblem || status === "sending") return;
                  setStatus("sending");
                  setError("");
                  void Promise.resolve()
                    .then(() => onReportProblem({ description: text.trim(), diagnostics: includeDiagnostics ? diagnostics : undefined }))
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
                <textarea id="chalk-problem" required value={text} onChange={(event) => setText(event.target.value)} placeholder="Tell us what happened…" />
                <label>
                  <input type="checkbox" checked={includeDiagnostics} onChange={(event) => setIncludeDiagnostics(event.target.checked)} /> Include call diagnostics
                </label>
                {error ? <p role="alert">{error}</p> : null}
                <ChalkButton type="submit" disabled={!text.trim() || status === "sending"}>
                  {status === "sending" ? "Sending…" : "Send report"}
                </ChalkButton>
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
  diagnostics = [],
  colorScheme = "dark",
  onColorSchemeChange,
  sounds,
  onSoundsChange,
  onDialog,
  onReportProblem,
}: Pick<SpaceHeaderProps, "shareUrl" | "diagnostics" | "colorScheme" | "onColorSchemeChange" | "onReportProblem"> & { readonly sounds: boolean; readonly onSoundsChange: (enabled: boolean) => void; readonly onDialog: (kind: "shortcuts" | "report") => void }) {
  const link = shareUrl ?? (typeof location === "undefined" ? "" : location.href);
  const qr = shareQr(link);
  return (
    <div className="chalk-details">
      <section className="chalk-shell-section">
        <h3 className="chalk-shell-label">Share</h3>
        <div className="chalk-shell-link">
          <span dir="ltr">{link}</span>
          <ChalkCopyButton text={link} label="Copy link" />
        </div>
        {qr ? (
          <div className="chalk-shell-qr-row">
            <svg data-part="share-qr" className="chalk-shell-qr" viewBox={`0 0 ${qr.length + 8} ${qr.length + 8}`} role="img" aria-label="Scan to join this call" shapeRendering="crispEdges">
              <rect width="100%" height="100%" fill="white" />
              <path d={qr.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x + 4},${y + 4}h1v1h-1z`] : []))).join("")} />
            </svg>
            <p>
              Scan to join
              <br />
              on another device
            </p>
          </div>
        ) : null}
      </section>
      {diagnostics.length ? (
        <section className="chalk-shell-section">
          <h3 className="chalk-shell-label">Diagnostics</h3>
          <dl className="chalk-shell-diagnostics">
            {diagnostics.map(({ label, value }) => (
              <div key={label} style={{ display: "contents" }}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <ChalkCopyButton text={diagnostics.map(({ label, value }) => `${label}: ${value}`).join("\n")} label="Copy diagnostics" />
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
        <div className="chalk-details-row">
          <span>Sounds</span>
          <ChalkToggle aria-label="Sounds" pressed={sounds} onPressedChange={onSoundsChange} />
        </div>
        <button type="button" className="chalk-shell-detail-action" aria-haspopup="dialog" onClick={() => onDialog("shortcuts")}>
          Keyboard shortcuts<span aria-hidden="true">›</span>
        </button>
        {onReportProblem ? (
          <button type="button" className="chalk-shell-detail-action" aria-haspopup="dialog" onClick={() => onDialog("report")}>
            Report a problem<span aria-hidden="true">›</span>
          </button>
        ) : null}
      </section>
    </div>
  );
}
