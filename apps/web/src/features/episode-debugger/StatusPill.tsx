import { StatusBadge, type StatusBadgeStatus } from "@q9labsai/chalk-ui";
import { stateTone } from "./model";

export function StatusPill({ state, label }: { state: string; label?: string }) {
  const tone = stateTone(state);
  const status: StatusBadgeStatus = tone === "live" ? "info" : tone;
  return (
    <StatusBadge className="episode-status-pill" data-tone={tone} status={status}>
      <span className="episode-status-dot" aria-hidden="true" />
      <span>{label ?? state.replaceAll("_", " ")}</span>
      <span className="sr-only"> state</span>
    </StatusBadge>
  );
}
