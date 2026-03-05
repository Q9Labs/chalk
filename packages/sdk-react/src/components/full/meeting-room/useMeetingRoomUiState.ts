import { useCallback, useState } from "react";

import type { MeetingLayout, MeetingPanel } from "./types";

interface UseMeetingRoomUiStateOptions {
  defaultChatOpen: boolean;
  defaultParticipantsOpen: boolean;
  defaultTranscriptionOpen: boolean;
  defaultLayout: MeetingLayout;
  showInviteToastOnJoin: boolean;
  onChatOpen?: () => void;
}

function resolveDefaultPanel({ defaultChatOpen, defaultParticipantsOpen, defaultTranscriptionOpen }: Pick<UseMeetingRoomUiStateOptions, "defaultChatOpen" | "defaultParticipantsOpen" | "defaultTranscriptionOpen">): MeetingPanel | null {
  if (defaultChatOpen) return "chat";
  if (defaultParticipantsOpen) return "participants";
  if (defaultTranscriptionOpen) return "transcription";
  return null;
}

export function useMeetingRoomUiState({ defaultChatOpen, defaultParticipantsOpen, defaultTranscriptionOpen, defaultLayout, showInviteToastOnJoin, onChatOpen }: UseMeetingRoomUiStateOptions) {
  const [activePanel, setActivePanel] = useState<MeetingPanel | null>(() =>
    resolveDefaultPanel({
      defaultChatOpen,
      defaultParticipantsOpen,
      defaultTranscriptionOpen,
    }),
  );
  const [layout, setLayout] = useState<MeetingLayout>(defaultLayout);
  const [isFilmstripOpen, setIsFilmstripOpen] = useState(true);
  const [isReactionPickerOpen, setIsReactionPickerOpen] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showInviteToast, setShowInviteToast] = useState(showInviteToastOnJoin);
  const [showTour, setShowTour] = useState(false);
  const [isMobileSheetOpen, setIsMobileSheetOpen] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  const togglePanel = useCallback(
    (panel: MeetingPanel) => {
      setActivePanel((current) => {
        const nextPanel = current === panel ? null : panel;
        if (nextPanel === "chat") {
          onChatOpen?.();
        }
        return nextPanel;
      });
    },
    [onChatOpen],
  );

  return {
    activePanel,
    setActivePanel,
    layout,
    setLayout,
    isFilmstripOpen,
    setIsFilmstripOpen,
    isReactionPickerOpen,
    setIsReactionPickerOpen,
    showInviteModal,
    setShowInviteModal,
    showInviteToast,
    setShowInviteToast,
    showTour,
    setShowTour,
    isMobileSheetOpen,
    setIsMobileSheetOpen,
    isExiting,
    setIsExiting,
    togglePanel,
  };
}
