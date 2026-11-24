import type { ScreenAnnotationHelper, ScreenAnnotationHelperShare } from "@q9labsai/chalk-react";
import { helperDeviceOffer, manageHelperDevice } from "./dashboard/helper-devices";
import { attachSchema, challengeSchema, delay, localRequest, networkTimeoutMs, readJson, remaining, renewLease, ticketsSchema, watchEvents, type Challenge, type Tickets } from "./screen-annotation-helper-bridge";
import { activeShare, liveProjection } from "./screen-annotation-helper-projection";
import { startConsent } from "./screen-annotation-helper-consent";

type BrowserHelper = ScreenAnnotationHelper & Required<Pick<ScreenAnnotationHelper, "challenge">>;

export interface HelperPairAuthority {
  readonly issueLocalTicket: (input: { challenge: Challenge; origin: string; share: ScreenAnnotationHelperShare; signal: AbortSignal }) => Promise<Tickets>;
  readonly lookupCode?: ScreenAnnotationHelper["lookupCode"];
}

type CaptureTrack = (share: ScreenAnnotationHelperShare) => MediaStreamTrack | undefined;

export function createBrowserAnnotationHelper({ origin, installUrl, authority, captureTrack, deviceAccount }: { readonly origin: string; readonly installUrl?: string; readonly authority: HelperPairAuthority; readonly captureTrack?: CaptureTrack; readonly deviceAccount?: string }): BrowserHelper {
  let priorCleanup: Promise<void> | undefined;
  return {
    installUrl,
    lookupCode: authority.lookupCode,
    deviceAccount,
    async challenge(share, parent) {
      if (!window.isSecureContext || window.location.origin !== origin || !origin.startsWith("https://") || !activeShare(share)) throw new Error("Helper is not available for this share.");
      await priorCleanup;
      const consent = await startConsent();
      const cancellation = await consent.cancellation();
      let cancelling: Promise<void> | undefined;
      const cancel = () => {
        cancelling ??= localRequest("/v1/cancel", AbortSignal.timeout(1500), cancellation)
          .then(
            () => undefined,
            () => undefined,
          )
          .finally(() => parent.removeEventListener("abort", cancel));
        priorCleanup = cancelling;
        return cancelling;
      };
      parent.throwIfAborted();
      parent.addEventListener("abort", cancel, { once: true });
      const challengeSignal = AbortSignal.any([parent, AbortSignal.timeout(networkTimeoutMs)]);
      const hello = { browserPublicKey: consent.browserPublicKey };
      try {
        const challenge = await localRequest("/v1/challenge", challengeSignal, hello).then((response) => readJson(response, challengeSchema));
        if (challenge.version !== 2) {
          await cancel();
          return { kind: "update_required" };
        }
        const signal = AbortSignal.any([parent, AbortSignal.timeout(remaining(challenge.expiresAtMs))]);
        const issue = async (signal: AbortSignal) => {
          const tickets = await authority.issueLocalTicket({ challenge, origin, share, signal });
          if (tickets.remembered === true) throw new Error("Helper pairing requires a confirmation code.");
          return tickets;
        };
        const tickets = await issue(signal);
        const binding = await consent.bind(challenge, tickets.pair.ticket, tickets.attachment.ticket);
        let started = false;
        return {
          kind: "approval",
          fingerprint: binding.fingerprint,
          remembered: false,
          async attach(onStatus, askConfirmation) {
            if (started || signal.aborted || !activeShare(share)) throw new Error("The Helper challenge is no longer valid.");
            started = true;
            const stop = new AbortController();
            const unsubscribe = share.client.subscribe(() => {
              if (!activeShare(share)) stop.abort();
            });
            const live = AbortSignal.any([stop.signal, parent]);
            let sessionSecret: string | undefined;
            try {
              const attachSignal = AbortSignal.any([signal, live]);
              const [attachment, code] = await Promise.all([
                localRequest("/v1/attach", attachSignal, {
                  version: 2,
                  challenge: challenge.challenge,
                  browserProof: binding.browserProof,
                  pairTicket: tickets.pair.ticket,
                  attachmentHash: binding.attachmentHash,
                }).then(async (response) => {
                  const attachment = await readJson(response, attachSchema);
                  sessionSecret = attachment.sessionSecret;
                  return attachment;
                }),
                askConfirmation(attachSignal),
              ]);
              await binding.confirm(code, attachment);
              attachSignal.throwIfAborted();
              const track = captureTrack?.(share);
              if (!activeShare(share) || live.aborted) throw new Error("The Helper attachment is no longer valid.");
              await localRequest("/v1/exchange", live, { type: "authorize", attachmentTicket: tickets.attachment.ticket }, attachment.sessionSecret);
              const project = liveProjection({ track, share, currentTrack: () => captureTrack?.(share), attachmentSecret: attachment.sessionSecret, signal: live });
              let described = false;
              await Promise.race([
                project.failure,
                watchEvents(attachment.sessionSecret, live, async (event) => {
                  await binding.verifyStatus(attachment.sessionSecret, event);
                  if (!described && event.status === "unbound") {
                    await project.describe();
                    described = true;
                  }
                  onStatus(event.status);
                  await project.observe(event.status);
                }).then(() => onStatus("disconnected")),
                renewLease({
                  attachmentSecret: attachment.sessionSecret,
                  expiresAtMs: Math.min(attachment.leaseExpiresAtMs, tickets.attachment.expiresAtMs),
                  signal: live,
                  issue,
                }),
              ]);
            } finally {
              stop.abort();
              unsubscribe();
              await Promise.all([cancel(), sessionSecret && localRequest("/v1/exchange", AbortSignal.timeout(1500), { type: "disconnect" }, sessionSecret).catch(() => undefined)]);
            }
          },
        };
      } catch (error) {
        await cancel();
        throw error;
      }
    },
  };
}

