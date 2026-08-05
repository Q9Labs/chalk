import type { AndroidConnectionServiceCall, AndroidConnectionServiceDisconnectReason } from "../android/connection-service";
import type { SpaceLifecyclePhase } from "./space-lifecycle";

export interface AndroidConnectionServiceControllerInput {
  readonly displayName: string;
  readonly enabled: boolean;
  readonly hasVideo: boolean;
  readonly joinNonce: number;
  readonly onDisconnectRequest: () => void;
  readonly phase: SpaceLifecyclePhase;
  readonly spaceId: string;
  readonly spaceName: string;
}

export interface AndroidConnectionServiceControllerDependencies {
  readonly addListener: (listener: (event: { type: "disconnect"; callId: string; reason: AndroidConnectionServiceDisconnectReason }) => void) => () => void;
  readonly endCall: (callId: string, options: { reason: AndroidConnectionServiceDisconnectReason }) => Promise<boolean>;
  readonly ensureRegistered: () => Promise<boolean>;
  readonly setActive: (callId: string) => Promise<boolean>;
  readonly startCall: (call: AndroidConnectionServiceCall) => Promise<boolean>;
}

export class AndroidConnectionServiceController {
  #dependencies: AndroidConnectionServiceControllerDependencies;
  #input: AndroidConnectionServiceControllerInput;
  #listeners = new Set<() => void>();
  #resourcesEnabled = false;
  #currentCallId: string | null = null;
  #currentJoinNonce: number | null = null;
  #activatedCallId: string | null = null;
  #removeListener: (() => void) | undefined;
  #syncScheduled = false;

  constructor(input: AndroidConnectionServiceControllerInput, dependencies: AndroidConnectionServiceControllerDependencies) {
    this.#input = input;
    this.#dependencies = dependencies;
  }

  readonly getSnapshot = (): null => null;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.#sync();
    }

    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#stop();
      }
    };
  };

  readonly update = (input: AndroidConnectionServiceControllerInput): void => {
    this.#input = input;
    if (this.#listeners.size === 0) return;
    this.#scheduleSync();
  };

  #scheduleSync(): void {
    if (this.#syncScheduled) return;
    this.#syncScheduled = true;
    queueMicrotask(() => {
      this.#syncScheduled = false;
      if (this.#listeners.size === 0) return;
      this.#sync();
    });
  }

  #sync(): void {
    const input = this.#input;
    if (!input.enabled) {
      this.#stop();
      return;
    }

    this.#startResources();

    if (input.phase === "joining" && this.#currentJoinNonce !== input.joinNonce) {
      const callId = `${input.spaceId}:${input.joinNonce}`;
      this.#currentJoinNonce = input.joinNonce;
      this.#currentCallId = callId;
      this.#activatedCallId = null;
      void this.#dependencies.startCall({
        callId,
        displayName: input.displayName,
        hasVideo: input.hasVideo,
        spaceId: input.spaceId,
        spaceName: input.spaceName,
      });
    }

    if (input.phase === "live") {
      const callId = this.#currentCallId;
      if (callId && this.#activatedCallId !== callId) {
        this.#activatedCallId = callId;
        void this.#dependencies.setActive(callId);
      }
    }

    if (input.phase !== "entrance" && input.phase !== "left") return;
    const callId = this.#currentCallId;
    if (!callId) return;

    this.#currentCallId = null;
    this.#activatedCallId = null;
    void this.#dependencies.endCall(callId, { reason: input.phase === "entrance" ? "canceled" : "local" });
  }

  #startResources(): void {
    if (this.#resourcesEnabled) return;
    this.#resourcesEnabled = true;
    void this.#dependencies.ensureRegistered();
    this.#removeListener = this.#dependencies.addListener((event) => {
      if (event.type !== "disconnect" || event.callId !== this.#currentCallId) return;
      this.#input.onDisconnectRequest();
    });
  }

  #stop(): void {
    this.#removeListener?.();
    this.#removeListener = undefined;
    const callId = this.#currentCallId;
    this.#currentCallId = null;
    this.#activatedCallId = null;
    this.#resourcesEnabled = false;

    if (!callId) return;
    void this.#dependencies.endCall(callId, { reason: "local" });
  }
}
