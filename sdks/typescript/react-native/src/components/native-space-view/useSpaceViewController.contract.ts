import type { Reaction } from "@q9labsai/chalk-client";
import type { Dispatch, SetStateAction } from "react";

import type { SpacePanelName } from "./types";
import type { useSpaceViewController } from "./useSpaceViewController";

type ExpectedSpaceViewController = {
  readonly simulatorMediaDisabled: boolean;
  readonly spaceName: string;
  readonly panel: SpacePanelName | null;
  readonly isMuted: boolean;
  readonly isCameraOff: boolean;
  readonly participantCount: number;
  readonly canChat: boolean;
  readonly canParticipants: boolean;
  readonly canScreenShare: boolean;
  readonly canReactions: boolean;
  readonly canHandRaise: boolean;
  readonly canWhiteboard: boolean;
  readonly chat: { readonly unreadCount: number; readonly messages: readonly unknown[] };
  readonly participants: { readonly participants: readonly unknown[]; readonly localParticipant: unknown };
  readonly layout: { readonly layout: "grid" | "focus" | "presentation"; readonly setLayout: (layout: "grid" | "focus" | "presentation") => void };
  readonly setActionsOpen: Dispatch<SetStateAction<boolean>>;
  readonly setReactionPickerOpen: Dispatch<SetStateAction<boolean>>;
  readonly setChatDraft: Dispatch<SetStateAction<string>>;
  readonly sendReaction: (reaction: Reaction) => void;
  readonly sendChatMessage: () => void;
  readonly handleLeave: () => void;
};

type Assert<T extends true> = T;
type IsAssignable<Current, Expected> = Current extends Expected ? true : false;

export type SpaceViewControllerContractCheck = Assert<IsAssignable<ReturnType<typeof useSpaceViewController>, ExpectedSpaceViewController>>;
