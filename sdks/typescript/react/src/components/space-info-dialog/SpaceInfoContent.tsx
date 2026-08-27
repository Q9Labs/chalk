import { useEffect, useRef, useState } from "react";
import type React from "react";
import { QRCodeSVG } from "qrcode.react";

import { cn } from "../../utils/cn";
import type { Copy01IconHandle } from "../../utils/animated-icons";
import { Copy01Icon } from "../../utils/icons";
import type { SpaceInfoDialogProps } from "./SpaceInfoDialog";

type CopyTarget = "invite" | "diagnostic" | null;

type SpaceInfoContentProps = Pick<SpaceInfoDialogProps, "spaceDescription" | "spaceId" | "inviteLink" | "onCopyLink" | "diagnosticReference" | "onCopyDiagnosticReference" | "onSendFeedback" | "stats" | "duration">;

const LABEL_CLASS = "text-[13px] leading-5 text-[var(--chalk-app-text-muted)]";
const VALUE_CLASS = "min-w-0 text-sm leading-5 text-[var(--chalk-app-text)]";
const FIELD_CLASS = "flex h-9 min-w-0 flex-1 items-center rounded-[8px] border border-[var(--chalk-app-line)] bg-[var(--chalk-app-input)] px-3 font-mono text-[12.5px] text-[var(--chalk-app-text)]";
const ACCENT_BUTTON_CLASS =
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[8px] border border-transparent bg-[var(--chalk-app-control-active)] px-3.5 text-sm font-semibold text-[var(--chalk-app-control-active-text)] transition-colors hover:border-[var(--chalk-app-control-active-line)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)]";
const GHOST_BUTTON_CLASS =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[7px] px-2.5 text-[13px] font-semibold text-[var(--chalk-app-text-muted)] transition-colors hover:bg-[var(--chalk-app-control-hover)] hover:text-[var(--chalk-app-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)]";

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function connectionSummary(stats: NonNullable<SpaceInfoDialogProps["stats"]>): string | null {
  const parts = [stats.resolution, stats.latency === undefined ? undefined : `${stats.latency} ms`, stats.packetLoss === undefined ? undefined : `${stats.packetLoss}% loss`].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" · ") : null;
}

interface RowProps {
  readonly label: string;
  readonly align?: "start" | "center";
  readonly children: React.ReactNode;
}

function Row({ label, align = "start", children }: RowProps): React.JSX.Element {
  return (
    <>
      <dt className={cn(LABEL_CLASS, align === "center" && "sm:self-center")}>{label}</dt>
      <dd className={VALUE_CLASS}>{children}</dd>
    </>
  );
}

/**
 * Facts about the current Space as one flat label/value list: the invite link first (the one
 * action), then the live state, then the support reference. No nested panels or section copy.
 */
