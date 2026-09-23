import { RecordingHistoryPanel, type RecordingHistoryAction, type RecordingHistoryItem } from "@q9labsai/chalk-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DashboardAPIError,
  createRecordingDownloadURL,
  getRecording,
  getTranscriptDocument,
  listRecordingTranscripts,
  listSpaceRecordings,
  requestRecordingExport,
  requestRecordingTranscript,
  type DashboardPagination,
  type DashboardRecording,
  type DashboardRecordingDownloadURL,
  type DashboardRecordingExportRequestAcceptedResponse,
  type DashboardRecordingList,
  type DashboardTranscript,
  type DashboardTranscriptDocument,
  type DashboardTranscriptList,
  type DashboardTranscriptRequestAcceptedResponse,
} from "../../lib/dashboard-api";

const HISTORY_PAGE_SIZE = 20;
const VIDEO_URL_LIFETIME_SECONDS = 300;
const EXPORT_POLL_ATTEMPTS = 8;
const EXPORT_POLL_INTERVAL_MS = 2_000;

type RecordingHistoryEntry = {
  readonly recording: DashboardRecording;
  readonly transcript?: DashboardTranscript;
};

type RecordingHistoryPage = {
  readonly entries: readonly RecordingHistoryEntry[];
  readonly pagination: DashboardPagination;
};

type RecordingHistoryContext = {
  readonly client: SpaceRecordingHistoryClient;
  readonly generation: number;
  readonly reloadGeneration: number;
  readonly spaceID: string;
  readonly tenantID: string;
};

export type SpaceRecordingHistoryClient = {
  readonly createRecordingDownloadURL: (input: { tenantID: string; recordingID: string; expiresInSeconds: number; download: boolean }) => Promise<DashboardRecordingDownloadURL>;
  readonly getRecording: (input: { tenantID: string; recordingID: string }) => Promise<DashboardRecording>;
  readonly getTranscriptDocument: (input: { tenantID: string; transcriptID: string }) => Promise<DashboardTranscriptDocument>;
  readonly listRecordingTranscripts: (input: { tenantID: string; recordingID: string; cursor?: string; pageSize?: number }) => Promise<DashboardTranscriptList>;
  readonly listSpaceRecordings: (input: { tenantID: string; spaceID: string; cursor?: string; pageSize?: number }) => Promise<DashboardRecordingList>;
  readonly requestRecordingExport: (input: { tenantID: string; recordingID: string }) => Promise<DashboardRecordingExportRequestAcceptedResponse>;
  readonly requestRecordingTranscript: (input: { tenantID: string; recordingID: string }) => Promise<DashboardTranscriptRequestAcceptedResponse>;
};

const defaultSpaceRecordingHistoryClient: SpaceRecordingHistoryClient = {
  createRecordingDownloadURL,
  getRecording,
  getTranscriptDocument,
  listRecordingTranscripts,
  listSpaceRecordings,
  requestRecordingExport,
  requestRecordingTranscript,
};

