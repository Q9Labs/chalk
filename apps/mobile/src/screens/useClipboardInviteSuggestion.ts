import { useEffect, useMemo, useState } from "react";
import { AppState, NativeModules, Platform } from "react-native";
import * as Clipboard from "expo-clipboard";
import { getClipboardInviteSuggestion } from "../lib/inviteLink";
import { shouldAutoReadClipboard } from "../lib/mobile-runtime";

export function useClipboardInviteSuggestion(currentInput: string) {
  const [clipboardText, setClipboardText] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    const isIosSimulator = (NativeModules.ChalkRuntimeInfo as { isSimulator?: boolean } | undefined)?.isSimulator === true;
    const shouldReadClipboard = shouldAutoReadClipboard({
      platform: Platform.OS,
      isSimulator: isIosSimulator,
    });

    const refreshClipboardText = async () => {
      if (!shouldReadClipboard) {
        if (isMounted) {
          setClipboardText(null);
        }
        return;
      }

      try {
        const hasString = await Clipboard.hasStringAsync();
        if (!isMounted) {
          return;
        }

        if (!hasString) {
          setClipboardText(null);
          return;
        }

        const nextClipboardText = await Clipboard.getStringAsync();
        if (!isMounted) {
          return;
        }

        setClipboardText(nextClipboardText || null);
      } catch {
        if (isMounted) {
          setClipboardText(null);
        }
      }
    };

    void refreshClipboardText();

    if (!shouldReadClipboard) {
      return () => {
        isMounted = false;
      };
    }

    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        void refreshClipboardText();
      }
    });

    return () => {
      isMounted = false;
      appStateSubscription.remove();
    };
  }, []);

  return useMemo(() => getClipboardInviteSuggestion(clipboardText, currentInput), [clipboardText, currentInput]);
}
