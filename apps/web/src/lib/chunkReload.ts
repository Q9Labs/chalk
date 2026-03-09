const RELOAD_GUARD_KEY = "__chalk_chunk_reload_guard_v1";

function shouldReloadOnce(): boolean {
  try {
    // Prevent infinite reload loops if the new deploy is also broken.
    if (sessionStorage.getItem(RELOAD_GUARD_KEY) === "1") return false;
    sessionStorage.setItem(RELOAD_GUARD_KEY, "1");
    return true;
  } catch {
    // If storage is blocked, still try once per page-load.
    return true;
  }
}

function matchesChunkLoadFailure(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("failed to fetch dynamically imported module") || m.includes("failed to load module script") || m.includes("importing a module script failed") || (m.includes("mime type") && m.includes("text/html")) || m.includes("loading chunk") || m.includes("chunkloaderror");
}

export function installChunkLoadAutoReload() {
  if (typeof window === "undefined") return;

  const reload = () => {
    if (!shouldReloadOnce()) return;

    // Bust any cached HTML and ensure we fetch the latest entrypoints.
    const url = new URL(window.location.href);
    url.searchParams.set("__reload", Date.now().toString());
    window.location.replace(url.toString());
  };

  window.addEventListener("unhandledrejection", (event) => {
    const reason: any = (event as any).reason;
    const msg = typeof reason?.message === "string" ? reason.message : typeof reason === "string" ? reason : "";
    if (!msg) return;
    if (!matchesChunkLoadFailure(msg)) return;
    reload();
  });

  window.addEventListener("error", (event) => {
    const msg = typeof (event as any).message === "string" ? (event as any).message : "";
    if (!msg) return;
    if (!matchesChunkLoadFailure(msg)) return;
    reload();
  });
}
