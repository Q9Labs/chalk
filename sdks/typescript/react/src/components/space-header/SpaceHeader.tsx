import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { preloadable } from "../../internal/preloadable";
import { cn } from "../../utils/cn";
import { useMediaQuery } from "../../internal/useMediaQuery";
import { useNarrowCall } from "../../internal/call-width";
import { useSoundsSetting } from "../../internal/useSoundsSetting";
import { ChalkPopover, ChalkSheet } from "../chalk-ui";
import { Avatar } from "../atomic/Avatar";
import { LayoutMenu } from "./LayoutMenu";
import { CallDialog } from "./CallDialog";
import { useCallShortcuts } from "./useCallShortcuts";
import { formatDuration, type SpaceHeaderProps } from "./space-header-contract";
import { shownNotice, type NoticeTier } from "../connection-notice/shown-notice";
import { ShellStyles } from "../control-bar/ShellStyles";
export { formatDuration, type SpaceHeaderProps } from "./space-header-contract";

// The menu body downloads on the first hover, focus or press of the trigger, so it opens with its content on the first frame and a call that never reaches for it never downloads it.
const { Component: CallDetails, preload: preloadDetails } = preloadable(() => import("./CallDetails").then((module) => module.CallDetails));
const warmDetails = () => void preloadDetails().catch(() => undefined);
// The chip loads the first time the link turns weak, so a call on a good link never downloads it.
const ConnectionNotice = lazy(() => import("../connection-notice/ConnectionNotice").then((module) => ({ default: module.ConnectionNotice })));

