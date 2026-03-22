import { useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import * as Clipboard from "expo-clipboard";
import { getClipboardInviteSuggestion } from "../lib/inviteLink";

export function useClipboardInviteSuggestion(currentInput: string) {
  const [clipboardText, setClipboardText] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const refreshClipboardText = async () => {
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
    const clipboardSubscription = Clipboard.addClipboardListener(() => {
      void refreshClipboardText();
    });
    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        void refreshClipboardText();
      }
    });

    return () => {
      isMounted = false;
      clipboardSubscription.remove();
      appStateSubscription.remove();
    };
  }, []);

  return useMemo(() => getClipboardInviteSuggestion(clipboardText, currentInput), [clipboardText, currentInput]);
}
