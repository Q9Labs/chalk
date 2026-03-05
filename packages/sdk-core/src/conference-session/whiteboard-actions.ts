import type { Participant } from "../types.ts";
import type { WSClient } from "../ws-client.ts";

interface WhiteboardActionsDeps {
  getWsClient: () => WSClient | undefined;
  getLocalParticipant: () => Participant | null;
  getParticipants: () => Map<string, Participant>;
  getWhiteboardPermission: (participantId: string) => boolean | undefined;
  getDefaultWhiteboardAccess: () => boolean;
}

export const createConferenceSessionWhiteboardActions = (deps: WhiteboardActionsDeps) => {
  const canDrawWhiteboard = (participantId?: string): boolean => {
    const id = participantId ?? deps.getLocalParticipant()?.id;

    if (!id) {
      return deps.getDefaultWhiteboardAccess();
    }

    const participant = deps.getParticipants().get(id);
    if (participant?.role === "host") {
      return true;
    }

    const explicit = deps.getWhiteboardPermission(id);
    if (explicit !== undefined) {
      return explicit;
    }

    return deps.getDefaultWhiteboardAccess();
  };

  const grantWhiteboardPermission = (participantId: string): void => {
    if (deps.getLocalParticipant()?.role !== "host") {
      return;
    }
    deps.getWsClient()?.grantWhiteboardPermission(participantId);
  };

  const revokeWhiteboardPermission = (participantId: string): void => {
    if (deps.getLocalParticipant()?.role !== "host") {
      return;
    }
    deps.getWsClient()?.revokeWhiteboardPermission(participantId);
  };

  const sendWhiteboardUpdate = (elements: unknown[], files?: Record<string, unknown>, seq?: number): void => {
    deps.getWsClient()?.sendWhiteboardUpdate(elements, files, seq);
  };

  const sendWhiteboardUpdateV2 = (payload: { sceneId: string; syncAll: boolean; elements: unknown[]; seq?: number }): void => {
    deps.getWsClient()?.sendWhiteboardUpdateV2(payload);
  };

  const sendWhiteboardCursor = (x: number, y: number): void => {
    deps.getWsClient()?.sendWhiteboardCursor(x, y);
  };

  const clearWhiteboard = (): void => {
    deps.getWsClient()?.sendWhiteboardClear();
  };

  const requestWhiteboardSync = (): void => {
    deps.getWsClient()?.requestWhiteboardSync();
  };

  const openWhiteboard = (): void => {
    deps.getWsClient()?.sendWhiteboardOpen();
  };

  const closeWhiteboard = (): void => {
    deps.getWsClient()?.sendWhiteboardClose();
  };

  return {
    canDrawWhiteboard,
    grantWhiteboardPermission,
    revokeWhiteboardPermission,
    sendWhiteboardUpdate,
    sendWhiteboardUpdateV2,
    sendWhiteboardCursor,
    clearWhiteboard,
    requestWhiteboardSync,
    openWhiteboard,
    closeWhiteboard,
  };
};
