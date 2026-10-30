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
    window.EXCALIDRAW_ASSET_PATH = resolveExcalidrawAssetPath(paths.excalidrawCssPath);
  }
}

export function getWhiteboardAssets(): WhiteboardAssetPaths | undefined {
  return selfHostedAssets;
}

export function resolveExcalidrawAssetPath(cssPath: string): string {
  return new URL(".", new URL(cssPath, document.baseURI)).href;
}
