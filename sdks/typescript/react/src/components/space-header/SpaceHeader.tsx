import React, { useRef, useState } from "react";
import { cn } from "../../utils/cn";
import { useIsMobile } from "../../internal/useMediaQuery";
import { useSoundsSetting } from "../../internal/useSoundsSetting";
import { ChalkCopyButton, ChalkPopover, ChalkSegmentedControl, ChalkSheet, ChalkToggle } from "../chalk-ui";
import { LayoutMenu } from "./LayoutMenu";
import { formatDuration, type SpaceHeaderProps } from "./space-header-contract";
export { formatDuration, type SpaceHeaderProps } from "./space-header-contract";
export const SpaceHeader = React.memo<SpaceHeaderProps>(({ spaceName, duration = 0, isRecording = false, layout = "focus", onLayoutChange, colorScheme = "dark", onColorSchemeChange, className }) => {
  const menuHost = useRef<HTMLDivElement>(null);
  const [sounds, setSounds] = useSoundsSetting();
  const [open, setOpen] = useState(false);
  const phone = useIsMobile();
  const trigger = (
    <button type="button" data-part="call-name" aria-label="Call details" className="chalk-call-name">
      <span dir="auto">{spaceName}</span>
      <span data-part="call-timer" className="chalk-call-timer">
        {formatDuration(duration)}
      </span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  );
  const content = (
    <div className="chalk-details">
      <div className="chalk-details-row">
        <span>Share</span>
        <ChalkCopyButton text={typeof location === "undefined" ? "" : location.href} />
      </div>
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
        <ChalkToggle aria-label="Sounds" pressed={sounds} onPressedChange={setSounds} />
      </div>
    </div>
  );
  return (
    <header data-part="header" className={cn("chalk-header", className)} role="banner">
      <div ref={menuHost} className="absolute top-0 left-0" />
      <div className="chalk-header-title flex min-w-0 items-center gap-3">
        {phone ? (
          <>
            <button type="button" data-part="call-name" className="chalk-call-name chalk-call-name-phone" aria-label="Call details" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
              <span dir="auto">{spaceName}</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            <span data-part="call-timer" className="chalk-call-timer">
              {formatDuration(duration)}
            </span>
            <ChalkSheet variant="details" open={open} onOpenChange={setOpen} title="Call details">
              {content}
            </ChalkSheet>
          </>
        ) : (
          <ChalkPopover trigger={trigger} label="Call details" className="chalk-call-details">
            {content}
          </ChalkPopover>
        )}
        {isRecording ? <span className="text-[var(--chalk-danger-text)]">Rec</span> : null}
      </div>
      <div className="chalk-header-layout">{onLayoutChange ? <LayoutMenu layout={layout} onLayoutChange={onLayoutChange} container={menuHost} /> : null}</div>
    </header>
  );
});
SpaceHeader.displayName = "SpaceHeader";
