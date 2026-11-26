import type { ControlBarButtonName } from "../control-bar/ControlBar";
import type { SpaceViewFeatures } from "./SpaceView";

export interface SpaceViewControlBarButtonsOptions {
  readonly features?: SpaceViewFeatures;
  readonly canPublishScreen: boolean;
  readonly presentingAvailable: boolean;
  readonly canManageRecording: boolean;
  readonly canSendReaction: boolean;
  readonly canDrawWhiteboard: boolean;
}

function featureEnabled(features: SpaceViewFeatures | undefined, name: keyof SpaceViewFeatures): boolean {
  return features?.[name] !== false;
}

function mediaButtons({ features, canPublishScreen, presentingAvailable, canManageRecording }: SpaceViewControlBarButtonsOptions): ControlBarButtonName[] {
  return [...(featureEnabled(features, "screenShare") && canPublishScreen ? ["screenshare" as const] : []), ...(canPublishScreen && presentingAvailable ? ["presenting" as const] : []), ...(featureEnabled(features, "recording") && canManageRecording ? ["record" as const] : [])];
}

function panelAndCollaborationButtons({ features, canSendReaction, canDrawWhiteboard }: SpaceViewControlBarButtonsOptions): ControlBarButtonName[] {
  return [
    ...(featureEnabled(features, "participants") ? ["participants" as const] : []),
    ...(featureEnabled(features, "chat") ? ["chat" as const] : []),
    ...(featureEnabled(features, "handRaise") ? ["handraise" as const] : []),
    ...(featureEnabled(features, "reactions") && canSendReaction ? ["reactions" as const] : []),
    ...(featureEnabled(features, "whiteboard") && canDrawWhiteboard ? ["whiteboard" as const] : []),
  ];
}

export function spaceViewControlBarButtons(options: SpaceViewControlBarButtonsOptions): ControlBarButtonName[] {
  return ["mic", "video", ...mediaButtons(options), ...panelAndCollaborationButtons(options), "leave"];
}
