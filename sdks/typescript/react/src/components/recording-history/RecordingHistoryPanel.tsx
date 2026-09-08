"use client";

import React from "react";

import { cn } from "../../utils/cn";
import { Download01Icon, Loading01Icon, RefreshIcon, Video01Icon } from "../../utils/icons";
import { ChalkBadge, ChalkButton, ChalkEmptyState, ChalkPanel } from "../chalk-ui";

export type RecordingHistoryStatus = "pending" | "processing" | "completed" | "failed";

/** The browser-safe subset returned by the server client's Recording list API. */
export interface RecordingHistoryItem {
  readonly created_at: string;
  readonly episode_id: string;
  readonly id: string;
  readonly status: RecordingHistoryStatus;
  readonly updated_at: string;
}

export interface RecordingHistoryPanelProps {
  readonly recordings: readonly RecordingHistoryItem[];
  readonly isLoading?: boolean;
  readonly error?: string | null;
  readonly hasMore?: boolean;
  readonly downloadingRecordingId?: string | null;
  readonly onDownload?: (recording: RecordingHistoryItem) => void;
  readonly onLoadMore?: () => void;
  readonly onRetry?: () => void;
  readonly className?: string;
}

const STATUS_LABELS: Readonly<Record<RecordingHistoryStatus, string>> = {
  pending: "Pending",
  processing: "Processing",
  completed: "Ready",
  failed: "Failed",
};

const STATUS_TONES = {
  pending: "neutral",
  processing: "accent",
  completed: "success",
  failed: "danger",
} as const;

export function RecordingHistoryPanel({ recordings, isLoading = false, error, hasMore = false, downloadingRecordingId, onDownload, onLoadMore, onRetry, className }: RecordingHistoryPanelProps): React.JSX.Element {
  return (
    <ChalkPanel className={cn("h-full min-h-0 w-full overflow-hidden bg-[var(--chalk-app-panel)] p-0", className)} contentClassName="flex h-full min-h-0 flex-col" role="region" aria-label="Recording history" seed="recording-history-panel">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--chalk-app-line)] px-4 py-3">
        <div>
          <h2 className="text-base font-semibold">Recordings</h2>
          <p className="mt-0.5 text-xs text-[var(--chalk-app-text-muted)]">Completed Episode recordings</p>
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
          <ChalkEmptyState title="No recordings yet" description="Completed recordings will appear here." seed="recording-history-empty">
            <Video01Icon className="mx-auto mt-4 size-8 text-[var(--chalk-app-text-muted)]" aria-hidden="true" />
          </ChalkEmptyState>
        ) : (
          <ul className="grid gap-2" aria-label="Recordings">
            {recordings.map((recording) => {
              const isDownloading = downloadingRecordingId === recording.id;
              return (
                <li key={recording.id}>
                  <ChalkPanel className="p-3" contentClassName="flex items-center gap-3" seed={`recording-${recording.id}`}>
                    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--chalk-app-control)] text-[var(--chalk-app-text-muted)]" aria-hidden="true">
                      <Video01Icon className="size-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">Recording {shortId(recording.id)}</span>
                        <ChalkBadge tone={STATUS_TONES[recording.status]} seed={`recording-status-${recording.id}`}>
                          {STATUS_LABELS[recording.status]}
                        </ChalkBadge>
                      </div>
                      <p className="mt-1 text-xs text-[var(--chalk-app-text-muted)]">
                        <time dateTime={recording.created_at}>{formatTimestamp(recording.created_at)}</time>
                      </p>
                    </div>
                    {recording.status === "completed" && onDownload ? (
                      <ChalkButton aria-label={`Download recording ${shortId(recording.id)}`} disabled={isDownloading} loading={isDownloading} onClick={() => onDownload(recording)} variant="ghost" className="shrink-0 px-3">
                        <Download01Icon className="size-4" />
                        <span className="hidden sm:inline">Download</span>
                      </ChalkButton>
                    ) : null}
                  </ChalkPanel>
                </li>
              );
            })}
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
