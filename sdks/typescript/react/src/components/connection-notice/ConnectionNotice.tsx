import { ConnectionBars } from "./ConnectionBars";

export type ConnectionNoticeReason = "loss" | "latency" | "bandwidth" | "sync";

export interface ConnectionNoticeProps {
  readonly tier: "weak" | "poor";
  /** Names the cause of a weak link. A very poor link never names one, because the advice is the same. */
  readonly reason?: ConnectionNoticeReason;
  readonly videoOn: boolean;
  readonly onOpenDetails: () => void;
  readonly onTurnOffVideo: () => void;
}

const WHY: Readonly<Record<ConnectionNoticeReason, string>> = {
  loss: "Audio may break up",
  latency: "Slow to respond",
  bandwidth: "Video may look blurry",
  sync: "Chat and reactions are slow",
};

/** One quiet pill in the header while the link is bad. It opens the connection details, which explain the cause. */
export function ConnectionNotice({ tier, reason, videoOn, onOpenDetails, onTurnOffVideo }: ConnectionNoticeProps) {
  const poor = tier === "poor";
  const what = poor ? "Very poor connection" : "Weak connection";
  const why = poor || reason === undefined ? null : WHY[reason];
  return (
    <div role="status" aria-live="polite" data-part="connection-notice" data-tier={tier} className="chalk-connection-notice">
      <style href="chalk-connection-notice" precedence="default">
        {NOTICE_CSS}
      </style>
      <button type="button" className="chalk-connection-notice-main" aria-label={[what, why, "Open connection details"].filter(Boolean).join(". ")} onClick={onOpenDetails}>
        <ConnectionBars level={poor ? 1 : 2} />
        <span className="chalk-connection-notice-what">{what}</span>
      </button>
      {poor && videoOn ? (
        <button type="button" className="chalk-connection-notice-act" onClick={onTurnOffVideo}>
          Turn off video
        </button>
      ) : null}
    </div>
  );
}

const NOTICE_CSS = `.chalk-connection-notice {display:inline-flex;align-items:center;gap:var(--space-1);height:32px;max-width:100%;min-width:0;padding:0;border-radius:var(--corner-pill);background:var(--chalk-raised);font-size:var(--type-body-sm);pointer-events:auto;}
.chalk-connection-notice:has(.chalk-connection-notice-act) {padding-inline-end:var(--space-1);}
.chalk-connection-notice-main {display:inline-flex;align-items:center;gap:var(--space-2);min-width:0;height:32px;padding:0 var(--space-3) 0 var(--space-2-5);border-radius:var(--corner-pill);transition:background-color 150ms ease-out;}
.chalk-connection-notice-main:hover {background:var(--chalk-hover);}
.chalk-connection-notice-what {font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.chalk-connection-notice[data-tier="poor"] .chalk-connection-notice-what {color:var(--chalk-danger-text);}
.chalk-connection-notice-act {height:24px;padding:0 var(--space-2-5);border-radius:var(--corner-pill);background:var(--chalk-text);color:var(--chalk-canvas);font-size:var(--type-caption);font-weight:600;white-space:nowrap;flex:none;}
@media (prefers-reduced-motion: no-preference) {
  .chalk-connection-notice {animation:chalk-connection-notice-in 180ms ease-out;}
}
@keyframes chalk-connection-notice-in {from {opacity:0;transform:translateY(-4px);}}
.chalk-connection-notice-slot {min-width:0;pointer-events:auto;}
.chalk-connection-notice-slot[data-phone] {position:absolute;top:52px;left:var(--space-3);right:var(--space-3);display:flex;}
.chalk-frame.chalk-frame:has(.chalk-connection-notice-slot[data-phone]) .chalk-stage-layout {top:92px;}
`;
