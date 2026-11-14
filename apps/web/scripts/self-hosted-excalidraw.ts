import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const EXCALIDRAW_DIST = "/@excalidraw/excalidraw/dist/";
const PAKO_REPLACEMENT = fileURLToPath(new URL("../src/lib/excalidraw-pako.ts", import.meta.url));

/** The hosted app must not retry a missing local font against Excalidraw's CDN, and loads a smaller zlib than pako. */
export function selfHostedExcalidraw(): Plugin {
  const transform = (code: string, id: string) => {
    if (!id.includes(EXCALIDRAW_DIST) || !code.includes(".ASSETS_FALLBACK_URL")) return;
    const patched = code.replace(/[\w$]+\.push\(new URL\([\w$]+,\s*[\w$]+\.ASSETS_FALLBACK_URL\)\)/g, "void 0");
    if (patched === code) throw new Error("Excalidraw's font fallback changed; update the hosted-app transform before building");
    return { code: patched, map: null };
  };
  const resolveId = (source: string, importer: string | undefined) => (source === "pako" && importer?.includes(EXCALIDRAW_DIST) ? PAKO_REPLACEMENT : undefined);
  return {
    name: "self-hosted-excalidraw",
    enforce: "pre",
    config: () => ({ optimizeDeps: { rolldownOptions: { plugins: [{ name: "self-hosted-excalidraw-deps", resolveId, transform }] } } }),
    resolveId,
    transform,
  };
}
