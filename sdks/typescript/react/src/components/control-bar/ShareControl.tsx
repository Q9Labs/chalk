import { ChalkMenuPrimitive as Menu } from "../chalk-ui";
import { useState } from "react";
import type { ScreenShareOptions, ScreenShareSurface } from "@q9labsai/chalk-client";
import { ChalkMenu, ChalkMenuItem, ChalkMenuLabel, ChalkTooltip } from "../chalk-ui";
import { ShellIcon } from "./ShellIcon";
import { MenuIcon } from "../chalk-ui/MenuIcon";
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
          <path d="M3 20V7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10z" />
          <path d="M3 11h18" />
        </>
      )}
    </svg>
  );
}

export function ShareControl({
  sharing,
  onToggle,
  onStart,
  access,
  disabled = false,
  startDisabled = false,
}: {
  readonly disabled?: boolean;
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
          </>
        ) : (
          <>
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
                    <MenuIcon name="selected" />
                  ) : null}
                </span>
              </Menu.Item>
            ))}
            {surface === "browser" ? (
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
            ) : null}
          </>
        )}
      </ChalkMenu>
    </div>
  );
}
