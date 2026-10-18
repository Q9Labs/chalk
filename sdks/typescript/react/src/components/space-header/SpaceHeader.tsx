import React, { useCallback, useState } from "react";
import { cn } from "../../utils/cn";
import { useMediaQuery } from "../../internal/useMediaQuery";
import { useSoundsSetting } from "../../internal/useSoundsSetting";
import { ChalkPopover, ChalkSheet } from "../chalk-ui";
import { Avatar } from "../atomic/Avatar";
import { LayoutMenu } from "./LayoutMenu";
import { CallDetails, CallDialog } from "./CallDetails";
import { useCallShortcuts } from "./useCallShortcuts";
import { formatDuration, type SpaceHeaderProps } from "./space-header-contract";
import "../control-bar/shell.css";
export { formatDuration, type SpaceHeaderProps } from "./space-header-contract";
export const SpaceHeader = React.memo<SpaceHeaderProps>((props) => {
  const { spaceName, duration = 0, isRecording = false, layout = "focus", onLayoutChange, className, weakConnection } = props;
  const [sounds, setSounds] = useSoundsSetting();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"shortcuts" | "report" | null>(null);
  const showShortcuts = useCallback(() => setDialog("shortcuts"), []);
  useCallShortcuts(props.shortcuts, showShortcuts);
  const phone = useMediaQuery("(max-width: 640px)");
  const chevron = (
    <svg width={phone ? "16" : "14"} height={phone ? "16" : "14"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
  const trigger = (
    <button type="button" data-part="call-name" aria-label="Call details" className="chalk-call-name">
      <span dir="auto">{spaceName}</span>
      <span data-part="call-timer" className="chalk-call-timer">
        {formatDuration(duration)}
      </span>
      {chevron}
    </button>
  );
  const content = (
    <CallDetails
      {...props}
      sounds={sounds}
      onSoundsChange={setSounds}
      onDialog={(kind) => {
        setOpen(false);
        setDialog(kind);
      }}
    />
  );
  return (
    <header data-part="header-region" className={cn("chalk-header", className)} role="banner">
      <div className="chalk-header-title flex min-w-0 items-center gap-3">
        {phone ? (
          <>
            <button type="button" data-part="call-name" className="chalk-call-name chalk-call-name-phone" aria-label="Call details" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
              <span dir="auto">{spaceName}</span>
              {chevron}
            </button>
            <span data-part="call-timer" className="chalk-call-timer">
              {formatDuration(duration)}
            </span>
            <ChalkSheet variant="details" open={open} onOpenChange={setOpen} title="Call details">
              {content}
            </ChalkSheet>
          </>
        ) : (
          <ChalkPopover tooltip="Call details" trigger={trigger} label="Call details" className="chalk-call-details" alignOffset={-2}>
            {content}
          </ChalkPopover>
        )}
        {weakConnection ? (
          <span className="chalk-shell-quality" role="img" aria-label="Your connection is weak">
            {[5, 8, 11, 15].map((height) => (
              <i key={height} style={{ height }} />
            ))}
          </span>
        ) : null}
        {isRecording ? (
          <span className="chalk-shell-recording">
            <i />
            Rec
          </span>
        ) : null}
      </div>
      <div className="chalk-header-layout flex items-center gap-2">
        {props.onTogglePeople ? (
          <button type="button" className="chalk-shell-people-pill" aria-label={`People, ${props.people?.length ?? 0}`} onClick={props.onTogglePeople}>
            <span className="chalk-shell-faces">
              {props.people?.slice(0, 3).map((person) => (
                <Avatar key={person.participantId} name={person.displayName} size="xs" />
              ))}
            </span>
            <span>{props.people?.length ?? 0}</span>
            {props.knockCount ? <span aria-label={`${props.knockCount} waiting to join`}>{props.knockCount}</span> : null}
          </button>
        ) : null}
        {onLayoutChange ? <LayoutMenu layout={layout} onLayoutChange={onLayoutChange} /> : null}
      </div>
      <CallDialog kind={dialog} onClose={() => setDialog(null)} onReportProblem={props.onReportProblem} diagnostics={(props.diagnostics ?? []).map(({ label, value }) => `${label}: ${value}`).join("\n")} />
    </header>
  );
});
SpaceHeader.displayName = "SpaceHeader";
