import { useRef, useSyncExternalStore } from "react";
import { AppState, NativeModules, Platform } from "react-native";
import { shouldAutoReadClipboard } from "./runtime";
import { createClipboardTextStore, type ClipboardTextStore } from "./clipboard-store";

export interface NativeClipboardReader {
  hasStringAsync(): Promise<boolean>;
  getStringAsync(): Promise<string>;
}

export interface UseClipboardInviteSuggestionOptions {
  clipboard: NativeClipboardReader;
  getSuggestion: (clipboardText: string | null | undefined, currentInput: string) => string | null;
}

export function useClipboardInviteSuggestion(currentInput: string, { clipboard, getSuggestion }: UseClipboardInviteSuggestionOptions): string | null {
  const runtimeInfo: unknown = NativeModules.ChalkRuntimeInfo;
  const isIosSimulator = typeof runtimeInfo === "object" && runtimeInfo !== null && "isSimulator" in runtimeInfo && runtimeInfo.isSimulator === true;
  const shouldReadClipboard = shouldAutoReadClipboard({
    platform: Platform.OS,
    isSimulator: isIosSimulator,
  });
  const clipboardStoreRef = useRef<ClipboardTextStore | null>(null);
  const currentStore = clipboardStoreRef.current;
  const clipboardStore =
    currentStore !== null && currentStore.clipboard === clipboard && currentStore.shouldReadClipboard === shouldReadClipboard
      ? currentStore
      : (clipboardStoreRef.current = createClipboardTextStore({
          clipboard,
          shouldReadClipboard,
          subscribeToAppState: (listener) => AppState.addEventListener("change", listener),
        }));
  const clipboardText = useSyncExternalStore(clipboardStore.subscribe, clipboardStore.getSnapshot, clipboardStore.getSnapshot);

  return getSuggestion(clipboardText, currentInput);
}
