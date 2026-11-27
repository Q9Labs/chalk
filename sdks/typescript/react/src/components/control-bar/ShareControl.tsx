import { ChalkMenuPrimitive as Menu } from "../chalk-ui";
import type React from "react";
import { useState } from "react";
import type { ScreenShareOptions, ScreenShareSurface } from "@q9labsai/chalk-client";
import { ChalkMenu, ChalkMenuItem, ChalkMenuLabel, ChalkTooltip } from "../chalk-ui";
import { ShellIcon } from "./ShellIcon";
import type { DeviceAccessControl } from "../device-access/DeviceAccessCard";
import { LazyDeviceAccessCard } from "../device-access/LazyDeviceAccessCard";

function SourceIcon({ source }: { readonly source: ScreenShareSurface }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {source === "monitor" ? (
        <>
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </>
      ) : source === "window" ? (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18M6.5 6.5h.01M9 6.5h.01" />
        </>
      ) : (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18M10 4v5" />
        </>
      )}
    </svg>
  );
}

/** Presenting a file lives in the Share menu beside the screen sources, so the dock keeps one way to put something on the Stage. */
export interface ShareControlPresent {
  /** What the Stage accepts, like "PDF or image, up to 25 MB". */
  readonly hint: string;
  readonly presenting: boolean;
  readonly onChoose: () => void;
}

function PresentFileItem({ present }: { readonly present: ShareControlPresent }): React.JSX.Element {
  return (
    <>
      <Menu.Separator className="chalk-shell-menu-separator" />
      <ChalkMenuLabel>Present</ChalkMenuLabel>
      <Menu.Item className="chalk-menu-item chalk-shell-source" onClick={present.onChoose}>
        <ShellIcon name="present" />
        <span className="chalk-shell-device-label">
          <span>{present.presenting ? "Another file" : "A file"}</span>
          <small>{present.presenting ? "Replaces yours for everyone" : present.hint}</small>
        </span>
      </Menu.Item>
    </>
  );
}

export function ShareControl({
  sharing,
  onToggle,
  onStart,
  access,
  present,
  disabled = false,
  startDisabled = false,
  helperInstallUrl,
}: {
  readonly present?: ShareControlPresent;
  readonly disabled?: boolean;
  readonly helperInstallUrl?: string;
  readonly startDisabled?: boolean;
  readonly sharing: boolean;
  readonly access?: DeviceAccessControl;
  readonly onToggle?: () => void;
  readonly onStart?: (options: ScreenShareOptions) => void;
}) {
  const [split, setSplit] = useState<HTMLDivElement | null>(null);
  const [surface, setSurface] = useState<ScreenShareSurface>("window");
  const [audio, setAudio] = useState(true);
  const [replace, setReplace] = useState(false);
  const accessLabel = access?.label;
  const start = (next: ScreenShareSurface) => {
    if (disabled || startDisabled) return;
    setSurface(next);
    setReplace(false);
    onStart?.({ surface: next, audio: next === "browser" && audio });
  };
  return (
    <div ref={setSplit} data-part="share-split" className="chalk-shell-split chalk-shell-desktop" data-active={sharing} data-blocked={!!access || undefined}>
      <ChalkTooltip
        trigger={
          <button
            type="button"
            className="chalk-shell-main"
            disabled={disabled}
            aria-label={accessLabel ?? (sharing ? "Stop sharing" : "Share screen")}
            aria-pressed={sharing}
            aria-haspopup={access ? "dialog" : undefined}
            aria-expanded={access?.open}
            onClick={access ? () => access.onOpenChange(!access.open) : () => (sharing || !onStart ? onToggle?.() : start(surface))}
          >
            <ShellIcon name={sharing ? "shareOff" : "share"} />
          </button>
        }
      >
        {accessLabel ?? (sharing ? "Stop sharing" : "Share screen")}
      </ChalkTooltip>
      {access ? <LazyDeviceAccessCard device="screen" anchor={split} control={access} /> : null}
      <ChalkMenu
        side="top"
        className="chalk-device-menu"
        trigger={
          <button type="button" className="chalk-shell-caret" disabled={disabled || startDisabled} aria-label="Share options">
            <ShellIcon name="down" />
          </button>
        }
      >
        {sharing && !replace ? (
          <>
            <ChalkMenuLabel>Sharing your screen</ChalkMenuLabel>
            <Menu.Item className="chalk-menu-item" disabled={disabled || startDisabled} closeOnClick={false} onClick={() => setReplace(true)}>
              Share something else
            </Menu.Item>
            <ChalkMenuItem onClick={onToggle}>Stop sharing</ChalkMenuItem>
            {present ? <PresentFileItem present={present} /> : null}
          </>
        ) : (
          <>
            <ChalkMenuLabel>Share your screen</ChalkMenuLabel>
            {(
              [
                { value: "monitor", label: "Entire screen", description: "Everything on one display" },
                { value: "window", label: "Window", description: "One app, like Slides or Figma" },
                { value: "browser", label: "Browser tab", description: "One tab, and its sound if you like" },
              ] satisfies { value: ScreenShareSurface; label: string; description: string }[]
            ).map((option) => (
              <Menu.Item key={option.value} className="chalk-menu-item chalk-shell-source" disabled={disabled || startDisabled} role="menuitemradio" aria-label={option.label} aria-checked={surface === option.value} onClick={() => start(option.value)}>
                <SourceIcon source={option.value} />
                <span className="chalk-shell-device-label">
                  <span>{option.label}</span>
                  <small>{option.description}</small>
                </span>
                <span className="chalk-menu-check" aria-hidden="true">
                  {surface === option.value ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  ) : null}
                </span>
              </Menu.Item>
            ))}
            {present ? <PresentFileItem present={present} /> : null}
            {/* The switch always follows the sources, so tab audio can be set before a tab is picked. */}
            <>
              <Menu.Separator className="chalk-shell-menu-separator" />
              <Menu.CheckboxItem className="chalk-menu-item" checked={audio} onCheckedChange={setAudio} closeOnClick={false}>
                <span className="chalk-shell-device-label">
                  <span>Share tab audio</span>
                  <small>Works when you share a browser tab</small>
                </span>
                <span className="chalk-shell-menu-switch" aria-hidden="true">
                  <span className="chalk-switch" aria-checked={audio}>
                    <span />
                  </span>
                </span>
              </Menu.CheckboxItem>
            </>
          </>
        )}
        {helperInstallUrl ? (
          <>
            <Menu.Separator className="chalk-shell-menu-separator" />
            <Menu.LinkItem className="chalk-menu-item chalk-shell-source" href={helperInstallUrl} target="_blank" rel="noopener noreferrer">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
              </svg>
              <span className="chalk-shell-device-label">
                <span>Get Chalk Helper</span>
                <small>See marks on your real screen</small>
              </span>
            </Menu.LinkItem>
          </>
        ) : null}
      </ChalkMenu>
    </div>
  );
}
