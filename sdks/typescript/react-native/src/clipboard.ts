import { useEffect, useMemo, useState } from "react";
import { AppState, NativeModules, Platform } from "react-native";
import { shouldAutoReadClipboard } from "./runtime";

export interface NativeClipboardReader {
  hasStringAsync(): Promise<boolean>;
  getStringAsync(): Promise<string>;
}

export interface UseClipboardInviteSuggestionOptions {
  clipboard: NativeClipboardReader;
  getSuggestion: (clipboardText: string | null | undefined, currentInput: string) => string | null;
}

export function useClipboardInviteSuggestion(currentInput: string, { clipboard, getSuggestion }: UseClipboardInviteSuggestionOptions): string | null {
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
        const hasString = await clipboard.hasStringAsync();
        if (!isMounted) {
          return;
        }

        if (!hasString) {
          setClipboardText(null);
          return;
        }

        const nextClipboardText = await clipboard.getStringAsync();
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
  }, [clipboard]);

  return useMemo(() => getSuggestion(clipboardText, currentInput), [clipboardText, currentInput, getSuggestion]);
}
