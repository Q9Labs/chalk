import type { RtkSignalingDeps } from "./rtk-signaling-deps.ts";
import {
  setupRtkParticipantDebugHooks,
  setupRtkParticipantSync,
} from "./rtk-participants.ts";
import { setupRtkChatListener } from "./rtk-chat.ts";
import { setupRtkTranscriptListener } from "./rtk-transcripts.ts";

export const setupConferenceSessionRtkSignaling = (deps: RtkSignalingDeps): void => {
  const rtkClient = deps.getRtkClient();
  if (!rtkClient) {
    return;
  }
  setupRtkParticipantDebugHooks(deps);
  setupRtkParticipantSync(deps);
  setupRtkChatListener(deps);
  setupRtkTranscriptListener(deps);
};
