import type { Plugin } from "vite";

/** The hosted app must not retry a missing local font against Excalidraw's CDN. */
export function selfHostedExcalidraw(): Plugin {
  const transform = (code: string, id: string) => {
    if (!id.includes("/@excalidraw/excalidraw/dist/") || !code.includes(".ASSETS_FALLBACK_URL")) return;
    const patched = code.replace(/[\w$]+\.push\(new URL\([\w$]+,\s*[\w$]+\.ASSETS_FALLBACK_URL\)\)/g, "void 0");
    if (patched === code) throw new Error("Excalidraw's font fallback changed; update the hosted-app transform before building");
    return { code: patched, map: null };
  };
  return {
    name: "self-hosted-excalidraw",
    enforce: "pre",
    config: () => ({ optimizeDeps: { rolldownOptions: { plugins: [{ name: "self-hosted-excalidraw-deps", transform }] } } }),
    transform,
  };
}