export function SpaceRecordingHistorySection({ tenantID, spaceID, client = defaultSpaceRecordingHistoryClient }: { readonly tenantID: string; readonly spaceID: string; readonly client?: SpaceRecordingHistoryClient }) {
  const [entries, setEntries] = useState<readonly RecordingHistoryEntry[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<DashboardPagination | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const [requestingExportRecordingID, setRequestingExportRecordingID] = useState<string | null>(null);
  const [requestingTranscriptRecordingID, setRequestingTranscriptRecordingID] = useState<string | null>(null);
  const [refreshingExportRecordingID, setRefreshingExportRecordingID] = useState<string | null>(null);
  const [accessingVideoRecordingID, setAccessingVideoRecordingID] = useState<string | null>(null);
  const [readingTranscriptRecordingID, setReadingTranscriptRecordingID] = useState<string | null>(null);
  const [transcriptTextByRecordingID, setTranscriptTextByRecordingID] = useState<ReadonlyMap<string, string>>(new Map());
  const [actionError, setActionError] = useState<string | null>(null);
  const active = useRef(true);
  const context = useRef<RecordingHistoryContext>({
    client,
    generation: 0,
    reloadGeneration,
    spaceID,
    tenantID,
  });
  if (context.current.client !== client || context.current.reloadGeneration !== reloadGeneration || context.current.spaceID !== spaceID || context.current.tenantID !== tenantID) {
    context.current = {
      client,
      generation: context.current.generation + 1,
      reloadGeneration,
      spaceID,
      tenantID,
    };
  }

  const isCurrentContext = useCallback((generation: number) => active.current && context.current.generation === generation, []);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    const generation = context.current.generation;
    setLoadState("loading");
    setLoadError(null);
    setActionError(null);
    setEntries([]);
    setPagination(null);
    setTranscriptTextByRecordingID(new Map());
    void loadRecordingHistoryPage(client, tenantID, spaceID, () => isCurrentContext(generation)).then(
      (page) => {
        if (!page || !isCurrentContext(generation)) return;
        setEntries(page.entries);
        setPagination(page.pagination);
        setLoadState("ready");
      },
      (cause: unknown) => {
        if (!isCurrentContext(generation)) return;
        setLoadError(historyErrorMessage(cause, "Episode history could not be loaded."));
        setLoadState("error");
      },
    );
  }, [client, isCurrentContext, reloadGeneration, spaceID, tenantID]);

  const recordings = useMemo(() => entries.map((entry) => recordingHistoryItem(entry, transcriptTextByRecordingID.get(entry.recording.id))), [entries, transcriptTextByRecordingID]);

  const replaceRecording = useCallback(
    (recording: DashboardRecording, generation: number) => {
      if (!isCurrentContext(generation)) return;
      setEntries((current) => current.map((entry) => (entry.recording.id === recording.id ? { ...entry, recording } : entry)));
    },
    [isCurrentContext],
  );

  const replaceTranscript = useCallback(
    (recordingID: string, transcript: DashboardTranscript, generation: number) => {
      if (!isCurrentContext(generation)) return;
      setEntries((current) => current.map((entry) => (entry.recording.id === recordingID ? { ...entry, transcript } : entry)));
    },
    [isCurrentContext],
  );

  const loadMore = useCallback(() => {
    const cursor = pagination?.next_cursor;
    if (!cursor || loadingMore) return;
    const generation = context.current.generation;
    setLoadingMore(true);
    setActionError(null);
    void loadRecordingHistoryPage(client, tenantID, spaceID, () => isCurrentContext(generation), cursor).then(
      (page) => {
        if (!page || !isCurrentContext(generation)) return;
        setEntries((current) => [...current, ...page.entries]);
        setPagination(page.pagination);
        setLoadingMore(false);
      },
      (cause: unknown) => {
        if (!isCurrentContext(generation)) return;
        setActionError(historyErrorMessage(cause, "More Episode history could not be loaded."));
        setLoadingMore(false);
      },
    );
  }, [client, isCurrentContext, loadingMore, pagination?.next_cursor, spaceID, tenantID]);

  const accessVideo = useCallback(
    async (recording: RecordingHistoryItem, action: "watch" | "download") => {
      const generation = context.current.generation;
      setActionError(null);
      setAccessingVideoRecordingID(recording.id);
      try {
        const descriptor = await client.createRecordingDownloadURL({
          tenantID,
          recordingID: recording.id,
          expiresInSeconds: VIDEO_URL_LIFETIME_SECONDS,
          download: action === "download",
        });
        if (!isCurrentContext(generation)) return;
        navigateToVideo(descriptor.url);
      } catch (cause) {
        if (isCurrentContext(generation)) setActionError(historyErrorMessage(cause, "Video could not be opened."));
      } finally {
        if (isCurrentContext(generation)) setAccessingVideoRecordingID(null);
      }
    },
    [client, isCurrentContext, tenantID],
  );

  const requestExport = useCallback(
    async (recording: RecordingHistoryItem, action: RecordingHistoryAction) => {
      const generation = context.current.generation;
      setActionError(null);
      setRequestingExportRecordingID(recording.id);
      try {
        const response = await client.requestRecordingExport({
          tenantID,
          recordingID: recording.id,
        });
        replaceRecording(response.recording, generation);
        const latest = await waitForExport(client, tenantID, response.recording, () => isCurrentContext(generation));
        if (!latest || !isCurrentContext(generation)) return;
        replaceRecording(latest, generation);
        if (latest.export.status === "ready") await accessVideo(recording, action);
      } catch (cause) {
        if (isCurrentContext(generation)) setActionError(historyErrorMessage(cause, "Video could not be requested."));
      } finally {
        if (isCurrentContext(generation)) setRequestingExportRecordingID(null);
      }
    },
    [accessVideo, client, isCurrentContext, replaceRecording, tenantID],
  );

  const refreshExportStatus = useCallback(
    async (recording: RecordingHistoryItem) => {
      const generation = context.current.generation;
      setActionError(null);
      setRefreshingExportRecordingID(recording.id);
      try {
        const latest = await client.getRecording({ tenantID, recordingID: recording.id });
        replaceRecording(latest, generation);
      } catch (cause) {
        if (isCurrentContext(generation)) setActionError(historyErrorMessage(cause, "Video status could not be refreshed."));
      } finally {
        if (isCurrentContext(generation)) setRefreshingExportRecordingID(null);
      }
    },
    [client, isCurrentContext, replaceRecording, tenantID],
  );

  const requestTranscript = useCallback(
    async (recording: RecordingHistoryItem) => {
      const generation = context.current.generation;
      setActionError(null);
      setRequestingTranscriptRecordingID(recording.id);
      try {
        const response = await client.requestRecordingTranscript({
          tenantID,
          recordingID: recording.id,
        });
        replaceTranscript(recording.id, response.transcript, generation);
      } catch (cause) {
        if (isCurrentContext(generation)) setActionError(historyErrorMessage(cause, "Transcript could not be requested."));
      } finally {
        if (isCurrentContext(generation)) setRequestingTranscriptRecordingID(null);
      }
    },
    [client, isCurrentContext, replaceTranscript, tenantID],
  );

  const readTranscript = useCallback(
    async (recording: RecordingHistoryItem) => {
      const generation = context.current.generation;
      const transcript = entries.find((entry) => entry.recording.id === recording.id)?.transcript;
      if (!transcript) return;
      setActionError(null);
      setReadingTranscriptRecordingID(recording.id);
      try {
        const document = await client.getTranscriptDocument({
          tenantID,
          transcriptID: transcript.id,
        });
        if (!isCurrentContext(generation)) return;
        setTranscriptTextByRecordingID((current) => new Map(current).set(recording.id, transcriptText(document)));
      } catch (cause) {
        if (isCurrentContext(generation)) setActionError(historyErrorMessage(cause, "Transcript could not be read."));
      } finally {
        if (isCurrentContext(generation)) setReadingTranscriptRecordingID(null);
      }
    },
    [client, entries, isCurrentContext, tenantID],
  );

  return (
    <section className="space-detail-episodes" aria-labelledby="space-artifact-history-heading">
      <div className="space-detail-section-heading">
        <div>
          <p className="eyebrow">Episode history</p>
          <h2 id="space-artifact-history-heading">Captures, transcripts, and video</h2>
          <p>Read a completed transcript independently. Video is prepared only when you watch or download it.</p>
        </div>
      </div>
      {actionError ? (
        <p className="space-detail-inline-error" role="alert">
          {actionError}
        </p>
      ) : null}
      <RecordingHistoryPanel
        recordings={recordings}
        isLoading={loadState === "loading" || loadingMore}
        error={loadState === "error" ? loadError : null}
        hasMore={pagination?.has_more === true}
        downloadingRecordingId={accessingVideoRecordingID}
        readingTranscriptRecordingId={readingTranscriptRecordingID}
        refreshingExportRecordingId={refreshingExportRecordingID}
        requestingExportRecordingId={requestingExportRecordingID}
        requestingTranscriptRecordingId={requestingTranscriptRecordingID}
        onDownload={(recording) => void accessVideo(recording, "download")}
        onLoadMore={loadMore}
        onReadTranscript={(recording) => void readTranscript(recording)}
        onRefreshExport={(recording) => void refreshExportStatus(recording)}
        onRequestExport={(recording, action) => void requestExport(recording, action)}
        onRequestTranscript={(recording) => void requestTranscript(recording)}
        onRetry={() => setReloadGeneration((generation) => generation + 1)}
        onWatch={(recording) => void accessVideo(recording, "watch")}
      />
    </section>
  );
}

