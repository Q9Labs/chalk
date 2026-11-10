import { ConnectionBars } from "./ConnectionBars";

export type ConnectionNoticeReason = "loss" | "latency" | "bandwidth" | "sync";

export interface ConnectionNoticeProps {
  readonly tier: "weak" | "poor";
  /** Names the cause of a weak link. A very poor link never names one, because the advice is the same. */
  readonly reason?: ConnectionNoticeReason;
  readonly videoOn: boolean;
  readonly onOpenDetails: () => void;
  readonly onTurnOffVideo: () => void;
  readonly onDismiss: () => void;
}

const WHY: Readonly<Record<ConnectionNoticeReason, string>> = {
  loss: "Audio may break up",
  latency: "Slow to respond",
  bandwidth: "Video may look blurry",
  sync: "Chat and reactions are slow",
};

/** One pill in the header: how bad the link is, what it means for the person, and one action. */
export function ConnectionNotice({ tier, reason, videoOn, onOpenDetails, onTurnOffVideo, onDismiss }: ConnectionNoticeProps) {
  const poor = tier === "poor";
  const what = poor ? "Very poor connection" : "Weak connection";
  const why = poor || reason === undefined ? null : WHY[reason];
  const offersVideoOff = poor && videoOn;
  return (
    <div role="status" aria-live="polite" data-part="connection-notice" data-tier={tier} className="chalk-connection-notice">
      <style href="chalk-connection-notice" precedence="default">
        {NOTICE_CSS}
      </style>
      <button type="button" className="chalk-connection-notice-main" aria-label={[what, why, "Open connection details"].filter(Boolean).join(". ")} onClick={onOpenDetails}>
        <ConnectionBars level={poor ? 1 : 2} />
        <span className="chalk-connection-notice-what">{what}</span>
        {why ? <span className="chalk-connection-notice-why">{why}</span> : null}
        {offersVideoOff ? null : (
          <span className="chalk-connection-notice-go" aria-hidden="true">
            {poor ? "Details" : null}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="m9 6 6 6-6 6" />
            </svg>
          </span>
        )}
      </button>
      {offersVideoOff ? (
        <button type="button" className="chalk-connection-notice-act" onClick={onTurnOffVideo}>
          Turn off video
        </button>
      ) : null}
      <button type="button" className="chalk-connection-notice-x" aria-label="Dismiss" onClick={onDismiss}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
          <path d="m6 6 12 12M6 18 18 6" />
        </svg>
      </button>
    </div>
  );
}

const NOTICE_CSS = `.chalk-connection-notice {display:inline-flex;align-items:center;gap:var(--space-1);height:36px;max-width:100%;min-width:0;padding:0 var(--space-1) 0 0;border-radius:var(--corner-pill);background:var(--chalk-raised);box-shadow:0 0 0 1px var(--chalk-line-strong);font-size:var(--type-body-sm);pointer-events:auto;}
.chalk-connection-notice-main {display:inline-flex;align-items:center;gap:var(--space-2);flex:0 1 auto;min-width:0;height:36px;padding:0 var(--space-2) 0 var(--space-3);border-radius:var(--corner-pill);}
.chalk-connection-notice-main:hover {background:var(--chalk-hover);}
.chalk-connection-notice-what {font-weight:600;white-space:nowrap;}
.chalk-connection-notice-why {color:var(--chalk-muted-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;}
.chalk-connection-notice-go {display:inline-flex;align-items:center;gap:var(--space-0-5);color:var(--chalk-muted-text);flex:none;}
.chalk-connection-notice-act {height:28px;padding:0 var(--space-3);border-radius:var(--corner-pill);background:var(--chalk-text);color:var(--chalk-canvas);font-size:var(--type-caption);font-weight:600;white-space:nowrap;flex:none;}
.chalk-connection-notice-x {width:28px;height:28px;border-radius:50%;display:grid;place-items:center;color:var(--chalk-muted-text);flex:none;}
.chalk-connection-notice-x:hover {background:var(--chalk-hover);}
@media (prefers-reduced-motion: no-preference) {
  .chalk-connection-notice {animation:chalk-connection-notice-in 160ms ease-out;}
}
@keyframes chalk-connection-notice-in {from {opacity:0;transform:translateY(4px);}}
.chalk-connection-notice-slot {min-width:0;pointer-events:auto;}
.chalk-connection-notice-slot[data-phone] {position:absolute;top:52px;left:var(--space-2);right:var(--space-2);display:flex;}
.chalk-connection-notice-slot[data-phone] .chalk-connection-notice {flex:1 1 100%;height:auto;min-height:36px;}
.chalk-connection-notice-slot[data-phone] .chalk-connection-notice-main {flex:1 1 auto;height:auto;min-height:36px;padding-block:var(--space-1);}
.chalk-connection-notice-slot[data-phone] .chalk-connection-notice-why {white-space:normal;}
.chalk-frame.chalk-frame:has(.chalk-connection-notice-slot[data-phone]) .chalk-stage-layout {top:100px;}
`;
