"use client";

import React from "react";

import { cn } from "../../utils/cn";
import { Download01Icon, FileTextIcon, Loading01Icon, PlayIcon, RefreshIcon, Video01Icon } from "../../utils/icons";
import { ChalkBadge, ChalkButton, ChalkEmptyState, ChalkPanel, type ChalkTone } from "../chalk-ui";

export type RecordingHistoryStatus = "pending" | "processing" | "completed" | "failed";
export type RecordingSourceStatus = "pending" | "available" | "failed" | "expired";
export type RecordingExportStatus = "none" | "pending" | "ready" | "failed" | "unavailable";
export type RecordingTranscriptStatus = "none" | "requestable" | "unavailable" | "pending" | "processing" | "completed" | "failed";
export type RecordingHistoryAction = "watch" | "download";

export interface RecordingHistorySource {
  readonly expires_at?: string | null;
  readonly status: RecordingSourceStatus;
}

export interface RecordingHistoryExport {
  readonly failure_code?: string | null;
  readonly failure_message?: string | null;
  readonly retryable: boolean;
  readonly source_expires_at?: string | null;
  readonly status: RecordingExportStatus;
}

export interface RecordingHistoryTranscript {
  /** The caller has confirmed this Capture can start a Transcript request. */
  readonly requestable?: boolean;
  readonly source_expires_at?: string | null;
  readonly status: RecordingTranscriptStatus;
  /** Transcript text is fetched only when a person asks to read it. */
  readonly text?: string;
}

/** A browser-safe view model with an independently supplied Transcript artifact. */
export interface RecordingHistoryItem {
  readonly created_at: string;
  readonly episode_id: string;
  readonly export?: RecordingHistoryExport;
  readonly id: string;
  readonly source?: RecordingHistorySource;
  readonly status: RecordingHistoryStatus;
  readonly transcript?: RecordingHistoryTranscript;
  readonly updated_at: string;
}

export interface RecordingHistoryPanelProps {
  readonly recordings: readonly RecordingHistoryItem[];
  readonly isLoading?: boolean;
  readonly error?: string | null;
  readonly hasMore?: boolean;
  readonly downloadingRecordingId?: string | null;
  readonly readingTranscriptRecordingId?: string | null;
  readonly refreshingExportRecordingId?: string | null;
  readonly requestingExportRecordingId?: string | null;
  readonly requestingTranscriptRecordingId?: string | null;
  readonly onDownload?: (recording: RecordingHistoryItem) => void;
  readonly onLoadMore?: () => void;
  readonly onReadTranscript?: (recording: RecordingHistoryItem) => void;
  /** Checks an already-requested video without creating another export. */
  readonly onRefreshExport?: (recording: RecordingHistoryItem) => void;
  readonly onRequestExport?: (recording: RecordingHistoryItem, action: RecordingHistoryAction) => void;
  readonly onRequestTranscript?: (recording: RecordingHistoryItem) => void;
  readonly onRetry?: () => void;
  readonly onWatch?: (recording: RecordingHistoryItem) => void;
  readonly className?: string;
}

