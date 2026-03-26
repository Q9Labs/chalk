import { chalkDebugCollector } from "@q9labs/chalk-core";

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

const toClipboardText = (report: unknown) =>
  [
    "Chalk Full Debug Report",
    "=======================",
    "",
    safeJsonStringify(report),
  ].join("\n");

const downloadDebugReport = (report: unknown, filename = `chalk-debug-${Date.now()}.json`) => {
  const blob = new Blob([safeJsonStringify(report)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

async function getPermissionsSnapshot() {
  if (!navigator.permissions?.query) return {};
  const names = ["camera", "microphone", "notifications"] as const;
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

export async function exportFullDebugReport(context: Record<string, unknown>) {
  const report = {
    report: {
      generatedAt: new Date().toISOString(),
      app: "chalk-sdk-react",
      url: window.location.href,
      origin: window.location.origin,
      host: window.location.host,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
      title: document.title,
      referrer: document.referrer || null,
    },
    browser: {
      navigator: getNavigatorSnapshot(),
      permissions: await getPermissionsSnapshot(),
      devices: await getDevicesSnapshot(),
      storage: {
        localStorage: storageToObject(window.localStorage),
        sessionStorage: storageToObject(window.sessionStorage),
      },
      document: {
        cookie: (() => {
          try {
            return document.cookie || null;
          } catch (error) {
            return error instanceof Error ? `[cookie read failed] ${error.message}` : "[cookie read failed]";
          }
        })(),
        visibilityState: document.visibilityState,
      },
    },
    context,
    logs: chalkDebugCollector.getSnapshot(),
  };

  const text = toClipboardText(report);

  try {
    await navigator.clipboard.writeText(text);
    return { outcome: "copied" as const, report };
  } catch {
    downloadDebugReport(report);
    return { outcome: "downloaded" as const, report };
  }
}
