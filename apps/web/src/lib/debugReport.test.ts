// @vitest-environment jsdom

import { chalkDebugCollector } from "@q9labs/chalk-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildChalkWebDebugReport, copyDebugReportToClipboard, toDebugClipboardText } from "./debugReport";

describe("debugReport", () => {
  afterEach(() => {
    chalkDebugCollector.reset();
    vi.restoreAllMocks();
  });

  it("builds a merged debug report with collector logs and registered sections", async () => {
    chalkDebugCollector.recordFetch({
      id: "fetch-1",
      timestamp: "2026-03-26T00:00:00.000Z",
      method: "POST",
      url: "https://chalk.test/api/v1/rooms",
      requestHeaders: { authorization: "Bearer test-token" },
      requestBody: { roomId: "room_123" },
      status: 200,
      responseBody: { ok: true },
    });

    const unregister = chalkDebugCollector.registerSection("chalkSession", () => ({
      diagnostics: { roomId: "room_123" },
    }));

    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { deviceId: "cam-1", groupId: "group-1", kind: "videoinput", label: "Camera 1" },
        ]),
      },
      permissions: {
        query: vi.fn().mockResolvedValue({ state: "granted" }),
      },
    });

    const report = await buildChalkWebDebugReport({
      message: "Boom",
      traceId: "trace-123",
    });

    expect(report.error).toMatchObject({
      message: "Boom",
      traceId: "trace-123",
    });
    expect(report.logs.fetch).toHaveLength(1);
    expect(report.logs.sections.chalkSession).toEqual({
      diagnostics: { roomId: "room_123" },
    });
    expect(report.browser.devices).toEqual([
      { deviceId: "cam-1", groupId: "group-1", kind: "videoinput", label: "Camera 1" },
    ]);

    unregister();
  });

  it("formats clipboard text as a titled JSON payload", () => {
    const text = toDebugClipboardText({ hello: "world" });

    expect(text).toContain("Chalk Full Debug Report");
    expect(text).toContain('"hello": "world"');
  });

  it("serializes circular and non-JSON-native values without throwing", () => {
    const circular: { self?: unknown; counter: bigint; values: Set<string> } = {
      counter: 42n,
      values: new Set(["room_123"]),
    };
    circular.self = circular;

    const text = toDebugClipboardText(circular);

    expect(text).toContain('"counter": "42n"');
    expect(text).toContain('"__type": "Set"');
    expect(text).toContain('"self": "[Circular]"');
  });

  it("uses ClipboardItem write during the click-safe copy flow when available", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const originalClipboardItem = globalThis.ClipboardItem;
    const clipboardItemSpy = vi.fn((items: Record<string, Promise<Blob>>) => items);

    Object.assign(navigator, {
      clipboard: {
        ...navigator.clipboard,
        write,
      },
    });
    // @ts-expect-error test shim
    globalThis.ClipboardItem = clipboardItemSpy;

    const result = await copyDebugReportToClipboard(Promise.resolve({ hello: "world" }));

    expect(result.copied).toBe(true);
    expect(clipboardItemSpy).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);

    globalThis.ClipboardItem = originalClipboardItem;
  });
});