export const SpaceHeader = React.memo<SpaceHeaderProps>((props) => {
  const { spaceName, duration = 0, isRecording = false, layout = "focus", onLayoutChange, className } = props;
  const remaining = props.timeLeft != null && props.timeLeft <= 600 ? props.timeLeft : null;
  const timer = remaining === null ? formatDuration(duration) : `${formatDuration(remaining)} left`;
  const [sounds, setSounds] = useSoundsSetting();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const focusScope = useRef<HTMLElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // A host alone at call start sees the menu open with the QR code expanded; it closes when someone joins or the host closes it.
  const inviteOpen = props.callLinkOpen ?? false;
  const open = menuOpen || inviteOpen;
  // The reveal opens the moment the call goes live, so its body is downloaded by then and the menu has content on its first frame.
  const live = props.network?.live === true;
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] Start the menu body's download when the call goes live.
  useEffect(() => {
    if (live) warmDetails();
  }, [live]);
  // The chip opens the menu with the connection charts showing; the plain trigger opens it closed.
  const [revealConnection, setRevealConnection] = useState(false);
  const link = props.network?.live ? props.network.link : undefined;
  const [dismissed, setDismissed] = useState<NoticeTier | null>(null);
  if (dismissed !== null && (link === undefined || link.tier === "good")) setDismissed(null);
  const notice = shownNotice(link, dismissed);
  const { onCallLinkToggle } = props;
  const changeOpen = useCallback(
    (next: boolean) => {
      setMenuOpen(next);
      setRevealConnection(false);
      if (!next && inviteOpen) onCallLinkToggle?.();
    },
    [inviteOpen, onCallLinkToggle],
  );
  const [dialog, setDialog] = useState<{ kind: "shortcuts" | "report"; open: boolean }>({ kind: "shortcuts", open: false });
  const showShortcuts = useCallback(() => setDialog({ kind: "shortcuts", open: true }), []);
  useCallShortcuts(props.shortcuts, showShortcuts);
  const narrowWindow = useMediaQuery("(max-width: 640px)");
  const phone = useNarrowCall() || narrowWindow;
  // Desktop shows recording as the Rec pill beside the name; the pill is hidden on phones, so there the elapsed time turns red instead.
  const timerStyle = (isRecording && phone) || (remaining !== null && remaining <= 60) ? { color: "var(--chalk-danger-text)" } : remaining === null ? undefined : { color: "var(--chalk-warning)" };
  const chevron = (
    <svg width={phone ? "16" : "14"} height={phone ? "16" : "14"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
  const trigger = (
    <button ref={triggerRef} type="button" data-part="call-name" title={spaceName} aria-label="Call details" className="chalk-call-name" onPointerEnter={() => warmDetails()} onFocus={() => warmDetails()}>
      <span dir="auto">{spaceName}</span>
      <span data-part="call-timer" className="chalk-call-timer" style={timerStyle}>
        {timer}
      </span>
      {chevron}
    </button>
  );
  const content = (hideShortcuts: boolean) => (
    <Suspense fallback={null}>
      <CallDetails
        {...props}
        onClose={() => changeOpen(false)}
        revealConnection={revealConnection}
        hideShortcuts={hideShortcuts}
        revealQr={inviteOpen && !revealConnection}
        sounds={sounds}
        onSoundsChange={setSounds}
        onDialog={(kind) => {
          changeOpen(false);
          if (kind === "report" && props.onOpenReportProblem) props.onOpenReportProblem();
          else setDialog({ kind, open: true });
        }}
      />
    </Suspense>
  );
  const noticeSlot = notice ? (
    <div data-part="connection-notice-slot" data-phone={phone || undefined} className="chalk-connection-notice-slot">
      <Suspense fallback={null}>
        <ConnectionNotice
          tier={notice.tier}
          reason={notice.reason}
          videoOn={props.videoOn === true}
          onOpenDetails={() => {
            setRevealConnection(true);
            setMenuOpen(true);
          }}
          onTurnOffVideo={() => props.onTurnOffVideo?.()}
          onDismiss={() => setDismissed(notice.tier)}
        />
      </Suspense>
    </div>
  ) : null;
  return (
    <header ref={focusScope} data-part="header-region" className={cn("chalk-header", className)} role="banner">
      <ShellStyles />
      <div className="chalk-header-title flex min-w-0 items-center gap-3">
        {phone ? (
          <>
            <button
              ref={triggerRef}
              type="button"
              data-call-link-trigger
              data-part="call-name"
              title={spaceName}
              className="chalk-call-name chalk-call-name-phone"
              aria-label="Call details"
              aria-haspopup="dialog"
              aria-expanded={open}
              onPointerDown={() => warmDetails()}
              onClick={() => changeOpen(true)}
            >
              <span dir="auto">{spaceName}</span>
              <span data-part="call-timer" className="chalk-call-timer" style={timerStyle}>
                {timer}
              </span>
              {chevron}
            </button>
            <ChalkSheet variant="details" open={open} onOpenChange={changeOpen} title={inviteOpen ? "Your call is ready" : spaceName} accessibleLabel="Call details">
              {content(true)}
            </ChalkSheet>
          </>
        ) : (
          <ChalkPopover open={open} onOpenChange={changeOpen} tooltip="Call details" trigger={trigger} label="Call details" className="chalk-call-details" alignOffset={-2}>
            {content(false)}
          </ChalkPopover>
        )}
        {phone ? null : noticeSlot}
        {isRecording ? (
          <span className="chalk-shell-recording">
            <i />
            Rec
          </span>
        ) : null}
      </div>
      {phone ? noticeSlot : null}
      {props.notices}
      <div className="chalk-header-layout flex items-center gap-2">
        {props.onTogglePeople ? (
          <button type="button" className="chalk-shell-people-pill" aria-label={`People, ${props.people?.length ?? 0}${props.knockCount ? `, ${props.knockCount} waiting to join` : ""}`} onClick={props.onTogglePeople}>
            <span className="chalk-shell-faces">
              {props.people?.slice(0, 3).map((person) => (
                <Avatar key={person.participantId} name={person.displayName} size="xs" />
              ))}
            </span>
            <span>{props.people?.length ?? 0}</span>
            {props.knockCount ? <span className="chalk-shell-people-badge">{props.knockCount}</span> : null}
          </button>
        ) : null}
        {onLayoutChange ? <LayoutMenu layout={layout} onLayoutChange={onLayoutChange} /> : null}
      </div>
      <CallDialog
        focusScope={focusScope}
        returnFocus={triggerRef}
        kind={dialog.kind}
        open={dialog.open}
        onClose={() => setDialog((current) => ({ ...current, open: false }))}
        onReportProblem={props.onReportProblem}
        unavailableReason={props.reportUnavailableReason}
        diagnostics={props.diagnostics?.map(({ label, value }) => `${label}: ${value}`).join("\n") ?? ""}
      />
    </header>
  );
});
SpaceHeader.displayName = "SpaceHeader";
