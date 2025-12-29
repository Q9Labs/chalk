import { useEffect, useCallback, useRef } from 'react';

export interface KeyboardShortcut {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  action: () => void;
  description: string;
  enabled?: boolean;
}

export interface UseKeyboardShortcutsOptions {
  shortcuts: KeyboardShortcut[];
  enabled?: boolean;
  preventDefault?: boolean;
}

export interface UseKeyboardShortcutsReturn {
  shortcuts: KeyboardShortcut[];
  setEnabled: (enabled: boolean) => void;
  enabled: boolean;
}

export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions): UseKeyboardShortcutsReturn {
  const { shortcuts, enabled: initialEnabled = true, preventDefault = true } = options;
  const enabledRef = useRef(initialEnabled);

  const setEnabled = useCallback((value: boolean) => {
    enabledRef.current = value;
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!enabledRef.current) return;

      // Ignore if user is typing in an input
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      for (const shortcut of shortcuts) {
        if (shortcut.enabled === false) continue;

        const keyMatch = event.key.toLowerCase() === shortcut.key.toLowerCase();
        const ctrlMatch = !!shortcut.ctrl === (event.ctrlKey || event.metaKey);
        const shiftMatch = !!shortcut.shift === event.shiftKey;
        const altMatch = !!shortcut.alt === event.altKey;

        if (keyMatch && ctrlMatch && shiftMatch && altMatch) {
          if (preventDefault) {
            event.preventDefault();
          }
          shortcut.action();
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts, preventDefault]);

  return {
    shortcuts,
    setEnabled,
    enabled: enabledRef.current,
  };
}

// Default meeting shortcuts factory
export function createMeetingShortcuts(handlers: {
  onToggleMute?: () => void;
  onToggleVideo?: () => void;
  onToggleScreenShare?: () => void;
  onToggleHandRaise?: () => void;
  onToggleChat?: () => void;
  onToggleParticipants?: () => void;
  onToggleTranscription?: () => void;
  onShowShortcuts?: () => void;
  onLeave?: () => void;
}): KeyboardShortcut[] {
  return [
    { key: 'm', action: handlers.onToggleMute ?? (() => {}), description: 'Toggle mute' },
    { key: 'v', action: handlers.onToggleVideo ?? (() => {}), description: 'Toggle video' },
    { key: 's', action: handlers.onToggleScreenShare ?? (() => {}), description: 'Toggle screen share' },
    { key: 'h', action: handlers.onToggleHandRaise ?? (() => {}), description: 'Raise/lower hand' },
    { key: 'c', action: handlers.onToggleChat ?? (() => {}), description: 'Toggle chat' },
    { key: 'p', action: handlers.onToggleParticipants ?? (() => {}), description: 'Toggle participants' },
    { key: 't', action: handlers.onToggleTranscription ?? (() => {}), description: 'Toggle transcription' },
    { key: '?', shift: true, action: handlers.onShowShortcuts ?? (() => {}), description: 'Show keyboard shortcuts' },
  ];
}
