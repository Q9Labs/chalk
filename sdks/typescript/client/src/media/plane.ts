export type MediaSource = "microphone" | "camera" | "screen";

export type MediaPublication = {
  readonly participantId: string;
  readonly source: MediaSource;
  readonly enabled: boolean;
  readonly publicationId: string | null;
};

export type MediaPlaneOutcome = "confirmed" | "satisfied" | "retryable_failure" | "terminal_failure" | "ambiguous";

export type MediaPlaneTarget = {
  readonly operationId: string;
  readonly participantId: string;
  readonly source: MediaSource;
  readonly enabled: boolean;
};

export type MediaPlaneResult = {
  readonly outcome: MediaPlaneOutcome;
  readonly errorCode: string | null;
};

export type ClientMediaPlane = {
  readonly setLocalPublicationTarget: (target: MediaPlaneTarget) => Promise<MediaPlaneResult>;
  readonly observeLocalPublications: (listener: (publications: readonly MediaPublication[]) => void) => () => void;
  readonly observeRemotePublications: (listener: (publications: readonly MediaPublication[]) => void) => () => void;
};
