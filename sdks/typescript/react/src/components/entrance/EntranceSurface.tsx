"use client";
import type React from "react";

import { type ChalkTheme } from "../../theme";
import { ClassicEntranceSurface } from "./ClassicEntranceSurface";
import type { EntranceDeviceOptions } from "./types";

/**
 * Internal presentational surface shared by production Entrance and the
 * permission-free SDK preview fixture. It deliberately owns no media access.
 */
export type EntranceSurfaceProps = EntranceDeviceOptions & {
  readonly spaceName: string;
  readonly logoUrl?: string;
  readonly displayName: string;
  readonly microphone: boolean;
  readonly camera: boolean;
  readonly joining: boolean;
  readonly error?: string;
  readonly theme?: ChalkTheme;
  readonly previewError?: string | null;
  readonly previewStream?: MediaStream | null;
  readonly generatedAvatars?: boolean;
  readonly onDisplayNameChange: (displayName: string) => void;
  readonly onMicrophoneChange: (enabled: boolean) => void;
  readonly onCameraChange: (enabled: boolean) => void;
  readonly onSubmit: () => void;
  readonly onCancel?: () => void;
};

export function EntranceSurface(props: EntranceSurfaceProps): React.JSX.Element {
  return <>{<ClassicEntranceSurface {...props} />}</>;
}
