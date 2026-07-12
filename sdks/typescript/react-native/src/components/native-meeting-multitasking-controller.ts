export type NativeMeetingMultitaskingPlatform = "android" | "ios";

export interface NativeMeetingMultitaskingConfig {
  readonly roomName: string;
  readonly participantName: string;
  readonly streamURL: string | null;
  readonly muted: boolean;
  readonly cameraOff: boolean;
}

export interface NativeMeetingMultitaskingModule {
  readonly setPictureInPictureEnabled: (enabled: boolean) => Promise<void>;
  readonly updatePictureInPictureConfig: (config: NativeMeetingMultitaskingConfig) => Promise<void>;
  readonly startPictureInPicture: () => Promise<void>;
  readonly stopPictureInPicture: () => Promise<void>;
  readonly startBackgroundMode?: (config: NativeMeetingMultitaskingConfig) => Promise<void>;
  readonly stopBackgroundMode?: () => Promise<void>;
}

export interface NativeMeetingMultitaskingAppState {
  readonly currentState: string;
  readonly addEventListener: (listener: (nextState: string) => void) => { remove: () => void };
}

export interface NativeMeetingMultitaskingControllerOptions {
  readonly platform: NativeMeetingMultitaskingPlatform;
  readonly appState: NativeMeetingMultitaskingAppState;
  readonly module: NativeMeetingMultitaskingModule;
  readonly reportFailure: (action: string, cause: unknown) => void;
}

export class NativeMeetingMultitaskingController {
  #platform: NativeMeetingMultitaskingPlatform;
  #appState: NativeMeetingMultitaskingAppState;
  #module: NativeMeetingMultitaskingModule;
  #reportFailure: (action: string, cause: unknown) => void;
  #config: NativeMeetingMultitaskingConfig | undefined;
  #appStateSubscription: { remove: () => void } | undefined;
  #listeners = new Set<() => void>();
  #disposeGeneration = 0;
  #appStateValue: string;

  constructor({ platform, appState, module, reportFailure }: NativeMeetingMultitaskingControllerOptions) {
    this.#platform = platform;
    this.#appState = appState;
    this.#module = module;
    this.#reportFailure = reportFailure;
    this.#appStateValue = appState.currentState;
  }

  readonly getSnapshot = (): null => null;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    this.#disposeGeneration += 1;
    const generation = this.#disposeGeneration;

    if (this.#listeners.size === 1) {
      this.#start();
    }

    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size > 0) return;

      queueMicrotask(() => {
        if (generation !== this.#disposeGeneration || this.#listeners.size > 0) return;
        this.#disposeGeneration += 1;
        this.#stop();
      });
    };
  };

  readonly update = (config: NativeMeetingMultitaskingConfig): void => {
    if (this.#config === config) return;
    this.#config = config;
    if (this.#listeners.size === 0) return;

    this.#updateConfig(config);
  };

  #start(): void {
    void this.#module.setPictureInPictureEnabled(true).catch((cause) => {
      this.#reportFailure("enable PiP", cause);
    });

    const config = this.#config;
    if (config) {
      this.#updateConfig(config);
    }

    this.#appStateSubscription = this.#appState.addEventListener((nextState) => {
      const previousState = this.#appStateValue;
      this.#appStateValue = nextState;

      if (previousState === "active" && nextState !== "active") {
        void this.#module.startPictureInPicture().catch((cause) => {
          this.#reportFailure("start PiP on background", cause);
        });
      }
    });
  }

  #updateConfig(config: NativeMeetingMultitaskingConfig): void {
    void this.#module.updatePictureInPictureConfig(config).catch((cause) => {
      this.#reportFailure("update PiP config", cause);
    });

    if (this.#platform !== "android" || !this.#module.startBackgroundMode) return;

    void this.#module.startBackgroundMode(config).catch((cause) => {
      this.#reportFailure("start background mode", cause);
    });
  }

  #stop(): void {
    this.#appStateSubscription?.remove();
    this.#appStateSubscription = undefined;

    void this.#module.setPictureInPictureEnabled(false).catch((cause) => {
      this.#reportFailure("disable PiP", cause);
    });
    void this.#module.stopPictureInPicture().catch(() => {});

    if (this.#platform === "android" && this.#module.stopBackgroundMode) {
      void this.#module.stopBackgroundMode().catch(() => {});
    }
  }
}
