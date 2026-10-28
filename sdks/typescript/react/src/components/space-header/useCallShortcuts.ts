import { useEffect, useRef } from "react";
import type { SpaceHeaderProps } from "./space-header-contract";
export function useCallShortcuts(actions: SpaceHeaderProps["shortcuts"], show: () => void) {
  const latest = useRef(actions);
  latest.current = actions;
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- Keep existing global call-keyboard listener cleanup.
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
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier) return;
      const key = event.key.toLowerCase();
      const extra = (event.ctrlKey && event.metaKey) || (event.ctrlKey && event.shiftKey);
      let action: (() => void) | undefined;
      if (extra) {
        if (key === "h") action = latest.current?.onToggleHand;
        if (key === "c") action = latest.current?.onToggleChat;
        if (key === "p") action = latest.current?.onTogglePeople;
        if (key === "l") action = latest.current?.onToggleLayout;
      } else {
        if (key === "d") action = latest.current?.onToggleMute;
        if (key === "e") action = latest.current?.onToggleVideo;
      }
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
