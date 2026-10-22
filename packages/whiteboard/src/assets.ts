export interface WhiteboardAssetPaths {
  excalidrawCssPath: string;
  mathJaxBasePath: string;
}

let selfHostedAssets: WhiteboardAssetPaths | undefined;

/** Configure before mounting a board. Hosts serve these files using their own build pipeline. */
export function configureWhiteboardAssets(paths: WhiteboardAssetPaths): void {
  selfHostedAssets = paths;
}

export function getWhiteboardAssets(): WhiteboardAssetPaths | undefined {
  return selfHostedAssets;
}
