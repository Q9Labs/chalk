export interface RecordingRendererFrameProfile {
  readonly elapsedMs: number;
  readonly token: string;
  readonly sharedContentKind: "none" | "screen_share" | "whiteboard";
  readonly videoCount: number;
  readonly videoSeekCount: number;
  readonly whiteboardAssetPreparationWallMs: number;
  readonly reactCommitWallMs: number;
  readonly sourceSettlingWallMs: number;
  readonly sourceMetadataWaitSumMs: number;
  readonly sourceMetadataWaitMaxMs: number;
  readonly sourceSeekWaitSumMs: number;
  readonly sourceSeekWaitMaxMs: number;
  readonly sourceCurrentDataWaitSumMs: number;
  readonly sourceCurrentDataWaitMaxMs: number;
  readonly firstImageSettlingWallMs: number;
  readonly firstFontsReadyWallMs: number;
  readonly postSourceSettlementWallMs: number;
  readonly secondImageSettlingWallMs: number;
  readonly whiteboardPresentationWaitWallMs: number;
  readonly deliberateAnimationFrameWaitWallMs: number;
  readonly finalFontsReadyWallMs: number;
  readonly renderAcknowledgementWallMs: number;
  readonly frameWallMs: number;
}

export interface RecordingRendererRuntime {
  readonly ready: true;
  renderFrame(elapsedMs: number, token: string): Promise<void>;
  readLastFrameProfile(): RecordingRendererFrameProfile | undefined;
}

declare global {
  interface Window {
    chalkRecordingRenderer: RecordingRendererRuntime;
  }
}
