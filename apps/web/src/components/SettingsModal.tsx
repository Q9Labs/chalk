import { SettingsDialog, useMeetingRoomSettings } from "@q9labs/chalk-react";

import { useTheme } from "../context/theme";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { theme, setTheme } = useTheme();
  const { settings, updateIdentitySettings, updateJoinSettings, updateAudioSettings, updateVideoSettings, updateAppearanceSettings, updateExperienceSettings } = useMeetingRoomSettings({
    defaults: {
      appearance: {
        theme,
      },
    },
  });

  return (
    <SettingsDialog
      isOpen={isOpen}
      onClose={onClose}
      settings={settings}
      onUpdateIdentity={updateIdentitySettings}
      onUpdateJoin={updateJoinSettings}
      onUpdateAudio={updateAudioSettings}
      onUpdateVideo={updateVideoSettings}
      onUpdateAppearance={(updates) => {
        updateAppearanceSettings(updates);
        if (updates.theme === "light" || updates.theme === "dark") {
          setTheme(updates.theme);
        }
      }}
      onUpdateExperience={updateExperienceSettings}
      participantColorSeed={settings.identity.displayName}
      isDarkMode={theme === "dark"}
    />
  );
}
