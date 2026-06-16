// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { copyDebugTextToClipboard, prepareFullDebugExport, toDebugClipboardText } from "../../utils/debugExport";

const makeStorage = (seed: Record<string, string>) => {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    get length() {
      return store.size;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  } satisfies Storage;
};

const setNavigatorProperty = (key: "permissions" | "mediaDevices" | "clipboard", value: unknown) => {
  Object.defineProperty(navigator, key, {
    configurable: true,
    writable: true,
    value,
  });
};

describe("debugExport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "__CHALK_DEBUG_ENV__");
  });

  it("captures browser parity fields and runtime env in prepared debug reports", async () => {
    const localStorage = makeStorage({ chalk_local_key: "local-value" });
    const sessionStorage = makeStorage({ chalk_session_key: "session-value" });
    Object.defineProperty(window, "localStorage", { configurable: true, value: localStorage });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: sessionStorage });

    Object.defineProperty(document, "referrer", { configurable: true, value: "https://classroom.example/referrer" });
    document.title = "Diagnostics Page";

    setNavigatorProperty("permissions", {
      query: vi.fn(async ({ name }: { name: string }) => ({ state: name === "notifications" ? "prompt" : "granted" })),
    });
    setNavigatorProperty("mediaDevices", {
      enumerateDevices: vi.fn(async () => [{ deviceId: "cam-1", groupId: "group-1", kind: "videoinput", label: "Camera 1" }]),
    });
    setNavigatorProperty("clipboard", {
      writeText: vi.fn(async () => undefined),
      readText: vi.fn(async () => ""),
    });

    Object.defineProperty(globalThis, "__CHALK_DEBUG_ENV__", {
      configurable: true,
      writable: true,
      value: {
        MODE: "test",
        VITE_API_BASE_URL: "https://api.chalk.example",
      },
    });

    const prepared = await prepareFullDebugExport({
      error: "Room join failed",
      traceId: "trace-abc",
    });

    const report = prepared.report as Record<string, any>;
    expect(report.meta.schemaVersion).toBe("chalk-debug-report/v2");
    expect(report.browser.permissions).toMatchObject({
      camera: "granted",
      microphone: "granted",
      notifications: "prompt",
    });
    expect(report.browser.devices).toEqual([{ deviceId: "cam-1", groupId: "group-1", kind: "videoinput", label: "Camera 1" }]);
    expect(report.browser.storage.full.localStorage).toMatchObject({
      chalk_local_key: "local-value",
    });
    expect(report.browser.storage.full.sessionStorage).toMatchObject({
      chalk_session_key: "session-value",
    });
    expect(report.browser.document.referrer).toBe("https://classroom.example/referrer");
    expect(report.navigationContext.referrer).toBe("https://classroom.example/referrer");
    expect(report.raw.context).toMatchObject({
      error: "Room join failed",
      traceId: "trace-abc",
    });
    expect(typeof report.raw.context.timezone).toBe("string");
    expect(report.raw.env).toMatchObject({
      MODE: "test",
      VITE_API_BASE_URL: "https://api.chalk.example",
    });
    expect(prepared.diagnostics.textBytes).toBeGreaterThan(0);
  });

  it("formats debug clipboard text with a stable heading", () => {
    const text = toDebugClipboardText({
      foo: "bar",
    });

    expect(text).toContain("Chalk Full Debug Report");
    expect(text).toContain('"foo": "bar"');
  });

  it("copies plain text debug payload using clipboard strategies", async () => {
    let copied = "";
    const writeText = vi.fn(async (value: string) => {
      copied = value;
    });
    const readText = vi.fn(async () => copied);

    setNavigatorProperty("clipboard", {
      writeText,
      readText,
      write: undefined,
    });

    const result = await copyDebugTextToClipboard("debug-text");

    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalledWith("debug-text");
    expect(readText).toHaveBeenCalled();
  });
});
