import { nativeCallKit as defaultNativeCallKit, type NativeCallKitEndCallOptions, type NativeCallKitEvent, type NativeCallKitCallOptions } from "../callkit/native-callkit";
import { resolveNativeVideoConferenceCallKitOptions, type NativeVideoConferenceCallKitOptions, type ResolvedNativeVideoConferenceCallKitOptions } from "../callkit/resolve-native-video-conference-callkit-options";
import type { NativeVideoConferencePhase } from "./NativeVideoConference";

export interface NativeVideoConferenceCallKitPort {
  readonly isSupported: boolean;
  addListener(listener: (event: NativeCallKitEvent) => void): { remove(): void };
  configure(options: ResolvedNativeVideoConferenceCallKitOptions): Promise<{ isSupported: boolean }>;
  endCall(options: NativeCallKitEndCallOptions): Promise<void>;
  reportConnected(options: Pick<NativeCallKitCallOptions, "callUUID">): Promise<void>;
  startCall(options: NativeCallKitCallOptions): Promise<{ callUUID: string } | null>;
}

export interface NativeVideoConferenceCallKitSyncInput {
  readonly callKit?: NativeVideoConferenceCallKitOptions | boolean;
  readonly hasVideo: boolean;
  readonly isAudioEnabled: boolean;
  readonly joinNonce: number;
  readonly onEndCall: (options?: { closeAfterLeave?: boolean }) => void;
  readonly onToggleAudio: () => Promise<boolean>;
  readonly phase: NativeVideoConferencePhase;
  readonly roomId: string;
  readonly roomName?: string;
}

export class NativeVideoConferenceCallKitController {
  readonly #port: NativeVideoConferenceCallKitPort;
  #input: NativeVideoConferenceCallKitSyncInput | undefined;
  #subscription: { remove(): void } | undefined;
  #activeCallId: string | null = null;
  #reportedConnectedCallId: string | null = null;
  #startedJoinNonce: number | null = null;
  #lastConfigurationSignature: string | null = null;

  constructor(port: NativeVideoConferenceCallKitPort = defaultNativeCallKit) {
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

  readonly sync = (input: NativeVideoConferenceCallKitSyncInput): void => {
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

  #callKitOptions(input: NativeVideoConferenceCallKitSyncInput): ResolvedNativeVideoConferenceCallKitOptions | null {
    return resolveNativeVideoConferenceCallKitOptions({
      callKit: input.callKit,
      hasVideo: input.hasVideo,
      roomId: input.roomId,
      roomName: input.roomName || input.roomId,
    });
  }
}
