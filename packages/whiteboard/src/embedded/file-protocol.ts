export interface RendererFileWrite {
  readonly requestId: string;
  readonly sceneId: string;
  readonly sceneGeneration: string;
  readonly fileId: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly dataURL: string;
}
