import { EntranceView } from "./EntranceView";
import { Image } from "react-native";

export type EntranceDefaults = {
  readonly microphone?: boolean;
  readonly camera?: boolean;
};

export type EntranceSettings = {
  readonly displayName: string;
  readonly microphone: boolean;
  readonly camera: boolean;
};

export type EntranceProps = {
  readonly spaceName: string;
  readonly logoUrl?: string;
  readonly defaultDisplayName?: string;
  readonly defaults?: EntranceDefaults;
  readonly error?: string;
  readonly joining?: boolean;
  readonly onCancel?: () => void;
  readonly onJoin: (settings: EntranceSettings) => void | Promise<void>;
};

/** The native implementation owns the device preview lifecycle and disposal. */
export function Entrance({ spaceName, logoUrl, defaultDisplayName, defaults, error, joining = false, onCancel, onJoin }: EntranceProps): React.JSX.Element {
  return (
    <EntranceView
      error={error}
      initialAudioEnabled={defaults?.microphone ?? true}
      initialVideoEnabled={defaults?.camera ?? true}
      joinDisabled={joining}
      logo={logoUrl ? <Image accessibilityLabel="Chalk" source={{ uri: logoUrl }} style={{ height: 32, width: 120 }} /> : undefined}
      onCancel={onCancel}
      onJoin={({ displayName, microphoneEnabled, cameraEnabled }) => void onJoin({ displayName, microphone: microphoneEnabled, camera: cameraEnabled })}
      spaceName={spaceName}
      displayName={defaultDisplayName}
    />
  );
}