export function RecordingHistoryPanel({
  recordings,
  isLoading = false,
  error,
  hasMore = false,
  downloadingRecordingId,
  readingTranscriptRecordingId,
  refreshingExportRecordingId,
  requestingExportRecordingId,
  requestingTranscriptRecordingId,
  onDownload,
  onLoadMore,
  onReadTranscript,
  onRefreshExport,
  onRequestExport,
  onRequestTranscript,
  onRetry,
  onWatch,
  className,
}: RecordingHistoryPanelProps): React.JSX.Element {
  return (
    <ChalkPanel className={cn("h-full min-h-0 w-full overflow-hidden bg-[var(--chalk-app-panel)] p-0", className)} contentClassName="flex h-full min-h-0 flex-col" role="region" aria-label="Recording history" seed="recording-history-panel">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--chalk-app-line)] px-4 py-3">
        <div>
          <h2 className="text-base font-semibold">Recordings</h2>
          <p className="mt-0.5 text-xs text-[var(--chalk-app-text-muted)]">Captured Episode activity</p>
        </div>
        {isLoading ? <Loading01Icon className="size-4 animate-spin text-[var(--chalk-app-text-muted)]" aria-label="Loading recordings" /> : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error ? (
          <ChalkEmptyState title="Recordings could not be loaded" description={error} tone="danger" seed="recording-history-error">
            {onRetry ? (
              <ChalkButton className="mt-4" onClick={onRetry} tone="danger">
                <RefreshIcon className="size-4" />
                Try again
              </ChalkButton>
            ) : null}
          </ChalkEmptyState>
        ) : recordings.length === 0 && !isLoading ? (
          <ChalkEmptyState title="No recordings yet" description="Captured Episode activity will appear here." seed="recording-history-empty">
            <Video01Icon className="mx-auto mt-4 size-8 text-[var(--chalk-app-text-muted)]" aria-hidden="true" />
          </ChalkEmptyState>
        ) : (
          <ul className="grid gap-2" aria-label="Recordings">
            {recordings.map((recording) => (
              <RecordingHistoryRow
                key={recording.id}
                recording={recording}
                downloading={downloadingRecordingId === recording.id}
                readingTranscript={readingTranscriptRecordingId === recording.id}
                refreshingExport={refreshingExportRecordingId === recording.id}
                requestingExport={requestingExportRecordingId === recording.id}
                requestingTranscript={requestingTranscriptRecordingId === recording.id}
                onDownload={onDownload}
                onReadTranscript={onReadTranscript}
                onRefreshExport={onRefreshExport}
                onRequestExport={onRequestExport}
                onRequestTranscript={onRequestTranscript}
                onWatch={onWatch}
              />
            ))}
          </ul>
        )}
      </div>

      {hasMore && !error ? (
        <footer className="border-t border-[var(--chalk-app-line)] p-3">
          <ChalkButton className="w-full" disabled={isLoading || !onLoadMore} loading={isLoading} onClick={onLoadMore}>
            Load more
          </ChalkButton>
        </footer>
      ) : null}
    </ChalkPanel>
  );
}

interface RecordingHistoryRowProps {
  readonly downloading: boolean;
  readonly readingTranscript: boolean;
  readonly onDownload: RecordingHistoryPanelProps["onDownload"];
  readonly onReadTranscript: RecordingHistoryPanelProps["onReadTranscript"];
  readonly onRefreshExport: RecordingHistoryPanelProps["onRefreshExport"];
  readonly onRequestExport: RecordingHistoryPanelProps["onRequestExport"];
  readonly onRequestTranscript: RecordingHistoryPanelProps["onRequestTranscript"];
  readonly onWatch: RecordingHistoryPanelProps["onWatch"];
  readonly recording: RecordingHistoryItem;
  readonly refreshingExport: boolean;
  readonly requestingExport: boolean;
  readonly requestingTranscript: boolean;
}

function RecordingHistoryRow({ downloading, onDownload, onReadTranscript, onRefreshExport, onRequestExport, onRequestTranscript, onWatch, readingTranscript, recording, refreshingExport, requestingExport, requestingTranscript }: RecordingHistoryRowProps): React.JSX.Element {
  return (
    <li>
      <ChalkPanel className="p-3" contentClassName="flex items-start gap-3" seed={`recording-${recording.id}`}>
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--chalk-app-control)] text-[var(--chalk-app-text-muted)]" aria-hidden="true">
          <Video01Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">Episode {shortId(recording.episode_id)}</span>
            {recording.export ? null : <StatusBadge label={legacyStatusLabel(recording.status)} tone={legacyStatusTone(recording.status)} seed={`recording-status-${recording.id}`} />}
          </div>
          <p className="mt-1 text-xs text-[var(--chalk-app-text-muted)]">
            <time dateTime={recording.created_at}>{formatTimestamp(recording.created_at)}</time>
          </p>
          {recording.export ? (
            <RecordingArtifactStatus
              downloading={downloading}
              onDownload={onDownload}
              onReadTranscript={onReadTranscript}
              onRefreshExport={onRefreshExport}
              onRequestExport={onRequestExport}
              onRequestTranscript={onRequestTranscript}
              onWatch={onWatch}
              readingTranscript={readingTranscript}
              recording={recording}
              refreshingExport={refreshingExport}
              requestingExport={requestingExport}
              requestingTranscript={requestingTranscript}
            />
          ) : (
            <LegacyRecordingActions downloading={downloading} onDownload={onDownload} recording={recording} />
          )}
        </div>
      </ChalkPanel>
    </li>
  );
}

