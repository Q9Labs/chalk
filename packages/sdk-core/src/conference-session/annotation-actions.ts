import type {
  AnnotationAccessMode,
  ScreenAnnotationItem,
  ScreenAnnotationTool,
} from "../types/entities/annotations.ts";
import type { Participant } from "../types.ts";
import { wideEvents } from "../wide-events/index.ts";
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
  const logAnnotationEvent = (
    eventType: string,
    outcome: "success" | "error",
    data: Record<string, unknown>,
  ): void => {
    const ctx = wideEvents.start(eventType);
    ctx.merge(data);
    if (outcome === "success") {
      ctx.complete("success");
      return;
    }

    ctx.complete("error", {
      code: typeof data.code === "string" ? data.code : "ANNOTATION_EVENT_ERROR",
      message:
        typeof data.message === "string"
          ? data.message
          : "Screen annotation event failed",
    });
  };

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
      logAnnotationEvent("annotation.session.start", "error", {
        reason: "missing_local_participant",
        shareSessionId,
        accessMode: accessMode ?? deps.getCurrentAccessMode(),
        code: "ANNOTATION_LOCAL_PARTICIPANT_MISSING",
        message: "Cannot start screen annotations without a local participant",
      });
      return;
    }

    logAnnotationEvent("annotation.session.start", "success", {
      shareSessionId,
      sharerParticipantId: localParticipant.id,
      accessMode: accessMode ?? deps.getCurrentAccessMode(),
      wsConnected: Boolean(deps.getWsClient()),
    });
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
      logAnnotationEvent("annotation.session.end", "error", {
        reason: "missing_share_session_id",
        code: "ANNOTATION_SHARE_SESSION_MISSING",
        message: "Cannot end screen annotations without an active share session",
      });
      return;
    }

    logAnnotationEvent("annotation.session.end", "success", {
      shareSessionId: resolvedShareSessionId,
      sharerParticipantId: deps.getCurrentSharerParticipantId(),
    });
    deps.getWsClient()?.sendAnnotationSessionEnd({
      shareSessionId: resolvedShareSessionId,
    });
  };

  const requestAnnotationSync = (): void => {
    const shareSessionId = deps.getCurrentShareSessionId() ?? undefined;
    logAnnotationEvent("annotation.sync.request", "success", {
      shareSessionId: shareSessionId ?? null,
      sharerParticipantId: deps.getCurrentSharerParticipantId(),
      accessMode: deps.getCurrentAccessMode(),
      wsConnected: Boolean(deps.getWsClient()),
    });
    deps.getWsClient()?.requestAnnotationSync(shareSessionId);
  };

  const sendAnnotationUpdate = (payload: {
    shareSessionId: string;
    sharerParticipantId: string;
    syncAll: boolean;
    items: ScreenAnnotationItem[];
    seq?: number;
  }): void => {
    logAnnotationEvent("annotation.update.send", "success", {
      shareSessionId: payload.shareSessionId,
      sharerParticipantId: payload.sharerParticipantId,
      syncAll: payload.syncAll,
      itemCount: payload.items.length,
      seq: payload.seq ?? null,
    });
    deps.getWsClient()?.sendAnnotationUpdate(payload);
  };

  const sendAnnotationCursor = (payload: {
    shareSessionId: string;
    tool: ScreenAnnotationTool;
    x: number;
    y: number;
  }): void => {
    logAnnotationEvent("annotation.cursor.send", "success", {
      shareSessionId: payload.shareSessionId,
      tool: payload.tool,
      x: payload.x,
      y: payload.y,
    });
    deps.getWsClient()?.sendAnnotationCursor(payload);
  };

  const clearAnnotations = (shareSessionId?: string): void => {
    const resolvedShareSessionId =
      shareSessionId ?? deps.getCurrentShareSessionId();
    if (!resolvedShareSessionId) {
      logAnnotationEvent("annotation.clear", "error", {
        reason: "missing_share_session_id",
        code: "ANNOTATION_SHARE_SESSION_MISSING",
        message: "Cannot clear screen annotations without an active share session",
      });
      return;
    }

    logAnnotationEvent("annotation.clear", "success", {
      shareSessionId: resolvedShareSessionId,
      sharerParticipantId: deps.getCurrentSharerParticipantId(),
    });
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
      logAnnotationEvent("annotation.access.set", "error", {
        reason: !localParticipant
          ? "missing_local_participant"
          : "missing_share_session_id",
        shareSessionId: resolvedShareSessionId ?? null,
        accessMode,
        code: "ANNOTATION_ACCESS_PREREQUISITE_MISSING",
        message: "Cannot change screen annotation access without local participant and active session",
      });
      return;
    }

    if (localParticipant.role !== "host") {
      logAnnotationEvent("annotation.access.set", "error", {
        reason: "non_host_attempt",
        shareSessionId: resolvedShareSessionId,
        accessMode,
        sharerParticipantId: deps.getCurrentSharerParticipantId(),
        participantId: localParticipant.id,
        code: "ANNOTATION_ACCESS_HOST_ONLY",
        message: "Only hosts can change screen annotation access",
      });
      return;
    }

    logAnnotationEvent("annotation.access.set", "success", {
      shareSessionId: resolvedShareSessionId,
      accessMode,
      participantId: localParticipant.id,
    });
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
