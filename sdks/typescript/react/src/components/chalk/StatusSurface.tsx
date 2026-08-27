"use client";

import type React from "react";

import type { EpisodeSummary } from "@q9labsai/chalk-client";

import { CheckmarkCircle02Icon, Clock01Icon, Radio01Icon, UserGroupIcon } from "../../utils/icons";
import { ChalkBadge, ChalkButton, ChalkPanel } from "../chalk-ui";
import { useSkin } from "../skin-context";

export type StatusSurfacePhase = "leaving" | "left" | "episode-ended" | "failed";

export interface StatusSurfaceProps {
  readonly message: string;
  readonly onRetry?: () => void;
  /** Lifecycle state used to decorate completed leave and natural Episode-end surfaces. */
  readonly phase?: StatusSurfacePhase;
  readonly spaceName?: string;
  readonly episode?: EpisodeSummary | null;
  readonly endedAt?: string | null;
  /** Optional values are shown only when the root has measured and supplied them. */
  readonly durationSeconds?: number | null;
  readonly participantCount?: number | null;
  readonly retryPending?: boolean;
  readonly retryError?: string | null;
}

/** The shared lifecycle status surface used by Chalk and its preview adapter. */
export function StatusSurface({ message, onRetry, phase = "failed", spaceName, episode, endedAt, durationSeconds, participantCount, retryPending = false, retryError }: StatusSurfaceProps): React.JSX.Element {
  const skin = useSkin();
  const isExitSummary = phase === "left" || phase === "episode-ended";
  const title = phase === "left" ? "You left this Space" : phase === "episode-ended" ? "Episode ended" : null;
  const canShowEpisodeDetails = isExitSummary && Boolean(episode?.id || episode?.startedAt || endedAt || (durationSeconds !== undefined && durationSeconds !== null) || (participantCount !== undefined && participantCount !== null));
  const measuredDuration = durationSeconds ?? episodeDurationSeconds(episode?.startedAt, endedAt);
  const retryLabel = "Try again";

  return (
    <main data-chalk-skin={skin} data-chalk-status={phase} className="grid h-full min-h-0 place-items-center bg-[var(--chalk-canvas)] p-6 text-[var(--chalk-text)]">
      <ChalkPanel className="w-full max-w-lg text-center" contentClassName="grid justify-items-center gap-5">
        {isExitSummary ? (
          <ChalkBadge tone={phase === "episode-ended" ? "accent" : "success"} className="!h-14 !w-14 !rounded-full !p-0 text-[var(--chalk-accent-text)]">
            <span aria-hidden="true">{phase === "episode-ended" ? <Radio01Icon size={26} /> : <CheckmarkCircle02Icon size={26} />}</span>
          </ChalkBadge>
        ) : null}

        <div className="grid justify-items-center gap-2">
          {title ? <h1 className="text-xl font-semibold tracking-[-0.025em] text-[var(--chalk-text)]">{title}</h1> : null}
          <p role="status" className="text-sm leading-6 text-[var(--chalk-muted-text)]">
            {message}
          </p>
          {isExitSummary && spaceName ? <p className="text-xs text-[var(--chalk-muted-text)]">{spaceName}</p> : null}
        </div>

        {canShowEpisodeDetails ? (
          <dl className="grid w-full gap-2 rounded-lg border border-[var(--chalk-line)] bg-[var(--chalk-canvas)]/45 p-3 text-left text-xs text-[var(--chalk-muted-text)] sm:grid-cols-2">
            {episode?.id ? (
              <div className="min-w-0 sm:col-span-2">
                <dt className="font-semibold uppercase tracking-[0.08em]">Episode</dt>
                <dd className="mt-1 truncate font-mono text-[var(--chalk-text)]">{episode.id}</dd>
              </div>
            ) : null}
            {episode?.startedAt ? <SummaryMetric label="Started" value={formatTimestamp(episode.startedAt)} /> : null}
            {endedAt ? <SummaryMetric label="Ended" value={formatTimestamp(endedAt)} /> : null}
            {measuredDuration !== null ? <SummaryMetric label="Duration" value={formatDuration(measuredDuration)} icon={<Clock01Icon size={14} />} /> : null}
            {participantCount !== undefined && participantCount !== null ? <SummaryMetric label="Participants" value={String(participantCount)} icon={<UserGroupIcon size={14} />} /> : null}
          </dl>
        ) : null}

        {retryError ? (
          <p role="alert" className="w-full rounded-lg border border-[var(--chalk-danger)]/35 bg-[var(--chalk-danger-surface)] px-3 py-2 text-left text-sm text-[var(--chalk-danger)]">
            {retryError}
          </p>
        ) : null}

        {onRetry ? (
          <ChalkButton type="button" onClick={onRetry} disabled={retryPending} loading={retryPending} variant="solid" tone="accent" aria-label={retryLabel} className="text-sm font-semibold text-[var(--chalk-accent-text)]">
            {retryLabel}
          </ChalkButton>
        ) : null}
      </ChalkPanel>
    </main>
  );
}

function SummaryMetric({ icon, label, value }: { readonly icon?: React.ReactNode; readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="flex items-center gap-1 font-semibold uppercase tracking-[0.08em]">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 text-[var(--chalk-text)]">{value}</dd>
    </div>
  );
}

function episodeDurationSeconds(startedAt: string | null | undefined, endedAt: string | null | undefined): number | null {
  if (!startedAt || !endedAt) return null;
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null;
  return Math.round((ended - started) / 1000);
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function formatDuration(seconds: number): string {
  const roundedSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(roundedSeconds / 3600);
  const minutes = Math.floor((roundedSeconds % 3600) / 60);
  const remainingSeconds = roundedSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}
