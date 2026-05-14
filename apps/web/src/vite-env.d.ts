/// <reference types="vite/client" />

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

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
}

// Build-time constants
declare const __COMMIT_HASH__: string;
declare const __BUILD_TIME__: string;
declare const __APP_VERSION__: string;
declare const __WEB_APP_VERSION__: string;
declare const __SDK_REACT_VERSION__: string;
