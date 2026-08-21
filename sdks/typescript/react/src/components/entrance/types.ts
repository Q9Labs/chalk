export type EntranceDevice = {
  readonly deviceId: string;
  readonly label: string;
};

/**
 * Device data and callbacks supplied by the host client. The names match the
 * media slice so Chalk can pass its device snapshot without an adapter object.
 */
export type EntranceDeviceOptions = {
  readonly audioInputDevices?: readonly EntranceDevice[];
  readonly videoInputDevices?: readonly EntranceDevice[];
  readonly audioOutputDevices?: readonly EntranceDevice[];
  readonly selectedAudioInput?: string | null;
  readonly selectedVideoInput?: string | null;
  readonly selectedAudioOutput?: string | null;
  readonly onAudioInputChange?: (deviceId: string) => void | Promise<void>;
  readonly onVideoInputChange?: (deviceId: string) => void | Promise<void>;
  readonly onAudioOutputChange?: (deviceId: string) => void | Promise<void>;
};
