// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { RecordingHistoryPanel, type RecordingHistoryItem } from "./RecordingHistoryPanel";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

describe("RecordingHistoryPanel", () => {
  it("shows transcript readiness separately and requests a video on the first download", async () => {
    const onRequestExport = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const recording: RecordingHistoryItem = {
      created_at: "2026-09-21T12:00:00Z",
      episode_id: "episode-one",
      export: { retryable: false, status: "none" },
      id: "recording-one",
      source: { status: "available" },
      status: "completed",
      transcript: { status: "completed" },
      updated_at: "2026-09-21T12:00:00Z",
    };
    try {
      await act(async () => root.render(<RecordingHistoryPanel recordings={[recording]} onRequestExport={onRequestExport} />));
      expect(container.textContent).toContain("Transcript");
      expect(container.textContent).toContain("Transcript is ready.");
      expect(container.textContent).toContain("A video will be prepared when you watch or download.");
      const download = container.querySelector('button[aria-label="Download recording recordin"]');
      if (!(download instanceof HTMLButtonElement)) throw new Error("Download action is missing");
      await act(async () => download.click());
      expect(onRequestExport).toHaveBeenCalledWith(recording, "download");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("keeps ready videos watchable and downloadable", async () => {
    const onDownload = vi.fn();
    const onWatch = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const recording: RecordingHistoryItem = {
      created_at: "2026-09-21T12:00:00Z",
      episode_id: "episode-one",
      export: { retryable: false, status: "ready" },
      id: "recording-one",
      source: { status: "expired" },
      status: "completed",
      transcript: { status: "completed" },
      updated_at: "2026-09-21T12:00:00Z",
    };
    try {
      await act(async () => root.render(<RecordingHistoryPanel recordings={[recording]} onDownload={onDownload} onWatch={onWatch} />));
      expect(container.textContent).toContain("Video is ready to watch or download.");
      const watch = container.querySelector('button[aria-label="Watch recording recordin"]');
      const download = container.querySelector('button[aria-label="Download recording recordin"]');
      if (!(watch instanceof HTMLButtonElement) || !(download instanceof HTMLButtonElement)) throw new Error("Ready video actions are missing");
      await act(async () => watch.click());
      await act(async () => download.click());
      expect(onWatch).toHaveBeenCalledWith(recording);
      expect(onDownload).toHaveBeenCalledWith(recording);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("reads completed transcript text only after the person asks", async () => {
    const onReadTranscript = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const recording: RecordingHistoryItem = {
      created_at: "2026-09-21T12:00:00Z",
      episode_id: "episode-one",
      export: { retryable: false, status: "none" },
      id: "recording-one",
      source: { status: "available" },
      status: "completed",
      transcript: { status: "completed" },
      updated_at: "2026-09-21T12:00:00Z",
    };
    try {
      await act(async () => root.render(<RecordingHistoryPanel recordings={[recording]} onReadTranscript={onReadTranscript} />));
      const read = container.querySelector('button[aria-label="Read transcript recordin"]');
      if (!(read instanceof HTMLButtonElement)) throw new Error("Read transcript action is missing");
      await act(async () => read.click());
      expect(onReadTranscript).toHaveBeenCalledWith(recording);

      const withText = { ...recording, transcript: { status: "completed" as const, text: "A real transcript cue." } };
      await act(async () => root.render(<RecordingHistoryPanel recordings={[withText]} onReadTranscript={onReadTranscript} />));
      expect(container.textContent).toContain("A real transcript cue.");
      expect(container.querySelector('button[aria-label^="Read transcript"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("does not offer a video action after capture expiry", async () => {
    const onRequestExport = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const recording: RecordingHistoryItem = {
      created_at: "2026-09-21T12:00:00Z",
      episode_id: "episode-one",
      export: { retryable: false, status: "unavailable" },
      id: "recording-one",
      source: { status: "expired" },
      status: "failed",
      updated_at: "2026-09-21T12:00:00Z",
    };
    try {
      await act(async () => root.render(<RecordingHistoryPanel recordings={[recording]} onRequestExport={onRequestExport} />));
      expect(container.textContent).toContain("Capture is no longer available.");
      expect(container.textContent).toContain("Video cannot be created because the capture is unavailable.");
      expect(container.querySelector('button[aria-label^="Watch recording"]')).toBeNull();
      expect(container.querySelector('button[aria-label^="Download recording"]')).toBeNull();
      expect(onRequestExport).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("offers a retry when the API marks a failed video retryable", async () => {
    const onRequestExport = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const recording: RecordingHistoryItem = {
      created_at: "2026-09-21T12:00:00Z",
      episode_id: "episode-one",
      export: { failure_message: "Video service is temporarily unavailable.", retryable: true, status: "failed" },
      id: "recording-one",
      source: { status: "available" },
      status: "failed",
      updated_at: "2026-09-21T12:00:00Z",
    };
    try {
      await act(async () => root.render(<RecordingHistoryPanel recordings={[recording]} onRequestExport={onRequestExport} />));
      expect(container.textContent).toContain("Video service is temporarily unavailable.");
      const watch = container.querySelector('button[aria-label="Watch recording recordin"]');
      if (!(watch instanceof HTMLButtonElement)) throw new Error("Retry watch action is missing");
      await act(async () => watch.click());
      expect(onRequestExport).toHaveBeenCalledWith(recording, "watch");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("keeps pending video status refreshable and exposes an eligible on-demand transcript request", async () => {
    const onRefreshExport = vi.fn();
    const onRequestTranscript = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const recording: RecordingHistoryItem = {
      created_at: "2026-09-21T12:00:00Z",
      episode_id: "episode-one",
      export: { retryable: false, status: "pending" },
      id: "recording-one",
      source: { status: "available" },
      status: "completed",
      transcript: { requestable: true, status: "none" },
      updated_at: "2026-09-21T12:00:00Z",
    };
    try {
      await act(async () => root.render(<RecordingHistoryPanel recordings={[recording]} onRefreshExport={onRefreshExport} onRequestTranscript={onRequestTranscript} />));
      const checkStatus = container.querySelector('button[aria-label="Check video status recordin"]');
      const requestTranscript = container.querySelector('button[aria-label="Request transcript recordin"]');
      if (!(checkStatus instanceof HTMLButtonElement) || !(requestTranscript instanceof HTMLButtonElement)) throw new Error("Pending video and transcript actions are missing");
      await act(async () => checkStatus.click());
      await act(async () => requestTranscript.click());
      expect(onRefreshExport).toHaveBeenCalledWith(recording);
      expect(onRequestTranscript).toHaveBeenCalledWith(recording);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
