import { chalkDebugCollector } from "@q9labs/chalk-react";

type PermissionNameLike = "camera" | "microphone" | "notifications";

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

const headersSummary = () => ({
  referrer: document.referrer || null,
  cookie: (() => {
    try {
      return document.cookie || null;
    } catch (error) {
      return error instanceof Error ? `[cookie read failed] ${error.message}` : "[cookie read failed]";
    }
  })(),
});

const getViewport = () => ({
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  outerWidth: window.outerWidth,
  outerHeight: window.outerHeight,
  visualViewport: window.visualViewport
    ? {
        width: window.visualViewport.width,
        height: window.visualViewport.height,
        scale: window.visualViewport.scale,
      }
    : null,
});

const getNavigatorSnapshot = () => {
  const nav = navigator as Navigator & {
    connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
    deviceMemory?: number;
  };
  const perf = performance as Performance & { memory?: unknown };

  return {
    userAgent: nav.userAgent,
    language: nav.language,
    languages: nav.languages,
    platform: nav.platform,
    vendor: nav.vendor,
    online: nav.onLine,
    cookieEnabled: nav.cookieEnabled,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
    maxTouchPoints: nav.maxTouchPoints,
    connection: nav.connection
      ? {
          effectiveType: nav.connection.effectiveType,
          downlink: nav.connection.downlink,
          rtt: nav.connection.rtt,
          saveData: nav.connection.saveData,
        }
      : null,
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      availWidth: window.screen.availWidth,
      availHeight: window.screen.availHeight,
      colorDepth: window.screen.colorDepth,
      pixelDepth: window.screen.pixelDepth,
      devicePixelRatio: window.devicePixelRatio,
    },
    viewport: getViewport(),
    memory: perf.memory ?? null,
  };
};

const getPermissionsSnapshot = async () => {
  if (!navigator.permissions?.query) return {};
  const names: PermissionNameLike[] = ["camera", "microphone", "notifications"];
  const results = await Promise.allSettled(names.map(async (name) => [name, (await navigator.permissions.query({ name } as PermissionDescriptor)).state] as const));
  return Object.fromEntries(results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])));
};

const getDevicesSnapshot = async () => {
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
    return [
      {
        error: error instanceof Error ? error.message : String(error),
      },
    ];
  }
};

const safeJsonStringify = (value: unknown) => {
  const seen = new WeakSet<object>();

  return JSON.stringify(
    value,
    (_key, currentValue) => {
      if (typeof currentValue === "bigint") {
        return `${currentValue.toString()}n`;
      }

      if (typeof currentValue === "function") {
        return `[Function ${currentValue.name || "anonymous"}]`;
      }

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
        if (seen.has(currentValue)) {
          return "[Circular]";
        }
        seen.add(currentValue);
      }

      return currentValue;
    },
    2,
  );
};

async function copyTextToClipboard(text: string) {
  try {
    await navigator.clipboard?.writeText?.(text);
    return true;
  } catch {
    // Fall through to legacy/browser-specific strategies.
  }

  try {
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

    try {
      if (document.execCommand("copy")) {
        return true;
      }
    } finally {
      document.body.removeChild(textarea);
    }
  } catch {
    // Fall through.
  }

  return false;
}

export async function copyDebugReportToClipboard(reportPromise: Promise<unknown>) {
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    let resolvedReport: unknown;

    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": reportPromise.then((report) => {
            resolvedReport = report;
            return new Blob([toDebugClipboardText(report)], { type: "text/plain" });
          }),
        }),
      ]);

      return {
        copied: true,
        report: resolvedReport ?? (await reportPromise),
      };
    } catch {
      // Fall through to post-build strategies.
    }
  }

  const report = await reportPromise;
  if (await copyTextToClipboard(toDebugClipboardText(report))) {
    return { copied: true, report };
  }

  return { copied: false, report };
}

export async function buildChalkWebDebugReport(errorContext: { message: string; traceId?: string }) {
  const permissions = await getPermissionsSnapshot();
  const devices = await getDevicesSnapshot();
  const snapshot = chalkDebugCollector.getSnapshot();

  return {
    report: {
      generatedAt: snapshot.generatedAt,
      app: "chalk-web",
      url: window.location.href,
      origin: window.location.origin,
      host: window.location.host,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
      historyLength: window.history.length,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      visibilityState: document.visibilityState,
      title: document.title,
      referrer: document.referrer || null,
      sdkReactVersion: __SDK_REACT_VERSION__,
      webAppVersion: __WEB_APP_VERSION__,
      commitHash: __COMMIT_HASH__,
      buildTime: __BUILD_TIME__,
      env: { ...import.meta.env },
    },
    error: {
      message: errorContext.message,
      traceId: errorContext.traceId ?? null,
    },
    browser: {
      navigator: getNavigatorSnapshot(),
      permissions,
      devices,
      storage: {
        localStorage: storageToObject(window.localStorage),
        sessionStorage: storageToObject(window.sessionStorage),
      },
      document: headersSummary(),
    },
    logs: snapshot,
  };
}

export function toDebugClipboardText(report: unknown): string {
  return [
    "Chalk Full Debug Report",
    "=======================",
    "",
    safeJsonStringify(report),
  ].join("\n");
}

export function downloadDebugReport(report: unknown, filename = `chalk-debug-${Date.now()}.json`) {
  const blob = new Blob([safeJsonStringify(report)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
