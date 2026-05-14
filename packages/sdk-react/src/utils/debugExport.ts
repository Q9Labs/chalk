import { buildStructuredDebugReport, chalkDebugCollector } from "@q9labs/chalk-core";

type DebugExportAttempt = {
  strategy: string;
  ok: boolean;
  error?: string;
};

type DebugExportDiagnostics = {
  textBytes?: number;
  clipboardAvailable: boolean;
  clipboardWriteTextAvailable: boolean;
  clipboardWriteAvailable: boolean;
  clipboardItemAvailable: boolean;
  attempts: DebugExportAttempt[];
};

type PermissionNameLike = "camera" | "microphone" | "notifications";

type ImportMetaWithEnv = ImportMeta & {
  env?: Record<string, unknown>;
};

type GlobalWithDebugEnv = typeof globalThis & {
  __CHALK_DEBUG_ENV__?: Record<string, unknown>;
};

export type PreparedDebugExport = {
  report: Record<string, unknown>;
  text: string;
  diagnostics: DebugExportDiagnostics;
};

export type DebugCopyResult = {
  outcome: "copied" | "failed";
  report: Record<string, unknown>;
  diagnostics: DebugExportDiagnostics;
};

const toErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return typeof error === "string" ? error : String(error);
};

const safeValue = <T>(read: () => T, fallback: T): T => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

const storageToObject = (storage: Storage | undefined) => {
  if (!storage) return {};
  try {
    return Object.fromEntries(Array.from({ length: storage.length }, (_, index) => {
      const key = storage.key(index) ?? `${index}`;
      return [key, storage.getItem(key)];
    }));
  } catch (error) {
    return {
      __error: error instanceof Error ? error.message : String(error),
    };
  }
};

const getDocumentSnapshot = () => ({
  referrer: safeValue(() => document.referrer || null, null),
  title: safeValue(() => document.title, ""),
  visibilityState: safeValue(() => document.visibilityState, "hidden"),
  readyState: safeValue(() => document.readyState, "loading"),
  cookie: (() => {
    try {
      return document.cookie || null;
    } catch (error) {
      return error instanceof Error ? `[cookie read failed] ${error.message}` : "[cookie read failed]";
    }
  })(),
});

const getRuntimeEnvironmentSnapshot = () => {
  const runtimeGlobals = globalThis as GlobalWithDebugEnv;
  if (runtimeGlobals.__CHALK_DEBUG_ENV__ && typeof runtimeGlobals.__CHALK_DEBUG_ENV__ === "object") {
    return { ...runtimeGlobals.__CHALK_DEBUG_ENV__ };
  }

  const env = (import.meta as ImportMetaWithEnv).env;
  if (env && typeof env === "object") {
    return { ...env };
  }

  return null;
};

