import type { Participant } from "../participant-grid/ParticipantGrid";

export type StageLayout = "grid" | "focus" | "presentation";

export const WHITEBOARD_ITEM_ID = "whiteboard";

export const screenShareItemId = (participantId: string): string => `screen-share:${participantId}`;

/** Everything on the stage is an item: participants, one item per live screen share, and the whiteboard when open. */
export type StageItem =
  | { readonly kind: "participant"; readonly id: string; readonly participant: Participant }
  | { readonly kind: "screen-share"; readonly id: string; readonly participant: Participant; readonly track: MediaStreamTrack }
  | { readonly kind: "whiteboard"; readonly id: typeof WHITEBOARD_ITEM_ID };

export function buildStageItems(participants: readonly Participant[], whiteboardOpen: boolean): StageItem[] {
  const items: StageItem[] = participants.map((participant) => ({ kind: "participant", id: participant.id, participant }));
  for (const participant of participants) {
    if (participant.isScreenSharing && participant.screenShareTrack) {
      items.push({ kind: "screen-share", id: screenShareItemId(participant.id), participant, track: participant.screenShareTrack });
    }
  }
  if (whiteboardOpen) items.push({ kind: "whiteboard", id: WHITEBOARD_ITEM_ID });
  return items;
}

export function isContentItem(item: StageItem): boolean {
  return item.kind !== "participant";
}

/** Keeps surviving items in their previous order and appends newcomers, so tiles do not reshuffle. */
export function stabilizeOrder(previousIds: readonly string[], items: readonly StageItem[]): StageItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered: StageItem[] = [];
  const placed = new Set<string>();
  for (const id of previousIds) {
    const item = byId.get(id);
    if (!item || placed.has(id)) continue;
    ordered.push(item);
    placed.add(id);
  }
  for (const item of items) {
    if (placed.has(item.id)) continue;
    ordered.push(item);
    placed.add(item.id);
  }
  return ordered;
}

export interface PrimaryContext {
  readonly layout: StageLayout;
  readonly pinnedId: string | null;
  readonly lastSpeakerId: string | null;
  /** Monotonic first-seen order per item id; larger is newer. */
  readonly seenAt: ReadonlyMap<string, number>;
}

function newestScreenShare(items: readonly StageItem[], seenAt: ReadonlyMap<string, number>): StageItem | undefined {
  let newest: StageItem | undefined;
  let newestSeen = -1;
  for (const item of items) {
    if (item.kind !== "screen-share") continue;
    const seen = seenAt.get(item.id) ?? -1;
    if (seen >= newestSeen) {
      newest = item;
      newestSeen = seen;
    }
  }
  return newest;
}

function participantWhere(items: readonly StageItem[], predicate: (participant: Participant) => boolean): StageItem | undefined {
  return items.find((item) => item.kind === "participant" && predicate(item.participant));
}

/**
 * Picks the primary tile for spotlight layouts. `presentation` is content-first, `focus` is speaker-first;
 * both fall back through the same chain. Returns null when there is nothing to show.
 */
export function choosePrimary(items: readonly StageItem[], context: PrimaryContext): StageItem | null {
  if (items.length === 0) return null;
  const pinned = context.pinnedId ? items.find((item) => item.id === context.pinnedId) : undefined;
  if (pinned) return pinned;

  const content = () => newestScreenShare(items, context.seenAt) ?? items.find((item) => item.kind === "whiteboard");
  const speaker = () =>
    participantWhere(items, (participant) => participant.isActiveSpeaker === true) ?? participantWhere(items, (participant) => participant.isSpeaking === true) ?? (context.lastSpeakerId ? items.find((item) => item.kind === "participant" && item.id === context.lastSpeakerId) : undefined);
  const ordered = context.layout === "presentation" ? [content, speaker] : [speaker, content];
  for (const pick of ordered) {
    const item = pick();
    if (item) return item;
  }
  return participantWhere(items, (participant) => !participant.isLocal) ?? participantWhere(items, () => true) ?? items[0] ?? null;
}

/** Grid order: pinned item first, everything else in stable order. */
export function gridOrder(items: readonly StageItem[], pinnedId: string | null): StageItem[] {
  if (!pinnedId) return [...items];
  const pinned = items.find((item) => item.id === pinnedId);
  return pinned ? [pinned, ...items.filter((item) => item.id !== pinnedId)] : [...items];
}
