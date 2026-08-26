import { useCallback, useEffect, useRef } from "react";

import { isChatScrollAtBottom, latestVisibleChatSequence, markChatSequenceRead } from "./chat-panel-model";

interface Current<T> {
  current: T;
}

interface ChatScrollReaderOptions {
  readonly scrollRef: Current<HTMLDivElement | null>;
  readonly isAtBottomRef: Current<boolean>;
  readonly lastMarkedSequenceRef: Current<string | null>;
  readonly latestSequence: string | undefined;
  readonly onMarkRead: ((throughSequence: string) => void | Promise<unknown>) | undefined;
}

export function useChatScrollReader({ scrollRef, isAtBottomRef, lastMarkedSequenceRef, latestSequence, onMarkRead }: ChatScrollReaderOptions): () => void {
  const frameRef = useRef<number | null>(null);
  const currentReadRef = useRef({ latestSequence, onMarkRead });
  currentReadRef.current = { latestSequence, onMarkRead };

  useEffect(
    () => () => {
      if (frameRef.current !== null) globalThis.cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = globalThis.requestAnimationFrame(() => {
      frameRef.current = null;
      const scroller = scrollRef.current;
      if (!scroller) return;
      const atBottom = isChatScrollAtBottom(scroller);
      isAtBottomRef.current = atBottom;
      if (atBottom) {
        const { latestSequence: currentLatestSequence, onMarkRead: currentOnMarkRead } = currentReadRef.current;
        if (currentLatestSequence) markChatSequenceRead(currentLatestSequence, lastMarkedSequenceRef, currentOnMarkRead);
        return;
      }
      const visibleSequence = latestVisibleChatSequence(scroller);
      if (visibleSequence) markChatSequenceRead(visibleSequence, lastMarkedSequenceRef, currentReadRef.current.onMarkRead);
    });
  }, [isAtBottomRef, lastMarkedSequenceRef, scrollRef]);
}