interface RecordingArtifactStatusProps {
  readonly downloading: boolean;
  readonly onDownload: RecordingHistoryPanelProps["onDownload"];
  readonly onReadTranscript: RecordingHistoryPanelProps["onReadTranscript"];
  readonly onRefreshExport: RecordingHistoryPanelProps["onRefreshExport"];
  readonly onRequestExport: RecordingHistoryPanelProps["onRequestExport"];
  readonly onRequestTranscript: RecordingHistoryPanelProps["onRequestTranscript"];
  readonly onWatch: RecordingHistoryPanelProps["onWatch"];
  readonly readingTranscript: boolean;
  readonly recording: RecordingHistoryItem;
  readonly refreshingExport: boolean;
  readonly requestingExport: boolean;
  readonly requestingTranscript: boolean;
}

function RecordingArtifactStatus({ downloading, onDownload, onReadTranscript, onRefreshExport, onRequestExport, onRequestTranscript, onWatch, readingTranscript, recording, refreshingExport, requestingExport, requestingTranscript }: RecordingArtifactStatusProps): React.JSX.Element {
  const video = recording.export;
  if (!video) throw new Error("Recording export is required when rendering artifact status");
  const transcriptStatus = recording.transcript?.status === "none" && recording.transcript.requestable ? "requestable" : recording.transcript?.status;
  return (
    <div className="mt-3 grid gap-2 border-t border-[var(--chalk-app-line)] pt-3">
      {recording.source ? <ArtifactStatus icon={<Video01Icon className="size-4" />} label="Capture" detail={sourceDetail(recording.source)} status={sourceLabel(recording.source.status)} tone={sourceTone(recording.source.status)} seed={`capture-${recording.id}`} /> : null}
      {transcriptStatus ? <ArtifactStatus icon={<FileTextIcon className="size-4" />} label="Transcript" detail={transcriptDetail(transcriptStatus)} status={transcriptLabel(transcriptStatus)} tone={transcriptTone(transcriptStatus)} seed={`transcript-${recording.id}`} /> : null}
      {recording.transcript ? <TranscriptContent onReadTranscript={onReadTranscript} onRequestTranscript={onRequestTranscript} reading={readingTranscript} recording={recording} requestingTranscript={requestingTranscript} /> : null}
      <ArtifactStatus icon={<Video01Icon className="size-4" />} label="Video" detail={exportDetail(video)} status={exportLabel(video.status)} tone={exportTone(video.status)} seed={`video-${recording.id}`} />
      {video.status === "ready" ? <ReadyVideoActions downloading={downloading} onDownload={onDownload} onWatch={onWatch} recording={recording} /> : null}
      {video.status === "pending" ? <PendingVideoActions onRefreshExport={onRefreshExport} recording={recording} refreshingExport={refreshingExport} requestingExport={requestingExport} /> : null}
      {canRequestExport(video) ? <RequestedVideoActions onRequestExport={onRequestExport} recording={recording} requestingExport={requestingExport} /> : null}
    </div>
  );
}

interface TranscriptContentProps {
  readonly onReadTranscript: RecordingHistoryPanelProps["onReadTranscript"];
  readonly onRequestTranscript: RecordingHistoryPanelProps["onRequestTranscript"];
  readonly reading: boolean;
  readonly recording: RecordingHistoryItem;
  readonly requestingTranscript: boolean;
}

function TranscriptContent({ onReadTranscript, onRequestTranscript, reading, recording, requestingTranscript }: TranscriptContentProps): React.JSX.Element | null {
  const transcript = recording.transcript;
  if (!transcript) return null;
  if ((transcript.status === "none" || transcript.status === "requestable") && transcript.requestable && onRequestTranscript) {
    return (
      <div className="pt-1">
        <ChalkButton aria-label={`Request transcript ${shortId(recording.id)}`} disabled={requestingTranscript} loading={requestingTranscript} onClick={() => onRequestTranscript(recording)} variant="ghost" className="shrink-0 px-3">
          <FileTextIcon className="size-4" />
          Request transcript
        </ChalkButton>
      </div>
    );
  }
  if (transcript.status !== "completed") return null;
  if (transcript.text !== undefined) {
    return (
      <details className="rounded border border-[var(--chalk-app-line)] p-2">
        <summary className="cursor-pointer text-xs font-medium">Transcript</summary>
        <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-[var(--chalk-app-text-muted)]">{transcript.text}</p>
      </details>
    );
  }
  if (!onReadTranscript) return null;
  return (
    <div className="pt-1">
      <ChalkButton aria-label={`Read transcript ${shortId(recording.id)}`} disabled={reading} loading={reading} onClick={() => onReadTranscript(recording)} variant="ghost" className="shrink-0 px-3">
        <FileTextIcon className="size-4" />
        Read transcript
      </ChalkButton>
    </div>
  );
}

