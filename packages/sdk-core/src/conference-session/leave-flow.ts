import type RealtimeKitClient from "@cloudflare/realtimekit";
import { wideEvents } from "../wide-events/index.ts";
import type { WSClient } from "../ws-client.ts";

interface LeaveFlowState {
  isLeaving: boolean;
  leavePromise: Promise<void> | null;
}

interface LeaveFlowDeps {
  roomId: string;
  state: LeaveFlowState;
  getWsClient: () => WSClient | undefined;
  getRtkClient: () => RealtimeKitClient | undefined;
  clearRuntimeState: () => void;
  setDisconnected: () => void;
}

export const createConferenceSessionLeaveFlow = (deps: LeaveFlowDeps) => {
  const leave = async (): Promise<void> => {
    if (deps.state.isLeaving && deps.state.leavePromise) {
      return deps.state.leavePromise;
    }

    deps.state.isLeaving = true;

    const ctx = wideEvents.start("room.leave");
    ctx.set("roomId", deps.roomId);

    deps.state.leavePromise = (async () => {
      try {
        const wsClient = deps.getWsClient();
        if (wsClient) {
          wsClient.disconnect();
        }

        const rtkClient = deps.getRtkClient();
        if (rtkClient) {
          try {
            await rtkClient.leave();
          } catch {
            // best effort cleanup
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 100));

        deps.clearRuntimeState();
        deps.setDisconnected();

        ctx.complete("success");
      } finally {
        deps.state.isLeaving = false;
        deps.state.leavePromise = null;
      }
    })();

    return deps.state.leavePromise;
  };

  return { leave };
};
