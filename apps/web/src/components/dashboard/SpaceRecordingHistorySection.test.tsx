/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SpaceRecordingHistorySection, type SpaceRecordingHistoryClient } from "./SpaceRecordingHistorySection";

vi.mock("@q9labsai/chalk-react", () => ({
  RecordingHistoryPanel: ({
    onReadTranscript,
    onDownload,
    onRequestExport,
    onRequestTranscript,
    onRefreshExport,
    onLoadMore,
    hasMore,
    onWatch,
    recordings,
  }: {
    readonly onReadTranscript?: (recording: { readonly id: string }) => void;
    readonly onDownload?: (recording: { readonly id: string }) => void;
    readonly onRequestExport?: (recording: { readonly id: string }, action: "watch" | "download") => void;
    readonly onRequestTranscript?: (recording: { readonly id: string }) => void;
    readonly onRefreshExport?: (recording: { readonly id: string }) => void;
    readonly onLoadMore?: () => void;
    readonly hasMore?: boolean;
    readonly onWatch?: (recording: { readonly id: string }) => void;
    readonly recordings: readonly {
      readonly export?: { readonly status: string };
      readonly id: string;
      readonly transcript?: {
        readonly requestable?: boolean;
        readonly status: string;
        readonly text?: string;
      };
    }[];
  }) => {
    return (
      <div>
        {recordings.map((recording) => (
          <div key={recording.id}>
            <span>{recording.id}</span>
            <span>{recording.export?.status}</span>
            <span>{`Transcript ${recording.id.slice(0, 8)}: ${recording.transcript?.status}`}</span>
            {recording.transcript?.status === "completed" && recording.transcript.text === undefined ? <button onClick={() => onReadTranscript?.(recording)}>Read transcript {recording.id.slice(0, 8)}</button> : null}
            {recording.transcript?.status === "requestable" && recording.transcript.requestable ? <button onClick={() => onRequestTranscript?.(recording)}>Request transcript {recording.id.slice(0, 8)}</button> : null}
            {recording.transcript?.text === undefined ? null : <p>{recording.transcript.text}</p>}
            {recording.export?.status === "pending" ? <button onClick={() => onRefreshExport?.(recording)}>Check video status {recording.id.slice(0, 8)}</button> : null}
            {recording.export?.status === "ready" ? (
              <>
                <button onClick={() => onWatch?.(recording)}>Watch recording {recording.id.slice(0, 8)}</button>
                <button onClick={() => onDownload?.(recording)}>Download recording {recording.id.slice(0, 8)}</button>
              </>
            ) : (
              <>
                <button onClick={() => onRequestExport?.(recording, "watch")}>Watch recording {recording.id.slice(0, 8)}</button>
                <button onClick={() => onRequestExport?.(recording, "download")}>Download recording {recording.id.slice(0, 8)}</button>
              </>
            )}
          </div>
        ))}
        {hasMore ? <button onClick={onLoadMore}>Load more</button> : null}
      </div>
    );
  },
}));

const tenantID = "11111111-1111-4111-8111-111111111111";
const spaceID = "22222222-2222-4222-8222-222222222222";
const episodeID = "33333333-3333-4333-8333-333333333333";
const recordingID = "44444444-4444-4444-8444-444444444444";
const transcriptID = "55555555-5555-4555-8555-555555555555";

const recording = {
  created_at: "2026-09-22T09:00:00Z",
  episode_id: episodeID,
  export: { retryable: false, status: "none" },
  id: recordingID,
  metadata: {},
  source: { expires_at: "2026-10-22T09:00:00Z", status: "available" },
  space_id: spaceID,
  status: "completed",
  storage_key: null,
  storage_provider: "r2",
  tenant_id: tenantID,
  transcription_policy: "on_demand",
  transcription_preparation: { status: "ready" },
  updated_at: "2026-09-22T09:00:00Z",
};

const completedTranscript = {
  created_at: "2026-09-22T09:00:00Z",
  episode_id: episodeID,
  generation: 1,
  id: transcriptID,
  languages: ["en"],
  recording_id: recordingID,
  source_expires_at: "2026-10-22T09:00:00Z",
  space_id: spaceID,
  status: "completed",
  tenant_id: tenantID,
  updated_at: "2026-09-22T09:00:00Z",
};

const readyRecording = { ...recording, export: { retryable: false, status: "ready" } };