const getTimezone = () => safeValue(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown", "unknown");

const getNavigatorSnapshot = () => {
  const nav = navigator as Navigator & {
    connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
    deviceMemory?: number;
  };
  const perf = performance as Performance & { memory?: unknown };

  return {
    userAgent: safeValue(() => nav.userAgent, ""),
    language: safeValue(() => nav.language, ""),
    languages: safeValue(() => nav.languages, [] as readonly string[]),
    platform: safeValue(() => nav.platform, ""),
    vendor: safeValue(() => nav.vendor, ""),
    online: safeValue(() => nav.onLine, true),
    cookieEnabled: safeValue(() => nav.cookieEnabled, false),
    hardwareConcurrency: safeValue(() => nav.hardwareConcurrency, undefined),
    deviceMemory: safeValue(() => nav.deviceMemory, undefined),
    maxTouchPoints: safeValue(() => nav.maxTouchPoints, 0),
    connection: safeValue(() => nav.connection, undefined)
      ? {
          effectiveType: safeValue(() => nav.connection?.effectiveType, undefined),
          downlink: safeValue(() => nav.connection?.downlink, undefined),
          rtt: safeValue(() => nav.connection?.rtt, undefined),
          saveData: safeValue(() => nav.connection?.saveData, undefined),
        }
      : null,
    screen: {
      width: safeValue(() => window.screen.width, 0),
      height: safeValue(() => window.screen.height, 0),
      availWidth: safeValue(() => window.screen.availWidth, 0),
      availHeight: safeValue(() => window.screen.availHeight, 0),
      colorDepth: safeValue(() => window.screen.colorDepth, 0),
      pixelDepth: safeValue(() => window.screen.pixelDepth, 0),
      devicePixelRatio: safeValue(() => window.devicePixelRatio, 1),
    },
    viewport: {
      innerWidth: safeValue(() => window.innerWidth, 0),
      innerHeight: safeValue(() => window.innerHeight, 0),
      outerWidth: safeValue(() => window.outerWidth, 0),
      outerHeight: safeValue(() => window.outerHeight, 0),
      visualViewport: safeValue(() => window.visualViewport, undefined)
        ? {
            width: safeValue(() => window.visualViewport?.width, 0),
            height: safeValue(() => window.visualViewport?.height, 0),
            scale: safeValue(() => window.visualViewport?.scale, 1),
          }
        : null,
    },
    memory: safeValue(() => perf.memory ?? null, null),
  };
};

const safeJsonStringify = (value: unknown) => {
  const seen = new WeakSet<object>();

  return JSON.stringify(
    value,
    (_key, currentValue) => {
      if (typeof currentValue === "bigint") return `${currentValue.toString()}n`;
      if (typeof currentValue === "function") return `[Function ${currentValue.name || "anonymous"}]`;

      if (currentValue instanceof Error) {
        return {
          name: currentValue.name,
          message: currentValue.message,
          stack: currentValue.stack,
          cause: currentValue.cause,
        };
      }

      if (currentValue instanceof Map) {
        return {
          __type: "Map",
          entries: [...currentValue.entries()],
        };
      }

      if (currentValue instanceof Set) {
        return {
          __type: "Set",
          values: [...currentValue.values()],
        };
      }

      if (typeof Blob !== "undefined" && currentValue instanceof Blob) {
        return {
          __type: "Blob",
          size: currentValue.size,
          type: currentValue.type,
        };
      }

      if (currentValue instanceof ArrayBuffer) {
        return {
          __type: "ArrayBuffer",
          byteLength: currentValue.byteLength,
        };
      }

      if (ArrayBuffer.isView(currentValue)) {
        return {
          __type: currentValue.constructor.name,
          byteLength: currentValue.byteLength,
        };
      }

      if (typeof currentValue === "object" && currentValue !== null) {
        if (seen.has(currentValue)) return "[Circular]";
        seen.add(currentValue);
      }

      return currentValue;
    },
    2,
  );
};

export const toDebugClipboardText = (report: unknown) =>
  [
    "Chalk Full Debug Report",
    "=======================",
    "",
    safeJsonStringify(report),
  ].join("\n");

const verifyClipboardText = async (text: string) => {
  const readText = navigator.clipboard?.readText?.bind(navigator.clipboard);
  if (!readText) {
    return {
      verified: false,
      reason: "Clipboard read API unavailable for verification",
    } as const;
  }

  try {
    const copiedText = await readText();
    return copiedText === text
      ? ({ verified: true } as const)
      : ({
          verified: false,
          reason: "Clipboard verification mismatch",
        } as const);
  } catch (error) {
    return {
      verified: false,
      reason: `Clipboard verification failed: ${toErrorMessage(error)}`,
    } as const;
  }
};

const copyTextWithExecCommand = (text: string) => {
  let eventCopyWorked = false;
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const handleCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) {
      return;
    }

    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
    eventCopyWorked = true;
  };

  document.addEventListener("copy", handleCopy);
  try {
    if (document.execCommand("copy") && eventCopyWorked) {
      return true;
    }
  } finally {
    document.removeEventListener("copy", handleCopy);
    activeElement?.focus();
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  let selectionCopyWorked = false;

  try {
    selectionCopyWorked = document.execCommand("copy");
    return selectionCopyWorked;
  } finally {
    document.body.removeChild(textarea);
    activeElement?.focus();
  }
};

const copyTextToClipboard = async (text: string, diagnostics: DebugExportDiagnostics) => {
  let copied = false;

  try {
    if (!copyTextWithExecCommand(text)) {
      diagnostics.attempts.push({ strategy: "document.execCommand(copy)", ok: false, error: "Command returned false" });
    } else {
      const verification = await verifyClipboardText(text);
      if (verification.verified) {
        diagnostics.attempts.push({ strategy: "document.execCommand(copy)", ok: true });
      } else {
        diagnostics.attempts.push({ strategy: "document.execCommand(copy) (unverified)", ok: true, error: verification.reason });
      }
      copied = true;
    }
  } catch (error) {
    diagnostics.attempts.push({ strategy: "document.execCommand(copy)", ok: false, error: toErrorMessage(error) });
  }

  try {
    const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (!writeText) {
      diagnostics.attempts.push({ strategy: "clipboard.writeText", ok: false, error: "Clipboard API unavailable" });
    } else {
      await writeText(text);
      const verification = await verifyClipboardText(text);
      if (verification.verified) {
        diagnostics.attempts.push({ strategy: "clipboard.writeText", ok: true });
      } else {
        diagnostics.attempts.push({ strategy: "clipboard.writeText (unverified)", ok: true, error: verification.reason });
      }
      copied = true;
    }
  } catch (error) {
    diagnostics.attempts.push({ strategy: "clipboard.writeText", ok: false, error: toErrorMessage(error) });
  }

  try {
    const write = navigator.clipboard?.write?.bind(navigator.clipboard);
    if (!write || typeof ClipboardItem === "undefined") {
      diagnostics.attempts.push({ strategy: "clipboard.write(ClipboardItem)", ok: false, error: "ClipboardItem API unavailable" });
    } else {
      await write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
      const verification = await verifyClipboardText(text);
      if (verification.verified) {
        diagnostics.attempts.push({ strategy: "clipboard.write(ClipboardItem)", ok: true });
      } else {
        diagnostics.attempts.push({ strategy: "clipboard.write(ClipboardItem) (unverified)", ok: true, error: verification.reason });
      }
      copied = true;
    }
  } catch (error) {
    diagnostics.attempts.push({ strategy: "clipboard.write(ClipboardItem)", ok: false, error: toErrorMessage(error) });
  }

  return copied;
};

