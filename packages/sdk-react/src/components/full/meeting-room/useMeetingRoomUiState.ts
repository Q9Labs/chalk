import { useCallback, useEffect, useState } from "react";

import type { MeetingLayout, MeetingPanel } from "./types";

interface UseMeetingRoomUiStateOptions {
  defaultChatOpen: boolean;
  defaultParticipantsOpen: boolean;
  defaultTranscriptionOpen: boolean;
  defaultLayout: MeetingLayout;
  defaultFilmstripOpen?: boolean;
  showInviteToastOnJoin: boolean;
  onChatOpen?: () => void;
}

function resolveDefaultPanel({ defaultChatOpen, defaultParticipantsOpen, defaultTranscriptionOpen }: Pick<UseMeetingRoomUiStateOptions, "defaultChatOpen" | "defaultParticipantsOpen" | "defaultTranscriptionOpen">): MeetingPanel | null {
  if (defaultChatOpen) return "chat";
  if (defaultParticipantsOpen) return "participants";
  if (defaultTranscriptionOpen) return "transcription";
  return null;
}

export function useMeetingRoomUiState({ defaultChatOpen, defaultParticipantsOpen, defaultTranscriptionOpen, defaultLayout, defaultFilmstripOpen = true, showInviteToastOnJoin, onChatOpen }: UseMeetingRoomUiStateOptions) {
  const [activePanel, setActivePanel] = useState<MeetingPanel | null>(() =>
    resolveDefaultPanel({
      defaultChatOpen,
      defaultParticipantsOpen,
      defaultTranscriptionOpen,
    }),
  );
  const [layout, setLayout] = useState<MeetingLayout>(defaultLayout);
  const [isFilmstripOpen, setIsFilmstripOpen] = useState(defaultFilmstripOpen);
  const [isReactionPickerOpen, setIsReactionPickerOpen] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showInviteToast, setShowInviteToast] = useState(showInviteToastOnJoin);
  const [showTour, setShowTour] = useState(false);
  const [isMobileSheetOpen, setIsMobileSheetOpen] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  useEffect(() => {
    if (activePanel === "chat") {
      onChatOpen?.();
    }
  }, [activePanel, onChatOpen]);

  const togglePanel = useCallback((panel: MeetingPanel) => {
    setActivePanel((current) => (current === panel ? null : panel));
  }, []);

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
    isSettingsOpen,
    setIsSettingsOpen,
  };
}
