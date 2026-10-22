export interface WhiteboardAssetPaths {
  excalidrawCssPath: string;
  mathJaxBasePath: string;
}

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

let selfHostedAssets: WhiteboardAssetPaths | undefined;

/** Configure from a bootstrap module imported before the SDK. Hosts serve these files. */
export function configureWhiteboardAssets(paths: WhiteboardAssetPaths): void {
  selfHostedAssets = paths;
  if (typeof window !== "undefined") {
    window.EXCALIDRAW_ASSET_PATH = new URL(".", new URL(paths.excalidrawCssPath, window.location.href)).href;
  }
}

export function getWhiteboardAssets(): WhiteboardAssetPaths | undefined {
  return selfHostedAssets;
}
