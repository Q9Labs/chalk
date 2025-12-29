import { useCallback, useEffect, useRef } from 'react';

export type AnnouncementPoliteness = 'polite' | 'assertive';

export interface UseAnnouncerOptions {
  politeness?: AnnouncementPoliteness;
}

export interface UseAnnouncerReturn {
  announce: (message: string, politeness?: AnnouncementPoliteness) => void;
  announcePolite: (message: string) => void;
  announceAssertive: (message: string) => void;
}

export function useAnnouncer(options: UseAnnouncerOptions = {}): UseAnnouncerReturn {
  const { politeness: defaultPoliteness = 'polite' } = options;
  const politeRef = useRef<HTMLDivElement | null>(null);
  const assertiveRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Create screen reader announcement containers
    const createContainer = (politeness: AnnouncementPoliteness): HTMLDivElement => {
      const container = document.createElement('div');
      container.setAttribute('role', 'status');
      container.setAttribute('aria-live', politeness);
      container.setAttribute('aria-atomic', 'true');
      container.style.cssText = `
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      `;
      document.body.appendChild(container);
      return container;
    };

    politeRef.current = createContainer('polite');
    assertiveRef.current = createContainer('assertive');

    return () => {
      politeRef.current?.remove();
      assertiveRef.current?.remove();
    };
  }, []);

  const announce = useCallback((message: string, politeness: AnnouncementPoliteness = defaultPoliteness) => {
    const container = politeness === 'assertive' ? assertiveRef.current : politeRef.current;
    if (!container) return;

    // Clear and re-announce to trigger screen reader
    container.textContent = '';
    requestAnimationFrame(() => {
      container.textContent = message;
    });
  }, [defaultPoliteness]);

  const announcePolite = useCallback((message: string) => announce(message, 'polite'), [announce]);
  const announceAssertive = useCallback((message: string) => announce(message, 'assertive'), [announce]);

  return {
    announce,
    announcePolite,
    announceAssertive,
  };
}
