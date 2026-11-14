/// <reference types="vite/client" />

// Vite CSS URL imports
declare module "*.css?url" {
  const url: string;
  export default url;
}

// Build-time constants
declare const __APP_VERSION__: string;