interface ArtifactStatusProps {
  readonly detail: string;
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly seed: string;
  readonly status: string;
  readonly tone: ChalkTone;
}

function ArtifactStatus({ detail, icon, label, seed, status, tone }: ArtifactStatusProps): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="mt-0.5 text-[var(--chalk-app-text-muted)]" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{label}</span>
          <StatusBadge label={status} tone={tone} seed={seed} />
        </div>
        <p className="mt-0.5 text-[var(--chalk-app-text-muted)]">{detail}</p>
      </div>
    </div>
  );
}

interface StatusBadgeProps {
  readonly label: string;
  readonly seed: string;
  readonly tone: ChalkTone;
}

function StatusBadge({ label, seed, tone }: StatusBadgeProps): React.JSX.Element {
  return (
    <ChalkBadge tone={tone} seed={seed}>
      {label}
    </ChalkBadge>
  );
}

interface ReadyVideoActionsProps {
  readonly downloading: boolean;
  readonly onDownload: RecordingHistoryPanelProps["onDownload"];
  readonly onWatch: RecordingHistoryPanelProps["onWatch"];
  readonly recording: RecordingHistoryItem;
}

function ReadyVideoActions({ downloading, onDownload, onWatch, recording }: ReadyVideoActionsProps): React.JSX.Element | null {
  if (!onDownload && !onWatch) return null;
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {onWatch ? (
        <ChalkButton aria-label={`Watch recording ${shortId(recording.id)}`} onClick={() => onWatch(recording)} variant="ghost" className="shrink-0 px-3">
          <PlayIcon className="size-4" />
          Watch
        </ChalkButton>
      ) : null}
      {onDownload ? (
        <ChalkButton aria-label={`Download recording ${shortId(recording.id)}`} disabled={downloading} loading={downloading} onClick={() => onDownload(recording)} variant="ghost" className="shrink-0 px-3">
          <Download01Icon className="size-4" />
          Download
        </ChalkButton>
      ) : null}
    </div>
  );
}

interface PendingVideoActionsProps {
  readonly onRefreshExport: RecordingHistoryPanelProps["onRefreshExport"];
  readonly recording: RecordingHistoryItem;
  readonly refreshingExport: boolean;
  readonly requestingExport: boolean;
}

function PendingVideoActions({ onRefreshExport, recording, refreshingExport, requestingExport }: PendingVideoActionsProps): React.JSX.Element | null {
  if (!onRefreshExport) return null;
  return (
    <div className="pt-1">
      <ChalkButton aria-label={`Check video status ${shortId(recording.id)}`} disabled={refreshingExport || requestingExport} loading={refreshingExport || requestingExport} onClick={() => onRefreshExport(recording)} variant="ghost" className="shrink-0 px-3">
        <RefreshIcon className="size-4" />
        Check video status
      </ChalkButton>
    </div>
  );
}

interface RequestedVideoActionsProps {
  readonly onRequestExport: RecordingHistoryPanelProps["onRequestExport"];
  readonly recording: RecordingHistoryItem;
  readonly requestingExport: boolean;
}

function RequestedVideoActions({ onRequestExport, recording, requestingExport }: RequestedVideoActionsProps): React.JSX.Element | null {
  if (!onRequestExport) return null;
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      <ChalkButton aria-label={`Watch recording ${shortId(recording.id)}`} disabled={requestingExport} loading={requestingExport} onClick={() => onRequestExport(recording, "watch")} variant="ghost" className="shrink-0 px-3">
        <PlayIcon className="size-4" />
        Watch
      </ChalkButton>
      <ChalkButton aria-label={`Download recording ${shortId(recording.id)}`} disabled={requestingExport} loading={requestingExport} onClick={() => onRequestExport(recording, "download")} variant="ghost" className="shrink-0 px-3">
        <Download01Icon className="size-4" />
        Download
      </ChalkButton>
    </div>
  );
}

