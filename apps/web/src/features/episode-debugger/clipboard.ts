export type ClipboardResult = Readonly<{ copied: true }> | Readonly<{ copied: false; reason: "unavailable" | "denied" }>;

export const writeClipboardText = async (text: string, clipboard: Pick<Clipboard, "writeText"> | undefined = globalThis.navigator?.clipboard): Promise<ClipboardResult> => {
  if (!clipboard) return { copied: false, reason: "unavailable" };
  try {
    await clipboard.writeText(text);
    return { copied: true };
  } catch {
    return { copied: false, reason: "denied" };
  }
};

export const selectClipboardFallback = (element: Pick<HTMLTextAreaElement, "focus" | "select" | "setSelectionRange" | "value">): void => {
  element.focus();
  element.select();
  element.setSelectionRange(0, element.value.length);
};
