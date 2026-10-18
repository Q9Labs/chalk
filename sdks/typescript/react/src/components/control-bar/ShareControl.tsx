import { Menu } from "@base-ui/react/menu";
import { useState } from "react";
import type { ScreenShareOptions, ScreenShareSurface } from "@q9labsai/chalk-client";
import { ChalkMenu, ChalkMenuItem, ChalkMenuLabel, ChalkTooltip } from "../chalk-ui";
import { ArrowDown01Icon, Monitor01Icon, MonitorOffIcon } from "../../utils/icons";

export function ShareControl({ sharing, onToggle, onStart }: { readonly sharing: boolean; readonly onToggle?: () => void; readonly onStart?: (options: ScreenShareOptions) => void }) {
  const [surface, setSurface] = useState<ScreenShareSurface>("window");
  const [audio, setAudio] = useState(false);
  const [replace, setReplace] = useState(false);
  const start = (next: ScreenShareSurface) => {
    setSurface(next);
    setReplace(false);
    onStart?.({ surface: next, audio: next === "browser" && audio });
  };
  return (
    <div data-part="share-split" className="chalk-shell-split chalk-shell-desktop" data-active={sharing}>
      <ChalkTooltip
        trigger={
          <button type="button" className="chalk-shell-main" aria-label={sharing ? "Stop sharing" : "Share screen"} aria-pressed={sharing} onClick={() => (sharing || !onStart ? onToggle?.() : start(surface))}>
            {sharing ? <MonitorOffIcon /> : <Monitor01Icon />}
          </button>
        }
      >
        {sharing ? "Stop sharing" : "Share screen"}
      </ChalkTooltip>
      <ChalkMenu
        side="top"
        trigger={
          <button type="button" className="chalk-shell-caret" aria-label="Share options">
            <ArrowDown01Icon />
          </button>
        }
      >
        {sharing && !replace ? (
          <>
            <ChalkMenuLabel>Sharing your screen</ChalkMenuLabel>
            <Menu.Item className="chalk-menu-item" closeOnClick={false} onClick={() => setReplace(true)}>
              Share something else
            </Menu.Item>
            <ChalkMenuItem onClick={onToggle}>Stop sharing</ChalkMenuItem>
          </>
        ) : (
          <>
            {(
              [
                { value: "monitor", label: "Entire screen" },
                { value: "window", label: "Window" },
                { value: "browser", label: "Browser tab" },
              ] satisfies { value: ScreenShareSurface; label: string }[]
            ).map((option) => (
              <ChalkMenuItem key={option.value} checked={surface === option.value} onClick={() => start(option.value)}>
                {option.label}
              </ChalkMenuItem>
            ))}
            {surface === "browser" ? (
              <Menu.CheckboxItem className="chalk-menu-item" checked={audio} onCheckedChange={setAudio} closeOnClick={false}>
                Share tab audio
                <span className="chalk-shell-menu-switch" aria-hidden="true">
                  <span className="chalk-switch" aria-checked={audio}>
                    <span />
                  </span>
                </span>
              </Menu.CheckboxItem>
            ) : null}
          </>
        )}
      </ChalkMenu>
    </div>
  );
}