export function createManagedAnnotationHelper(options: {
  readonly origin: string;
  readonly apiBaseUrl: string;
  readonly mediaProof: () => string | null | undefined;
  readonly installUrl?: string;
  readonly captureTrack?: CaptureTrack;
  readonly tenantId: string;
  readonly accountId?: string;
}): BrowserHelper & Required<Pick<ScreenAnnotationHelper, "lookupCode">> {
  const api = new URL("/v1/screen-annotation/helper/pair-ticket", options.apiBaseUrl);
  if (api.protocol !== "https:" || api.username || api.password) throw new Error("Invalid Helper API.");
  const authority = {
    async lookupCode(code, share, signal) {
      if (!activeShare(share)) throw new Error("The screen share is no longer authorized.");
      const offer = await manageHelperDevice({ action: "lookup", code }, signal).then((response) => readJson(response, helperDeviceOffer));
      return {
        deviceName: offer.name,
        fingerprint: offer.fingerprint,
        async approve(onStatus) {
          const approve = async (refresh: boolean) => {
            const mediaProof = options.mediaProof();
            if (!mediaProof || !activeShare(share)) throw new Error("The screen share is no longer authorized.");
            await manageHelperDevice(
              {
                action: "approve",
                requestId: offer.requestId,
                mediaProof,
                refresh,
                layerId: share.layer.layer_id,
                publicationId: share.layer.publication_id,
              },
              AbortSignal.any([signal, AbortSignal.timeout(networkTimeoutMs)]),
            );
          };
          await approve(false);
          onStatus("device_approved");
          while (!signal.aborted) {
            await delay(10_000, signal);
            if (!signal.aborted) await approve(true);
          }
        },
      };
    },
    async issueLocalTicket({ challenge, share, signal }) {
      const proof = options.mediaProof();
      if (!proof || !activeShare(share)) throw new Error("The screen share is no longer authorized.");
      const response = await fetch(api, {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${proof}` },
        body: JSON.stringify({
          version: 1,
          challenge: challenge.challenge,
          helperPublicKey: challenge.helperPublicKey,
          layerId: share.layer.layer_id,
          publicationId: share.layer.publication_id,
        }),
        signal,
      });
      if (!response.ok) throw new Error("The Helper ticket could not be issued.");
      return readJson(response, ticketsSchema);
    },
  } satisfies Required<HelperPairAuthority>;
  return {
    ...createBrowserAnnotationHelper({
      origin: options.origin,
      installUrl: options.installUrl,
      captureTrack: options.captureTrack,
      deviceAccount: options.tenantId,
      authority,
    }),
    lookupCode: authority.lookupCode,
  };
}