function historyPage(recordings: (typeof recording)[], hasMore = false, nextCursor: string | null = null) {
  return { pagination: { has_more: hasMore, next_cursor: nextCursor, page_size: 20 }, recordings };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SpaceRecordingHistorySection", () => {
  it("reads the authenticated transcript document and navigates Watch and Download using their signed URL modes", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const client: SpaceRecordingHistoryClient = {
      createRecordingDownloadURL: vi.fn(async ({ download }) => ({
        expires_at: "2026-09-22T10:00:00Z",
        method: "GET",
        signed_at: "2026-09-22T09:00:00Z",
        signed_headers: {},
        url: download ? "#download-recording" : "#watch-recording",
      })),
      getRecording: vi.fn(),
      getTranscriptDocument: vi.fn(async () => ({
        cues: [
          {
            end_ms: 900,
            identity: null,
            overlap: false,
            start_ms: 0,
            text: "A real transcript cue.",
          },
          { end_ms: 1_600, identity: null, overlap: false, start_ms: 1_000, text: "Another cue." },
        ],
        episode_id: episodeID,
        recording_id: recordingID,
        schema_version: "transcript.v1",
        transcript_id: transcriptID,
      })),
      listRecordingTranscripts: vi.fn(async () => ({
        pagination: { has_more: false, next_cursor: null, page_size: 2 },
        transcripts: [completedTranscript],
      })),
      listSpaceRecordings: vi.fn(async () => ({
        pagination: { has_more: false, next_cursor: null, page_size: 20 },
        recordings: [recording],
      })),
      requestRecordingExport: vi.fn(async () => ({
        export: readyRecording.export,
        recording: readyRecording,
      })),
      requestRecordingTranscript: vi.fn(),
    };

    render(<SpaceRecordingHistorySection client={client} spaceID={spaceID} tenantID={tenantID} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Read transcript 44444444" })).toBeTruthy());
    expect(screen.getByText(/Video is prepared only when you watch or download it\./)).toBeTruthy();
    expect(client.requestRecordingExport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Read transcript 44444444" }));
    await waitFor(() => expect(client.getTranscriptDocument).toHaveBeenCalledWith({ tenantID, transcriptID }));
    expect(await screen.findByText(/A real transcript cue\./)).toBeTruthy();
    expect(screen.queryByText("display_name")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Watch recording 44444444" }));
    await waitFor(() => expect(client.requestRecordingExport).toHaveBeenCalledWith({ recordingID, tenantID }));
    await waitFor(() =>
      expect(client.createRecordingDownloadURL).toHaveBeenCalledWith({
        download: false,
        expiresInSeconds: 300,
        recordingID,
        tenantID,
      }),
    );
    expect(window.location.hash).toBe("#watch-recording");
    expect(open).not.toHaveBeenCalled();
    expect(client.getRecording).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Download recording 44444444" }));
    await waitFor(() =>
      expect(client.createRecordingDownloadURL).toHaveBeenLastCalledWith({
        download: true,
        expiresInSeconds: 300,
        recordingID,
        tenantID,
      }),
    );
    await waitFor(() => expect(window.location.hash).toBe("#download-recording"));
    expect(client.requestRecordingExport).toHaveBeenCalledTimes(1);
  });

  it("requests an eligible transcript and refreshes a long-pending video without creating another export", async () => {
    const pendingRecording = { ...recording, export: { retryable: false, status: "pending" }, status: "pending" };
    const acceptedTranscript = { ...completedTranscript, status: "pending" };
    const client: SpaceRecordingHistoryClient = {
      createRecordingDownloadURL: vi.fn(),
      getRecording: vi.fn(async () => readyRecording),
      getTranscriptDocument: vi.fn(),
      listRecordingTranscripts: vi.fn(async () => ({
        pagination: { has_more: false, next_cursor: null, page_size: 2 },
        transcripts: [],
      })),
      listSpaceRecordings: vi.fn(async () => historyPage([pendingRecording])),
      requestRecordingExport: vi.fn(),
      requestRecordingTranscript: vi.fn(async () => ({
        job_id: "66666666-6666-4666-8666-666666666666",
        status: "pending",
        transcript: acceptedTranscript,
      })),
    };

    render(<SpaceRecordingHistorySection client={client} spaceID={spaceID} tenantID={tenantID} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Request transcript 44444444" })).toBeTruthy());
    expect(client.requestRecordingExport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Request transcript 44444444" }));
    await waitFor(() => expect(client.requestRecordingTranscript).toHaveBeenCalledWith({ recordingID, tenantID }));

    fireEvent.click(screen.getByRole("button", { name: "Check video status 44444444" }));
    await waitFor(() => expect(client.getRecording).toHaveBeenCalledWith({ recordingID, tenantID }));
    expect(screen.getByText("ready")).toBeTruthy();
    expect(client.requestRecordingExport).not.toHaveBeenCalled();
  });

  it("uses frozen policy and audio preparation state for transcript recovery", async () => {
    const onDemandRecording = {
      ...recording,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      status: "pending",
      transcription_policy: "on_demand",
    };
    const automaticRecording = {
      ...recording,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      status: "pending",
      transcription_policy: "automatic",
    };
    const disabledRecording = {
      ...recording,
      id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
      transcription_policy: "disabled",
      transcription_preparation: { status: "none" },
    };
    const failedAutomaticRecording = {
      ...recording,
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
      transcription_policy: "automatic",
    };
    const failedAutomaticTranscript = {
      ...completedTranscript,
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
      recording_id: failedAutomaticRecording.id,
      status: "failed",
    };
    const preparingAutomaticRecording = {
      ...automaticRecording,
      id: "ffffffff-ffff-4fff-8fff-fffffffffff1",
      transcription_preparation: { status: "pending" },
    };
    const failedPreparationRecording = {
      ...automaticRecording,
      id: "11111111-1111-4111-8111-111111111112",
      transcription_preparation: { status: "failed" },
    };
    const expiredOnDemandRecording = {
      ...onDemandRecording,
      id: "22222222-2222-4222-8222-222222222223",
      source: { ...onDemandRecording.source, status: "expired" },
      transcription_preparation: { status: "expired" },
    };
    const unavailableOnDemandRecording = {
      ...onDemandRecording,
      id: "33333333-3333-4333-8333-333333333334",
      transcription_preparation: { status: "none" },
    };
    const client: SpaceRecordingHistoryClient = {
      createRecordingDownloadURL: vi.fn(),
      getRecording: vi.fn(),
      getTranscriptDocument: vi.fn(),
      listRecordingTranscripts: vi.fn(async (input) => ({
        pagination: { has_more: false, next_cursor: null, page_size: 2 },
        transcripts: input.recordingID === failedAutomaticRecording.id ? [failedAutomaticTranscript] : [],
      })),
      listSpaceRecordings: vi.fn(async () => historyPage([onDemandRecording, automaticRecording, disabledRecording, failedAutomaticRecording, preparingAutomaticRecording, failedPreparationRecording, expiredOnDemandRecording, unavailableOnDemandRecording])),
      requestRecordingExport: vi.fn(),
      requestRecordingTranscript: vi.fn(),
    };

    render(<SpaceRecordingHistorySection client={client} spaceID={spaceID} tenantID={tenantID} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Request transcript aaaaaaaa" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Request transcript bbbbbbbb" })).toBeTruthy();
    expect(screen.getByText("Transcript aaaaaaaa: requestable")).toBeTruthy();
    expect(screen.getByText("Transcript bbbbbbbb: requestable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Request transcript cccccccc" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request transcript dddddddd" })).toBeNull();
    expect(screen.getByText("Transcript cccccccc: none")).toBeTruthy();
    expect(screen.getByText("Transcript dddddddd: failed")).toBeTruthy();
    expect(screen.getByText("Transcript ffffffff: pending")).toBeTruthy();
    expect(screen.getByText("Transcript 11111111: failed")).toBeTruthy();
    expect(screen.getByText("Transcript 22222222: unavailable")).toBeTruthy();
    expect(screen.getByText("Transcript 33333333: unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Request transcript ffffffff" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request transcript 22222222" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request transcript 33333333" })).toBeNull();
    expect(client.requestRecordingTranscript).not.toHaveBeenCalled();
  });

  it("does not append a stale load-more page after the Space changes", async () => {
    const spaceA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const spaceB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const recordingA = {
      ...recording,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      space_id: spaceA,
    };
    const recordingALater = {
      ...recording,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      space_id: spaceA,
    };
    const recordingB = {
      ...recording,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      space_id: spaceB,
    };
    let resolveDelayedPage: ((value: ReturnType<typeof historyPage>) => void) | undefined;
    const delayedPage = new Promise<ReturnType<typeof historyPage>>((resolve) => {
      resolveDelayedPage = resolve;
    });
    const client: SpaceRecordingHistoryClient = {
      createRecordingDownloadURL: vi.fn(),
      getRecording: vi.fn(),
      getTranscriptDocument: vi.fn(),
      listRecordingTranscripts: vi.fn(async () => ({
        pagination: { has_more: false, next_cursor: null, page_size: 2 },
        transcripts: [],
      })),
      listSpaceRecordings: vi.fn((input) => {
        if (input.spaceID === spaceA && input.cursor === undefined) return Promise.resolve(historyPage([recordingA], true, "space-a-next"));
        if (input.spaceID === spaceA) return delayedPage;
        return Promise.resolve(historyPage([recordingB]));
      }),
      requestRecordingExport: vi.fn(),
      requestRecordingTranscript: vi.fn(),
    };
    const rendered = render(<SpaceRecordingHistorySection client={client} spaceID={spaceA} tenantID={tenantID} />);

    await waitFor(() => expect(screen.getByText(recordingA.id)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(client.listSpaceRecordings).toHaveBeenCalledWith({
        cursor: "space-a-next",
        pageSize: 20,
        spaceID: spaceA,
        tenantID,
      }),
    );

    rendered.rerender(<SpaceRecordingHistorySection client={client} spaceID={spaceB} tenantID={tenantID} />);
    await waitFor(() => expect(screen.getByText(recordingB.id)).toBeTruthy());
    await act(async () => {
      if (!resolveDelayedPage) throw new Error("Load-more request was not started.");
      resolveDelayedPage(historyPage([recordingALater]));
      await Promise.resolve();
    });

    expect(screen.getByText(recordingB.id)).toBeTruthy();
    expect(screen.queryByText(recordingA.id)).toBeNull();
    expect(screen.queryByText(recordingALater.id)).toBeNull();
  });
});
