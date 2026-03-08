import type {
  AnnotationAccessMode,
  ScreenAnnotationItem,
  ScreenAnnotationTool,
} from "../types/entities/annotations.ts";
import type { Participant } from "../types.ts";
import type { WSClient } from "../ws-client.ts";

interface AnnotationActionsDeps {
  getWsClient: () => WSClient | undefined;
  getLocalParticipant: () => Participant | null;
  getCurrentAccessMode: () => AnnotationAccessMode;
  getCurrentShareSessionId: () => string | null;
  getCurrentSharerParticipantId: () => string | null;
}

export const createConferenceSessionAnnotationActions = (
  deps: AnnotationActionsDeps,
) => {
  const canDrawAnnotations = (participantId?: string): boolean => {
    const resolvedParticipantId =
      participantId ?? deps.getLocalParticipant()?.id ?? null;
    if (!resolvedParticipantId) {
      return false;
    }

    const accessMode = deps.getCurrentAccessMode();
    if (accessMode === "off") {
      return false;
    }

    if (accessMode === "all") {
      return true;
    }

    return deps.getCurrentSharerParticipantId() === resolvedParticipantId;
  };

  const startAnnotationSession = (
    shareSessionId: string,
    accessMode?: AnnotationAccessMode,
  ): void => {
    const localParticipant = deps.getLocalParticipant();
    if (!localParticipant) {
      return;
    }

    deps.getWsClient()?.sendAnnotationSessionStart({
      shareSessionId,
      sharerParticipantId: localParticipant.id,
      accessMode: accessMode ?? deps.getCurrentAccessMode(),
    });
  };

  const endAnnotationSession = (shareSessionId?: string): void => {
    const resolvedShareSessionId =
      shareSessionId ?? deps.getCurrentShareSessionId();
    if (!resolvedShareSessionId) {
      return;
    }

    deps.getWsClient()?.sendAnnotationSessionEnd({
      shareSessionId: resolvedShareSessionId,
    });
  };

  const requestAnnotationSync = (): void => {
    deps.getWsClient()?.requestAnnotationSync(deps.getCurrentShareSessionId() ?? undefined);
  };

  const sendAnnotationUpdate = (payload: {
    shareSessionId: string;
    sharerParticipantId: string;
    syncAll: boolean;
    items: ScreenAnnotationItem[];
    seq?: number;
  }): void => {
    deps.getWsClient()?.sendAnnotationUpdate(payload);
  };

  const sendAnnotationCursor = (payload: {
    shareSessionId: string;
    tool: ScreenAnnotationTool;
    x: number;
    y: number;
  }): void => {
    deps.getWsClient()?.sendAnnotationCursor(payload);
  };

  const clearAnnotations = (shareSessionId?: string): void => {
    const resolvedShareSessionId =
      shareSessionId ?? deps.getCurrentShareSessionId();
    if (!resolvedShareSessionId) {
      return;
    }

    deps.getWsClient()?.clearAnnotations({
      shareSessionId: resolvedShareSessionId,
    });
  };

  const setAnnotationAccessMode = (
    accessMode: AnnotationAccessMode,
    shareSessionId?: string,
  ): void => {
    const localParticipant = deps.getLocalParticipant();
    const resolvedShareSessionId =
      shareSessionId ?? deps.getCurrentShareSessionId();
    if (!localParticipant || !resolvedShareSessionId) {
      return;
    }

    if (localParticipant.role !== "host") {
      return;
    }

    deps.getWsClient()?.setAnnotationAccessMode({
      shareSessionId: resolvedShareSessionId,
      accessMode,
    });
  };

  return {
    canDrawAnnotations,
    clearAnnotations,
    endAnnotationSession,
    requestAnnotationSync,
    sendAnnotationCursor,
    sendAnnotationUpdate,
    setAnnotationAccessMode,
    startAnnotationSession,
  };
};
