export interface KeyboardShortcut {
  key: string;
  description: string;
  action: () => void;
}
export function createMeetingShortcuts(): KeyboardShortcut[] {
  return [];
}
export function useKeyboardShortcuts(_shortcuts: KeyboardShortcut[] = []): void {}
