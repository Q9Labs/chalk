import { callKit as defaultCallKit, type CallKitEndCallOptions, type CallKitEvent, type CallKitCallOptions } from "../callkit/callkit";
import { resolveVideoConferenceCallKitOptions, type VideoConferenceCallKitOptions, type ResolvedVideoConferenceCallKitOptions } from "../callkit/resolve-video-conference-callkit-options";
import type { VideoConferencePhase } from "./VideoConference";

export interface VideoConferenceCallKitPort {
  readonly isSupported: boolean;
  addListener(listener: (event: CallKitEvent) => void): { remove(): void };
  configure(options: ResolvedVideoConferenceCallKitOptions): Promise<{ isSupported: boolean }>;
  endCall(options: CallKitEndCallOptions): Promise<void>;
  reportConnected(options: Pick<CallKitCallOptions, "callUUID">): Promise<void>;
  startCall(options: CallKitCallOptions): Promise<{ callUUID: string } | null>;
}

export interface VideoConferenceCallKitSyncInput {
  readonly callKit?: VideoConferenceCallKitOptions | boolean;
  readonly hasVideo: boolean;
  readonly isAudioEnabled: boolean;
  readonly joinNonce: number;
  readonly onEndCall: (options?: { closeAfterLeave?: boolean }) => void;
  readonly onToggleAudio: () => Promise<boolean>;
  readonly phase: VideoConferencePhase;
  readonly roomId: string;
  readonly roomName?: string;
}

export class VideoConferenceCallKitController {
  readonly #port: VideoConferenceCallKitPort;
  #input: VideoConferenceCallKitSyncInput | undefined;
  #subscription: { remove(): void } | undefined;
  #activeCallId: string | null = null;
  #reportedConnectedCallId: string | null = null;
  #startedJoinNonce: number | null = null;
  #lastConfigurationSignature: string | null = null;

  constructor(port: VideoConferenceCallKitPort = defaultCallKit) {
    this.#port = port;
  }

  readonly start = (): void => {
    if (!this.#port.isSupported || this.#subscription) return;

    this.#subscription = this.#port.addListener((event) => {
      const input = this.#input;
      if (!input || !this.#callKitOptions(input)) return;

      if (event.type === "endCallAction") {
        input.onEndCall({ closeAfterLeave: input.phase !== "meeting" });
        return;
      }

      if (event.type === "setMutedCallAction" && event.muted === input.isAudioEnabled) {
        void input.onToggleAudio().catch((error: unknown) => {
          console.warn("Failed to sync CallKit mute state", error);
        });
      }
    });
  };

  readonly sync = (input: VideoConferenceCallKitSyncInput): void => {
    this.#input = input;
    const callKitOptions = this.#callKitOptions(input);
    if (!callKitOptions || !this.#port.isSupported) {
      this.#lastConfigurationSignature = null;
      if (input.phase === "lobby" || input.phase === "end") void this.endCall();
      return;
    }

    const configurationSignature = JSON.stringify(callKitOptions);
    if (configurationSignature !== this.#lastConfigurationSignature) {
      this.#lastConfigurationSignature = configurationSignature;
      void this.#port.configure(callKitOptions).catch((error: unknown) => {
        console.warn("Failed to configure CallKit", error);
      });
    }

    if (input.phase === "joining" && this.#startedJoinNonce !== input.joinNonce) {
      this.#startedJoinNonce = input.joinNonce;
      const joinNonce = input.joinNonce;
      void this.#port
        .startCall(callKitOptions)
        .then((result) => {
          if (this.#input?.phase !== "joining" || this.#input.joinNonce !== joinNonce || !result?.callUUID) return;
          this.#activeCallId = result.callUUID;
          this.#reportedConnectedCallId = null;
        })
        .catch((error: unknown) => {
          console.warn("Failed to start CallKit call", error);
        });
    }

    if (input.phase === "meeting" && this.#activeCallId && this.#reportedConnectedCallId !== this.#activeCallId) {
      const callUUID = this.#activeCallId;
      this.#reportedConnectedCallId = callUUID;
      void this.#port.reportConnected({ callUUID }).catch((error: unknown) => {
        console.warn("Failed to report CallKit connection", error);
      });
    }

    if (input.phase === "lobby" || input.phase === "end") void this.endCall();
  };

  readonly endCall = async (): Promise<void> => {
    if (!this.#activeCallId) return;

    const callUUID = this.#activeCallId;
    this.#activeCallId = null;
    this.#reportedConnectedCallId = null;
    try {
      await this.#port.endCall({ callUUID });
    } catch (error: unknown) {
      console.warn("Failed to end CallKit call", error);
    }
  };

  readonly stop = (): void => {
    this.#subscription?.remove();
    this.#subscription = undefined;
    this.#lastConfigurationSignature = null;
    this.#startedJoinNonce = null;
    void this.endCall();
  };

  #callKitOptions(input: VideoConferenceCallKitSyncInput): ResolvedVideoConferenceCallKitOptions | null {
    return resolveVideoConferenceCallKitOptions({
      callKit: input.callKit,
      hasVideo: input.hasVideo,
      roomId: input.roomId,
      roomName: input.roomName || input.roomId,
    });
  }
}
