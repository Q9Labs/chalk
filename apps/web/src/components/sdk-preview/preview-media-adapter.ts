import { createPreviewAudioTrack, type PreviewAudioTrack } from "./preview-audio-track";
import { createPreviewCameraTrack, type PreviewCameraTrack } from "./preview-camera-track";
import { createPreviewScreenTrack, type PreviewScreenTrack } from "./preview-screen-track";
import { PREVIEW_DEVICE_FIXTURES, createPreviewMediaDevices, type PreviewMediaDevices } from "../../../../../sdks/typescript/react/src/test-support/preview-devices";

export { PREVIEW_DEVICE_FIXTURES, createPreviewMediaDevices } from "../../../../../sdks/typescript/react/src/test-support/preview-devices";
export type { PreviewMediaDevices } from "../../../../../sdks/typescript/react/src/test-support/preview-devices";

export type PreviewMediaKind = "microphone" | "camera" | "screen";

export type PreviewTrackHandle = PreviewAudioTrack | PreviewCameraTrack | PreviewScreenTrack;

export type PreviewTrackSelection = Readonly<Partial<Record<PreviewMediaKind, boolean>>>;

export type PreviewTrackSet = Readonly<Record<PreviewMediaKind, PreviewTrackHandle | null>>;

export type PreviewTrackBundle = {
  readonly devices: PreviewMediaDevices;
  readonly local: PreviewTrackSet;
  readonly remote: ReadonlyMap<string, PreviewTrackSet>;
  stop(): void;
};

export type PreviewTrackBundleOptions = {
  readonly local?: PreviewTrackSelection;
  readonly remote?: Readonly<Record<string, PreviewTrackSelection>>;
  readonly remoteParticipantIds?: readonly string[];
};

export type PreviewMediaAdapter = {
  readonly devices: PreviewMediaDevices;
  readonly createAudioTrack: (id?: string) => PreviewAudioTrack;
  readonly createCameraTrack: (options?: Parameters<typeof createPreviewCameraTrack>[0]) => PreviewCameraTrack;
  readonly createScreenTrack: (id?: string) => PreviewScreenTrack;
  readonly createTrackBundle: (options?: PreviewTrackBundleOptions) => PreviewTrackBundle;
  readonly dispose: () => void;
};

export const PREVIEW_MEDIA_DEVICES = PREVIEW_DEVICE_FIXTURES;

export const createPreviewDevices = createPreviewMediaDevices;

export function createPreviewMediaAdapter(): PreviewMediaAdapter {
  const active = new Set<PreviewTrackHandle>();

  const own = <Track extends PreviewTrackHandle>(handle: Track): Track => {
    active.add(handle);
    const stop = handle.stop.bind(handle);
    let stopped = false;
    handle.stop = () => {
      if (stopped) return;
      stopped = true;
      active.delete(handle);
      stop();
    };
    return handle;
  };

  const createAudio = (id?: string): PreviewAudioTrack => own(createPreviewAudioTrack(id));
  const createCamera = (options?: Parameters<typeof createPreviewCameraTrack>[0]): PreviewCameraTrack => own(createPreviewCameraTrack(options));
  const createScreen = (id?: string): PreviewScreenTrack => own(createPreviewScreenTrack(id));

  const createTrackBundle = ({ local = {}, remote = {}, remoteParticipantIds = [] }: PreviewTrackBundleOptions = {}): PreviewTrackBundle => {
    const handles: PreviewTrackHandle[] = [];
    const createSet = (selection: PreviewTrackSelection, idPrefix: string, displayName?: string): PreviewTrackSet => {
      const microphone = selection.microphone ? createAudio(`${idPrefix}-microphone`) : null;
      const camera = selection.camera ? createCamera({ id: `${idPrefix}-camera`, displayName }) : null;
      const screen = selection.screen ? createScreen(`${idPrefix}-screen`) : null;
      for (const handle of [microphone, camera, screen]) {
        if (handle) handles.push(handle);
      }
      return { microphone, camera, screen };
    };

    const localTracks = createSet(local, "preview-local", "You");
    const remoteTracks = new Map<string, PreviewTrackSet>();
    const remoteEntries = new Map<string, PreviewTrackSelection>();
    for (const participantId of remoteParticipantIds) remoteEntries.set(participantId, {});
    for (const [participantId, selection] of Object.entries(remote)) remoteEntries.set(participantId, selection);
    for (const [participantId, selection] of remoteEntries) {
      remoteTracks.set(participantId, createSet(selection, `preview-${participantId}`, participantId));
    }

    let stopped = false;
    return {
      devices: createPreviewMediaDevices(),
      local: localTracks,
      remote: remoteTracks,
      stop: () => {
        if (stopped) return;
        stopped = true;
        for (const handle of handles) handle.stop();
      },
    };
  };

  return {
    devices: createPreviewMediaDevices(),
    createAudioTrack: createAudio,
    createCameraTrack: createCamera,
    createScreenTrack: createScreen,
    createTrackBundle,
    dispose: () => {
      for (const handle of [...active]) handle.stop();
      active.clear();
    },
  };
}

/** Convenience boundary for callers that need one disposable set of fixtures. */
export function createPreviewTrackBundle(options: PreviewTrackBundleOptions = {}): PreviewTrackBundle {
  const adapter = createPreviewMediaAdapter();
  const bundle = adapter.createTrackBundle(options);
  const stop = bundle.stop;
  let stopped = false;
  return {
    ...bundle,
    stop: () => {
      if (stopped) return;
      stopped = true;
      stop();
      adapter.dispose();
    },
  };
}
