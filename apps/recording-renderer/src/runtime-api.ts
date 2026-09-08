export interface RecordingRendererRuntime {
  readonly ready: true;
  renderFrame(elapsedMs: number, token: string): Promise<void>;
}

declare global {
  interface Window {
    chalkRecordingRenderer: RecordingRendererRuntime;
  }
}