export const copyDebugTextToClipboard = async (text: string) => {
  const diagnostics: DebugExportDiagnostics = {
    clipboardAvailable: Boolean(navigator.clipboard),
    clipboardWriteTextAvailable: Boolean(navigator.clipboard?.writeText),
    clipboardWriteAvailable: Boolean(navigator.clipboard?.write),
    clipboardItemAvailable: typeof ClipboardItem !== "undefined",
    attempts: [],
  };

  return copyTextToClipboard(text, diagnostics);
};
export const downloadDebugReport = (report: unknown, filename = `chalk-debug-${Date.now()}.json`) => {
  const blob = new Blob([safeJsonStringify(report)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

export const downloadDebugText = (text: string, filename = `chalk-debug-${Date.now()}.txt`) => {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

async function getPermissionsSnapshot() {
  if (!navigator.permissions?.query) return {};
  const names: PermissionNameLike[] = ["camera", "microphone", "notifications"];
  const results = await Promise.allSettled(names.map(async (name) => [name, (await navigator.permissions.query({ name } as PermissionDescriptor)).state] as const));
  return Object.fromEntries(results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])));
}

async function getDevicesSnapshot() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.map((device) => ({
      deviceId: device.deviceId,
      groupId: device.groupId,
      kind: device.kind,
      label: device.label,
    }));
  } catch (error) {
    return [{ error: error instanceof Error ? error.message : String(error) }];
  }
}

export async function prepareFullDebugExport(context: Record<string, unknown>): Promise<PreparedDebugExport> {
  const diagnostics: DebugExportDiagnostics = {
    clipboardAvailable: Boolean(navigator.clipboard),
    clipboardWriteTextAvailable: Boolean(navigator.clipboard?.writeText),
    clipboardWriteAvailable: Boolean(navigator.clipboard?.write),
    clipboardItemAvailable: typeof ClipboardItem !== "undefined",
    attempts: [],
  };

  const generatedAt = new Date().toISOString();
  const documentSnapshot = getDocumentSnapshot();
  const runtimeEnvironment = getRuntimeEnvironmentSnapshot();

  const report = buildStructuredDebugReport({
    generatedAt,
    reportType: "sdk-react-full",
    app: {
      name: "chalk-sdk-react",
    },
    location: {
      url: window.location.href,
      origin: window.location.origin,
      host: window.location.host,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
      title: documentSnapshot.title,
      referrer: documentSnapshot.referrer,
      historyLength: safeValue(() => window.history.length, null),
      visibilityState: documentSnapshot.visibilityState,
    },
    browser: {
      navigator: getNavigatorSnapshot(),
      permissions: await getPermissionsSnapshot(),
      devices: await getDevicesSnapshot(),
      storage: {
        localStorage: storageToObject(window.localStorage),
        sessionStorage: storageToObject(window.sessionStorage),
      },
      document: documentSnapshot,
    },
    context: {
      timezone: getTimezone(),
      ...context,
    },
    environment: {
      env: runtimeEnvironment,
    },
    logs: chalkDebugCollector.getSnapshot(),
  });
  const text = toDebugClipboardText(report);
  diagnostics.textBytes = new TextEncoder().encode(text).length;

  return { report, text, diagnostics };
}

export async function copyPreparedDebugExport(prepared: PreparedDebugExport): Promise<DebugCopyResult> {
  if (await copyTextToClipboard(prepared.text, prepared.diagnostics)) {
    if (prepared.diagnostics.attempts.some((attempt) => !attempt.ok)) {
      console.warn("[chalk][debug-export] copied after fallback", prepared.diagnostics);
    }
    return { outcome: "copied", report: prepared.report, diagnostics: prepared.diagnostics };
  }

  console.error("[chalk][debug-export] all copy strategies failed", prepared.diagnostics);
  return { outcome: "failed", report: prepared.report, diagnostics: prepared.diagnostics };
}

export async function exportFullDebugReport(context: Record<string, unknown>) {
  const prepared = await prepareFullDebugExport(context);

  const result = await copyPreparedDebugExport(prepared);
  if (result.outcome === "copied") {
    return result;
  }

  downloadDebugReport(prepared.report);
  return { outcome: "downloaded" as const, report: prepared.report, diagnostics: prepared.diagnostics };
}
