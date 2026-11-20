import type { ConnectionMediaSnapshot } from "../media";
import type { EventFields } from "../obs/registry";
import type { SyncLinkCheck } from "../sync/v1-types";
import type { TelemetryOutbox } from "../telemetry/outbox";

export type GrantCheck = EventFields["client.grant_check"]["continuity_result"];
type MediaCheck = EventFields["client.media_link_check"]["continuity_result"];
type ResumeCheck = EventFields["client.resume_check"]["continuity_result"];

/** Compare the raw peer state and the decision that the lifecycle made about the same snapshot. */
export function checkMediaLink({ connection }: ConnectionMediaSnapshot, recoveryQueued: boolean): MediaCheck {
  const { phase, peerConnectionState, iceConnectionState } = connection;
  if (recoveryQueued || phase === "recovering") return "recovering";
  if (phase !== "live") return "unverified";
  if (peerConnectionState === "failed" || peerConnectionState === "closed" || iceConnectionState === "failed" || iceConnectionState === "closed") return "dead_live";
  return peerConnectionState === "connected" && (iceConnectionState === "connected" || iceConnectionState === "completed") ? "verified" : "unverified";
}

/** One actor owns the de-duplication and pairs a resume only with subsequent transport checks. */
export function observeContinuity(outbox: TelemetryOutbox | undefined) {
  let resume = outbox?.resumeCount ?? 0;
  let pendingResume = false;
  let syncAfterResume = false;
  let mediaAfterResume = false;
  let sync: SyncLinkCheck["result"] | undefined;
  let media: MediaCheck | undefined;
  let grant: GrantCheck | undefined;

  const readPlatform = () => {
    if (!outbox || outbox.resumeCount === resume) return;
    resume = outbox.resumeCount;
    pendingResume = true;
    outbox.fact("client.resume_check", { continuity_result: "pending" });
    syncAfterResume = false;
    mediaAfterResume = false;
  };

  const settledResume = (result: ResumeCheck) => {
    if (!pendingResume) return;
    outbox?.fact("client.resume_check", { continuity_result: result });
    pendingResume = false;
  };

  const checkResume = (link: "sync" | "media", result: SyncLinkCheck["result"] | MediaCheck) => {
    if (!pendingResume) return;
    if (result === "dead_live") return settledResume("dead_live");
    if (link === "sync") syncAfterResume = result === "verified";
    else mediaAfterResume = result === "verified";
    if (syncAfterResume && mediaAfterResume) settledResume("verified");
  };

  return {
    resume: readPlatform,
    grant(result: GrantCheck) {
      if (result === grant) return;
      grant = result;
      outbox?.fact("client.grant_check", { continuity_result: result });
    },
    sync(check: SyncLinkCheck) {
      const { result } = check;
      readPlatform();
      if (result !== sync) {
        sync = result;
        outbox?.fact("client.sync_link_check", { continuity_result: result });
      }
      if (check.result !== "verified" || outbox?.contactSinceResume(check.pingSentMono)) checkResume("sync", result);
    },
    media(result: MediaCheck) {
      readPlatform();
      if (result !== media) {
        media = result;
        outbox?.fact("client.media_link_check", { continuity_result: result });
      }
      checkResume("media", result);
    },
    exhausted() {
      readPlatform();
      settledResume("exhausted");
    },
    reset() {
      resume = outbox?.resumeCount ?? 0;
      pendingResume = false;
      sync = undefined;
      media = undefined;
      grant = undefined;
    },
  };
}
