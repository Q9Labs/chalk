/// <reference types="vite/client" />

// MDX imports
declare module "*.mdx" {
  import type { ComponentType } from "react";
  const MDXComponent: ComponentType;
  export default MDXComponent;
}

// Vite CSS URL imports
declare module "*.css?url" {
  const url: string;
  export default url;
}

// Excalidraw CSS specifically
declare module "@excalidraw/excalidraw/dist/prod/index.css?url" {
  const url: string;
  export default url;
}

// Build-time constants
declare const __COMMIT_HASH__: string;
declare const __BUILD_TIME__: string;
declare const __APP_VERSION__: string;
declare const __WEB_APP_VERSION__: string;
declare const __SDK_REACT_VERSION__: string;