async function loadRecordingHistoryPage(client: SpaceRecordingHistoryClient, tenantID: string, spaceID: string, isCurrent: () => boolean, cursor?: string): Promise<RecordingHistoryPage | undefined> {
  const recordings = await client.listSpaceRecordings({
    tenantID,
    spaceID,
    cursor,
    pageSize: HISTORY_PAGE_SIZE,
  });
  if (!isCurrent()) return undefined;
  const transcripts = await Promise.all(recordings.recordings.map((recording) => client.listRecordingTranscripts({ tenantID, recordingID: recording.id, pageSize: 2 })));
  if (!isCurrent()) return undefined;
  const entries = recordings.recordings.map((recording, index) => {
    const transcriptPage = transcripts.at(index);
    if (!transcriptPage) throw new Error("Transcript history did not match the recording page.");
    return {
      recording,
      ...(transcriptPage.transcripts[0] === undefined ? {} : { transcript: transcriptPage.transcripts[0] }),
    };
  });
  return { entries, pagination: recordings.pagination };
}

async function waitForExport(client: SpaceRecordingHistoryClient, tenantID: string, initial: DashboardRecording, isCurrent: () => boolean): Promise<DashboardRecording | undefined> {
  let recording = initial;
  for (let attempt = 0; attempt < EXPORT_POLL_ATTEMPTS && recording.export.status === "pending"; attempt += 1) {
    await delay(EXPORT_POLL_INTERVAL_MS);
    if (!isCurrent()) return undefined;
    recording = await client.getRecording({ tenantID, recordingID: recording.id });
    if (!isCurrent()) return undefined;
  }
  return recording;
}

