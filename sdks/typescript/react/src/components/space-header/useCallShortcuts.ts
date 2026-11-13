import { useEffect, useRef } from "react";
import type { SpaceHeaderProps } from "./space-header-contract";
export function useCallShortcuts(actions: SpaceHeaderProps["shortcuts"], show: () => void) {
  const latest = useRef(actions);
  latest.current = actions;
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [subscription] Own global call shortcuts and push-to-talk release; remove listeners and release any held press on cleanup.
  useEffect(() => {
    let talking = false;
    const restore = () => {
      if (talking) {
        talking = false;
        latest.current?.onPushToTalk?.(false);
      }
    };
    const down = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.key === "Escape") {
        latest.current?.onClosePanel?.();
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input,textarea,select,[contenteditable="true"],[role="dialog"]')) return;
      if (event.key === "?" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        show();
        return;
      }
      if (event.code === "Space" && target instanceof HTMLElement && !target.closest('button,[role="button"],[role="menu"]') && latest.current?.onPushToTalk && latest.current.isMuted) {
        event.preventDefault();
        talking = true;
        latest.current.onPushToTalk(true);
        return;
      }
      const action = chordAction(latest.current, event);
      if (action) {
        event.preventDefault();
        action();
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") restore();
    };
    document.addEventListener("keydown", down);
    document.addEventListener("keyup", up);
    window.addEventListener("blur", restore);
    return () => {
      document.removeEventListener("keydown", down);
      document.removeEventListener("keyup", up);
      window.removeEventListener("blur", restore);
      restore();
    };
  }, [show]);
}

function chordAction(shortcuts: SpaceHeaderProps["shortcuts"], event: KeyboardEvent): (() => void) | undefined {
  if (!event.metaKey && !event.ctrlKey) return undefined;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey && event.metaKey) || (event.ctrlKey && event.shiftKey)) {
    if (key === "h") return shortcuts?.onToggleHand;
    if (key === "c") return shortcuts?.onToggleChat;
    if (key === "p") return shortcuts?.onTogglePeople;
    if (key === "l") return shortcuts?.onToggleLayout;
    if (key === "f") return shortcuts?.onToggleFullscreen;
    return undefined;
  }
  if (key === "d") return shortcuts?.onToggleMute;
  if (key === "e") return shortcuts?.onToggleVideo;
  return undefined;
}
