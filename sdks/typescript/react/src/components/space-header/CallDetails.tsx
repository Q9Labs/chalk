import { lazy, Suspense, useState } from "react";
import { ChalkButton, ChalkCopyButton, ChalkIconButton, ChalkSegmentedControl, ChalkTooltip } from "../chalk-ui";
import { CopyMorphIcon } from "../chalk-ui/ChalkCopyButton";
import { useCopyText } from "../chalk-ui/useCopyText";
import { MenuIcon } from "../chalk-ui/MenuIcon";
import { InviteQR, canEncodeInviteQr } from "../chalk-ui/InviteQR";
import { ShellIcon } from "../control-bar/ShellIcon";
import { ConnectionBars } from "../connection-notice/ConnectionBars";
import { connectionQuality } from "./call-network";
import { CallMenuStyles } from "./CallMenuStyles";
import { RowIcon } from "./RowIcon";
import { formatDuration, type SpaceHeaderProps } from "./space-header-contract";

// The charts load when the connection section first opens, so a call that never looks at them never downloads them.
const CallChartsView = lazy(() => import("./CallCharts").then((module) => ({ default: module.CallChartsView })));

export function CallDetails({
  shareUrl,
  onClose,
  diagnostics = [],
  network,
  isRecording = false,
  recordingSeconds = null,
  onStopRecording,
  colorScheme = "dark",
  onColorSchemeChange,
  sounds,
  onSoundsChange,
  onReport,
  onReportProblem,
  revealConnection = false,
  revealQr = false,
}: Pick<SpaceHeaderProps, "shareUrl" | "diagnostics" | "network" | "isRecording" | "recordingSeconds" | "onStopRecording" | "colorScheme" | "onColorSchemeChange" | "onReportProblem"> & {
  readonly onClose: () => void;
  readonly sounds: boolean;
  readonly onSoundsChange: (enabled: boolean) => void;
  readonly onReport: () => void;
  /** Opened from the connection chip: the Connection row starts expanded and marked so the person sees where the chip led. */
  readonly revealConnection?: boolean;
  /** Opened at call start for a host who is alone: the QR code starts expanded so the invite is one glance away. */
  readonly revealQr?: boolean;
}) {
  const link = shareUrl ?? (typeof location === "undefined" ? "" : location.href);
  const qr = canEncodeInviteQr(link);
  const [qrOpen, setQrOpen] = useState(revealQr);
  const [details, setDetails] = useState(revealConnection);
  const quality = network ? connectionQuality(network) : null;
  const facts = diagnostics.filter(({ label }) => label !== "Connection");
  return (
    <div className="chalk-details">
      <CallMenuStyles />
      {/* The trigger already names the call, so the menu only gets a heading at call start, where it explains the moment. */}
      {revealQr ? (
        <div className="chalk-shell-details-heading">
          <div>
            <h2>Your call is ready</h2>
            <p className="chalk-shell-details-sub">Share the link, or let people scan the code.</p>
          </div>
          <ChalkIconButton aria-label="Close" size="sm" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
              <path d="m6 6 12 12M6 18 18 6" />
            </svg>
          </ChalkIconButton>
        </div>
      ) : null}
      {isRecording ? (
        <>
          <div className="chalk-details-row chalk-details-recording">
            <span className="chalk-shell-detail-lead">
              <i aria-hidden="true" />
            </span>
            <span className="chalk-shell-detail-label">
              Recording
              {recordingSeconds === null ? null : <time dateTime={`PT${recordingSeconds}S`}>{formatDuration(recordingSeconds)}</time>}
            </span>
            {onStopRecording ? (
              <ChalkButton className="chalk-details-recording-stop" aria-label="Stop recording" onClick={onStopRecording}>
                Stop
              </ChalkButton>
            ) : null}
          </div>
          <div className="chalk-shell-sep" />
        </>
      ) : null}
      <InviteRow link={link} />
      {qr ? (
        <>
          <button type="button" className="chalk-shell-detail-action" aria-expanded={qrOpen} aria-controls="chalk-details-qr" onClick={() => setQrOpen(!qrOpen)}>
            <span className="chalk-shell-detail-lead">
              <RowIcon name="qr" />
            </span>
            <span className="chalk-shell-detail-label">QR code</span>
            <span className="chalk-shell-detail-trail">
              <ShellIcon name={qrOpen ? "up2" : "down"} size={16} />
            </span>
          </button>
          <div id="chalk-details-qr" hidden={!qrOpen} className="chalk-shell-qr-card">
            {qrOpen ? <InviteQR value={link} /> : null}
          </div>
        </>
      ) : null}
      {network && quality ? (
        <>
          <div className="chalk-shell-sep" />
          <button type="button" className="chalk-shell-detail-action" data-ringed={revealConnection || undefined} aria-expanded={details} aria-controls="chalk-details-connection" onClick={() => setDetails(!details)}>
            <span className="chalk-shell-detail-lead">
              <ConnectionBars level={quality.level} />
            </span>
            <span className="chalk-shell-detail-label">
              Connection
              {quality.helper ? <small>{quality.helper}</small> : null}
            </span>
            <span className="chalk-shell-detail-value" data-tone={quality.tone}>
              {quality.word}
              <ShellIcon name={details ? "up2" : "down"} size={16} />
            </span>
          </button>
          <div id="chalk-details-connection" hidden={!details}>
            {details && network.samples && network.samples.length > 1 ? (
              <Suspense fallback={null}>
                <CallChartsView samples={network.samples} />
              </Suspense>
            ) : null}
            {facts.length ? (
              <dl className="chalk-shell-diagnostics">
                {facts.map(({ label, value }) => (
                  <div key={label} style={{ display: "contents" }}>
                    <dt>{label}</dt>
                    <dd dir="ltr" data-mono={label === "Session" ? "" : undefined}>
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <ChalkTooltip trigger={<ChalkCopyButton className="chalk-shell-diagnostics-copy" text={diagnostics.map(({ label, value }) => `${label}: ${value}`).join("\n")} label="Copy diagnostics" announcement="Diagnostics copied" />}>Copy diagnostics</ChalkTooltip>
          </div>
        </>
      ) : null}
      <div className="chalk-shell-sep" />
      <div className="chalk-details-row">
        <span className="chalk-shell-detail-lead">
          <RowIcon name="sun" />
        </span>
        <span className="chalk-shell-detail-label">Appearance</span>
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
        <span className="chalk-shell-detail-lead">
          <RowIcon name="bell" />
        </span>
        <span className="chalk-shell-detail-label">Sounds</span>
        <span className="chalk-switch" aria-checked={sounds} aria-hidden="true">
          <span />
        </span>
      </button>
      {onReportProblem ? (
        <>
          <div className="chalk-shell-sep" />
          <button type="button" className="chalk-shell-detail-action" aria-haspopup="dialog" onClick={onReport}>
            <span className="chalk-shell-detail-lead">
              <RowIcon name="flag" />
            </span>
            <span className="chalk-shell-detail-label">Report a problem</span>
            <span className="chalk-shell-detail-trail">
              <ShellIcon name="right" size={16} />
            </span>
          </button>
        </>
      ) : null}
    </div>
  );
}

function displayLink(link: string): string {
  try {
    const { host, pathname } = new URL(link);
    return `${host}${pathname === "/" ? "" : pathname}`;
  } catch {
    return link;
  }
}

/** The invite row is the link itself: pressing anywhere on it copies, and the copy glyph at its end morphs to a check and back. */
function InviteRow({ link }: { readonly link: string }) {
  const { copied, error, copy } = useCopyText(link);
  return (
    <>
      <button type="button" data-part="copy-invite-link" data-copied={copied} className="chalk-shell-detail-action chalk-details-invite" aria-label="Copy invite link" onClick={() => void copy()}>
        <span className="chalk-shell-detail-lead">
          <MenuIcon name="link" />
        </span>
        <span dir="ltr" className="chalk-shell-detail-label chalk-details-invite-url">
          {displayLink(link)}
        </span>
        <CopyMorphIcon copied={copied} />
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {error ? "Could not copy. Try again." : copied ? "Link copied" : ""}
      </span>
    </>
  );
}
