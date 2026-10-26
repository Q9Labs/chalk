// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { ErrorCode } from "@q9labsai/chalk-client";
import { StatusSurface } from "./StatusSurface";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("failed call guidance", () => {
  it("does not invent a reference when the failure code is unknown", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<StatusSurface phase="failed" />));
      expect(container.textContent).toContain("Something went wrong while joining");
      expect(container.textContent).not.toContain("Reference:");
      expect(container.textContent).not.toContain("client.internal_error");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("includes safe socket details in the failure reference", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<StatusSurface phase="failed" errorCode="connection.sync_hello_timeout" sync={{ stage: "upgrade", opened: false, closeCode: 1006, closeReason: null, durationMs: 24 }} />));
      expect(container.textContent).toContain("Try another network");
      expect(container.textContent).toContain("Reference: connection.sync_hello_timeout [upgrade; open=0; close=1006; reason=none; 24ms]");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each([
    ["access.invalid", "Refresh the page"],
    ["access.unavailable", "get access to the call"],
    ["connection.sync_start_failed", "reach the call service"],
    ["connection.sync_hello_timeout", "did not respond in time"],
    ["connection.media_start_failed", "Audio and video could not connect"],
    ["connection.sync_recovery_exhausted", "call connection could not recover"],
    ["connection.media_recovery_exhausted", "Audio and video could not reconnect"],
    ["environment.unsupported", "up-to-date browser"],
    ["client.internal_error", "Something went wrong"],
  ] satisfies [ErrorCode, string][])("shows safe guidance and a reference for %s", async (errorCode, wording) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<StatusSurface phase="failed" errorCode={errorCode} />));
      expect(container.textContent).toContain(wording);
      expect(container.textContent).toContain(`Reference: ${errorCode}`);
      expect(container.textContent).not.toContain("Check your internet connection");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