export function SpaceInfoContent({ spaceDescription, spaceId, inviteLink, onCopyLink, diagnosticReference, onCopyDiagnosticReference, onSendFeedback, stats, duration }: SpaceInfoContentProps): React.JSX.Element {
  const [copied, setCopied] = useState<CopyTarget>(null);
  const confirmationTimer = useRef<number | null>(null);
  const inviteCopyRef = useRef<Copy01IconHandle>(null);
  const diagnosticCopyRef = useRef<Copy01IconHandle>(null);

  useEffect(
    () => () => {
      if (confirmationTimer.current !== null) window.clearTimeout(confirmationTimer.current);
    },
    [],
  );

  const confirmCopy = (target: Exclude<CopyTarget, null>, copy: () => void, iconRef: React.RefObject<Copy01IconHandle | null>) => {
    copy();
    iconRef.current?.startAnimation();
    setCopied(target);
    if (confirmationTimer.current !== null) window.clearTimeout(confirmationTimer.current);
    confirmationTimer.current = window.setTimeout(() => setCopied(null), 2_000);
  };

  const connection = stats ? connectionSummary(stats) : null;
  const showInvite = inviteLink !== undefined && onCopyLink !== undefined;

  return (
    <div className="px-6 pb-6 pt-5">
      {spaceDescription ? <p className="mb-5 text-sm leading-6 text-[var(--chalk-app-text)]">{spaceDescription}</p> : null}

      <dl className="grid grid-cols-1 gap-y-4 sm:grid-cols-[128px_minmax(0,1fr)] sm:gap-x-5 sm:gap-y-3.5">
        {showInvite ? (
          <Row label="Invite link" align="center">
            <div className="flex items-center gap-2">
              <p className={FIELD_CLASS} title={inviteLink}>
                <span className="truncate">{inviteLink}</span>
              </p>
              <button
                type="button"
                onClick={() => confirmCopy("invite", onCopyLink, inviteCopyRef)}
                onMouseEnter={() => inviteCopyRef.current?.startAnimation()}
                onFocus={() => inviteCopyRef.current?.startAnimation()}
                className={ACCENT_BUTTON_CLASS}
                aria-label={copied === "invite" ? "Space link copied" : "Copy space link"}
              >
                <Copy01Icon ref={inviteCopyRef} size={16} aria-hidden="true" onMouseEnter={() => inviteCopyRef.current?.startAnimation()} />
                {copied === "invite" ? "Copied" : "Copy link"}
              </button>
            </div>
            <span className="sr-only" aria-live="polite">
              {copied === "invite" ? "Space link copied to clipboard" : ""}
            </span>
          </Row>
        ) : null}

        {showInvite ? (
          <Row label="Scan to join">
            <span className="inline-block rounded-[8px] border border-[var(--chalk-app-line)] bg-[var(--chalk-app-panel)] p-1.5">
              <QRCodeSVG value={inviteLink} size={96} bgColor="var(--chalk-app-panel)" fgColor="var(--chalk-app-text)" level="M" marginSize={0} title={`QR code for ${inviteLink}`} />
            </span>
          </Row>
        ) : null}

        {duration !== undefined ? (
          <Row label="Duration">
            <span className="font-mono tabular-nums">{formatDuration(duration)}</span>
          </Row>
        ) : null}

        {spaceId ? (
          <Row label="Space ID">
            <span className="break-all font-mono text-[13px]">{spaceId}</span>
          </Row>
        ) : null}

        {connection !== null || stats?.region ? (
          <Row label="Connection">
            {connection ? <span className="font-mono text-[13px] tabular-nums">{connection}</span> : null}
            {stats?.region ? <span className={cn("text-[13px] text-[var(--chalk-app-text-muted)]", connection && "ml-2")}>{stats.region}</span> : null}
          </Row>
        ) : null}

        <Row label="Security">Media is encrypted in transit</Row>

        {diagnosticReference ? (
          <Row label="Diagnostic ref" align="center">
            <div className="flex items-center gap-1.5">
              <code className="truncate font-mono text-[13px]" title={diagnosticReference}>
                {diagnosticReference}
              </code>
              <button
                type="button"
                onClick={() => confirmCopy("diagnostic", () => (onCopyDiagnosticReference ? onCopyDiagnosticReference(diagnosticReference) : void navigator.clipboard?.writeText(diagnosticReference)), diagnosticCopyRef)}
                onMouseEnter={() => diagnosticCopyRef.current?.startAnimation()}
                onFocus={() => diagnosticCopyRef.current?.startAnimation()}
                className={cn(GHOST_BUTTON_CLASS, "h-7 px-2")}
                aria-label={copied === "diagnostic" ? "Diagnostic reference copied" : "Copy diagnostic reference"}
              >
                <Copy01Icon ref={diagnosticCopyRef} size={14} aria-hidden="true" onMouseEnter={() => diagnosticCopyRef.current?.startAnimation()} />
                {copied === "diagnostic" ? "Copied" : "Copy"}
              </button>
            </div>
            <span className="sr-only" aria-live="polite">
              {copied === "diagnostic" ? "Diagnostic reference copied to clipboard" : ""}
            </span>
          </Row>
        ) : null}
      </dl>

      {onSendFeedback && diagnosticReference ? (
        <div className="mt-5 flex items-center justify-between gap-3 border-t border-[var(--chalk-app-line)] pt-4">
          <span className="text-[13px] text-[var(--chalk-app-text-muted)]">Having trouble in this Space?</span>
          <button type="button" onClick={() => onSendFeedback({ diagnosticReference })} className={GHOST_BUTTON_CLASS}>
            Send feedback
          </button>
        </div>
      ) : null}
    </div>
  );
}