interface LegacyRecordingActionsProps {
  readonly downloading: boolean;
  readonly onDownload: RecordingHistoryPanelProps["onDownload"];
  readonly recording: RecordingHistoryItem;
}

function LegacyRecordingActions({ downloading, onDownload, recording }: LegacyRecordingActionsProps): React.JSX.Element | null {
  if (recording.status !== "completed" || !onDownload) return null;
  return (
    <div className="pt-3">
      <ChalkButton aria-label={`Download recording ${shortId(recording.id)}`} disabled={downloading} loading={downloading} onClick={() => onDownload(recording)} variant="ghost" className="shrink-0 px-3">
        <Download01Icon className="size-4" />
        <span className="hidden sm:inline">Download</span>
      </ChalkButton>
    </div>
  );
}

function canRequestExport(value: RecordingHistoryExport): boolean {
  return value.status === "none" || (value.status === "failed" && value.retryable);
}

function legacyStatusLabel(status: RecordingHistoryStatus): string {
  if (status === "pending") return "Pending";
  if (status === "processing") return "Processing";
  if (status === "completed") return "Ready";
  return "Failed";
}

function legacyStatusTone(status: RecordingHistoryStatus): ChalkTone {
  if (status === "pending") return "neutral";
  if (status === "processing") return "accent";
  if (status === "completed") return "success";
  return "danger";
}

function sourceDetail(source: RecordingHistorySource): string {
  if (source.status === "available") return source.expires_at ? `Available until ${formatTimestamp(source.expires_at)}.` : "Available for transcript processing and a video request.";
  if (source.status === "pending") return "Capture is still being stored.";
  if (source.status === "failed") return "Capture failed. A transcript and video cannot be created.";
  return "Capture is no longer available.";
}

function transcriptDetail(status: RecordingTranscriptStatus): string {
  if (status === "none") return "Transcript was not enabled for this Episode.";
  if (status === "requestable") return "Transcript can be requested from this Capture.";
  if (status === "unavailable") return "Transcript cannot be requested from this Capture.";
  if (status === "pending") return "Transcript is waiting to be prepared.";
  if (status === "processing") return "Transcript is being prepared.";
  if (status === "completed") return "Transcript is ready.";
  return "Transcript could not be created.";
}

function exportDetail(value: RecordingHistoryExport): string {
  if (value.status === "none") return "A video will be prepared when you watch or download.";
  if (value.status === "pending") return "Video is being prepared.";
  if (value.status === "ready") return "Video is ready to watch or download.";
  if (value.status === "failed") return value.failure_message ?? "Video could not be prepared.";
  return "Video cannot be created because the capture is unavailable.";
}

function sourceTone(status: RecordingSourceStatus): ChalkTone {
  if (status === "available") return "success";
  if (status === "pending") return "accent";
  return "danger";
}

function sourceLabel(status: RecordingSourceStatus): string {
  if (status === "pending") return "Saving";
  if (status === "available") return "Available";
  if (status === "failed") return "Failed";
  return "Expired";
}

function transcriptTone(status: RecordingTranscriptStatus): ChalkTone {
  if (status === "none" || status === "requestable") return "neutral";
  if (status === "unavailable") return "danger";
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  return "accent";
}

function transcriptLabel(status: RecordingTranscriptStatus): string {
  if (status === "none") return "Not enabled";
  if (status === "requestable") return "Can request";
  if (status === "unavailable") return "Unavailable";
  if (status === "pending") return "Waiting";
  if (status === "processing") return "Preparing";
  if (status === "completed") return "Ready";
  return "Failed";
}

function exportTone(status: RecordingExportStatus): ChalkTone {
  if (status === "ready") return "success";
  if (status === "none") return "neutral";
  if (status === "pending") return "accent";
  return "danger";
}

function exportLabel(status: RecordingExportStatus): string {
  if (status === "none") return "Not requested";
  if (status === "pending") return "Preparing";
  if (status === "ready") return "Ready";
  if (status === "failed") return "Failed";
  return "Unavailable";
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const datePart = date.toISOString().slice(0, 10);
  const timePart = date.toISOString().slice(11, 16);
  return `${datePart} ${timePart} UTC`;
}

RecordingHistoryPanel.displayName = "RecordingHistoryPanel";
