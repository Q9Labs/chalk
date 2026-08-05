import type { ChatMessage, ChatReadReceipt } from "@q9labsai/chalk-client";
import type React from "react";

const BOTTOM_THRESHOLD_PX = 24;

export function groupChatMessages(messages: readonly ChatMessage[]) {
  const groups: { readonly participantId: string; readonly firstMessageId: string; readonly messages: ChatMessage[] }[] = [];
  for (const message of messages) {
    const group = groups.at(-1);
    const previous = group?.messages.at(-1);
    const withinWindow = previous && new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 120_000;
    if (group && group.participantId === message.participantId && withinWindow) {
      group.messages.push(message);
    } else {
      groups.push({ participantId: message.participantId, firstMessageId: message.messageId, messages: [message] });
    }
  }
  return groups;
}

export function receiptsForChatMessage(sequence: string, receipts: readonly ChatReadReceipt[], localParticipantId: string | undefined) {
  return receipts.filter((receipt) => receipt.participantId !== localParticipantId && compareChatSequence(receipt.readThroughSequence, sequence) >= 0);
}

export function compareChatSequence(left: string, right: string): number {
  const leftSequence = BigInt(left);
  const rightSequence = BigInt(right);
  return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
}

export function isChatScrollAtBottom(scroller: HTMLElement): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= BOTTOM_THRESHOLD_PX;
}

export function latestVisibleChatSequence(scroller: HTMLElement): string | null {
  const viewport = scroller.getBoundingClientRect();
  let latest: string | null = null;
  for (const element of scroller.querySelectorAll<HTMLElement>("[data-chat-sequence]")) {
    const bounds = element.getBoundingClientRect();
    if (bounds.bottom > viewport.top && bounds.top < viewport.bottom) latest = element.dataset.chatSequence ?? null;
  }
  return latest;
}

export function markChatSequenceRead(sequence: string, lastMarkedSequenceRef: React.MutableRefObject<string | null>, onMarkRead: ((throughSequence: string) => void | Promise<unknown>) | undefined): void {
  if (!onMarkRead) return;
  const previous = lastMarkedSequenceRef.current;
  if (previous && compareChatSequence(sequence, previous) <= 0) return;
  lastMarkedSequenceRef.current = sequence;
  void Promise.resolve(onMarkRead(sequence)).catch(() => {
    if (lastMarkedSequenceRef.current === sequence) lastMarkedSequenceRef.current = previous;
  });
}