function recordingHistoryItem(entry: RecordingHistoryEntry, text: string | undefined): RecordingHistoryItem {
  return {
    created_at: entry.recording.created_at,
    episode_id: entry.recording.episode_id,
    export: {
      failure_code: entry.recording.export.failure_code,
      failure_message: entry.recording.export.failure_message,
      retryable: entry.recording.export.retryable,
      source_expires_at: entry.recording.export.source_expires_at,
      status: exportStatus(entry.recording.export.status),
    },
    id: entry.recording.id,
    source: {
      expires_at: entry.recording.source.expires_at,
      status: sourceStatus(entry.recording.source.status),
    },
    status: recordingStatus(entry.recording.status),
    transcript:
      entry.transcript === undefined
        ? missingTranscript(entry.recording)
        : {
            source_expires_at: entry.transcript.source_expires_at,
            status: transcriptStatus(entry.transcript.status),
            ...(text === undefined ? {} : { text }),
          },
    updated_at: entry.recording.updated_at,
  };
}

function missingTranscript(recording: DashboardRecording): NonNullable<RecordingHistoryItem["transcript"]> {
  if (recording.transcription_policy === "disabled") return { status: "none" };
  if (recording.transcription_preparation.status === "ready") return { requestable: true, status: "requestable" };
  if (recording.transcription_preparation.status === "pending") return { status: "pending" };
  if (recording.transcription_preparation.status === "failed" || recording.source.status === "failed") return { status: "failed" };
  return { status: "unavailable" };
}

function recordingStatus(status: string): RecordingHistoryItem["status"] {
  if (status === "pending" || status === "processing" || status === "completed") return status;
  return "failed";
}

function sourceStatus(status: string): NonNullable<RecordingHistoryItem["source"]>["status"] {
  if (status === "pending" || status === "available" || status === "failed") return status;
  return "expired";
}

function transcriptStatus(status: string): NonNullable<RecordingHistoryItem["transcript"]>["status"] {
  if (status === "pending" || status === "processing" || status === "completed") return status;
  return "failed";
}

function exportStatus(status: string): NonNullable<RecordingHistoryItem["export"]>["status"] {
  if (status === "none" || status === "pending" || status === "ready" || status === "failed") return status;
  return "unavailable";
}

function transcriptText(document: DashboardTranscriptDocument): string {
  return document.cues
    .map((cue) => cue.text)
    .filter((text) => text.length > 0)
    .join("\n");
}

function historyErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof DashboardAPIError && cause.message ? cause.message : fallback;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function navigateToVideo(url: string): void {
  window.location.assign(url);
}
