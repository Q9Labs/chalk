import type { ScreenAnnotationHelper, ScreenAnnotationHelperShare } from "@q9labsai/chalk-react";
import { helperDeviceOffer, manageHelperDevice } from "./dashboard/helper-devices";
import { attachSchema, challengeSchema, delay, localRequest, networkTimeoutMs, readJson, remaining, renewLease, ticketsSchema, watchEvents, type Challenge, type Tickets } from "./screen-annotation-helper-bridge";
import { activeShare, liveProjection } from "./screen-annotation-helper-projection";
import { startConsent } from "./screen-annotation-helper-consent";

type BrowserHelper = ScreenAnnotationHelper & Required<Pick<ScreenAnnotationHelper, "challenge">>;

export interface HelperPairAuthority {
  readonly issueLocalTicket: (input: { challenge: Challenge; origin: string; share: ScreenAnnotationHelperShare; remembered: boolean; signal: AbortSignal }) => Promise<Tickets>;
  readonly rememberKey?: (key: string, signal: AbortSignal) => Promise<void>;
  readonly lookupCode?: ScreenAnnotationHelper["lookupCode"];
}

type CaptureTrack = (share: ScreenAnnotationHelperShare) => MediaStreamTrack | undefined;

export function createBrowserAnnotationHelper({
  origin,
  installUrl,
  authority,
  captureTrack,
  deviceAccount,
  accountId,
}: {
  readonly origin: string;
  readonly installUrl?: string;
  readonly authority: HelperPairAuthority;
  readonly captureTrack?: CaptureTrack;
  readonly deviceAccount?: string;
  readonly accountId?: string;
}): BrowserHelper {
  return {
    installUrl,
    lookupCode: authority.lookupCode,
    deviceAccount,
    async challenge(share, parent) {
      if (!window.isSecureContext || window.location.origin !== origin || !origin.startsWith("https://") || !activeShare(share)) throw new Error("Helper is not available for this share.");
      const pinSlot = accountId && `chalk.helper.key:${JSON.stringify([deviceAccount ?? "", accountId])}`;
      let pinned: string | null = null;
      try {
        if (pinSlot) pinned = window.localStorage.getItem(pinSlot);
      } catch {
        // Private or restricted browser profiles can still use a fresh code.
      }
      const consent = await startConsent();
      const challengeSignal = AbortSignal.any([parent, AbortSignal.timeout(networkTimeoutMs)]);
      const hello = { browserPublicKey: consent.browserPublicKey };
      const challenge = await localRequest("/v1/challenge?rememberedKeyProof=true", challengeSignal, hello)
        .catch((error: unknown) => {
          if (!(error instanceof TypeError) || challengeSignal.aborted) throw error;
          // Older Helpers reject query strings before adding CORS headers.
          return localRequest("/v1/challenge", challengeSignal, hello);
        })
        .then((response) => readJson(response, challengeSchema));
      if (challenge.version !== 2) return { kind: "update_required" };
      const signal = AbortSignal.any([parent, AbortSignal.timeout(remaining(challenge.expiresAtMs))]);
      const provenKey = await consent.provesKey(origin, challenge);
      const issue = (remembered: boolean, signal: AbortSignal) => authority.issueLocalTicket({ challenge, origin, share, signal, remembered });
      const requestedRemembered = provenKey && pinned === challenge.helperPublicKey;
      const tickets = await issue(requestedRemembered, signal);
      const remembered = tickets.remembered === true;
      if (remembered && !requestedRemembered) throw new Error("Unexpected remembered Helper ticket.");
      const binding = await consent.bind(challenge, tickets.pair.ticket, tickets.attachment.ticket, remembered);
      let started = false;
      return {
        kind: "approval",
        fingerprint: binding.fingerprint,
        remembered,
        async attach(onStatus, askConfirmation) {
          if (started || signal.aborted || !activeShare(share)) throw new Error("The Helper challenge is no longer valid.");
          started = true;
          const stop = new AbortController();
          const unsubscribe = share.client.subscribe(() => {
            if (!activeShare(share)) stop.abort();
          });
          const session = AbortSignal.any([stop.signal, parent]);
          try {
            const attachSignal = AbortSignal.any([signal, session]);
            const [attachment, code] = await Promise.all([
              localRequest("/v1/attach", attachSignal, {
                version: 2,
                challenge: challenge.challenge,
                browserProof: binding.browserProof,
                pairTicket: tickets.pair.ticket,
                attachmentHash: binding.attachmentHash,
              }).then((response) => readJson(response, attachSchema)),
              remembered ? null : askConfirmation(attachSignal),
            ]);
            await binding.confirm(code, attachment);
            attachSignal.throwIfAborted();
            if (!remembered && pinSlot && provenKey && authority.rememberKey) {
              // Persist only after the Helper signed the exact native approval and typed code.
              // Registration alone never permits this browser to skip the code.
              void authority
                .rememberKey(challenge.helperPublicKey, AbortSignal.timeout(networkTimeoutMs))
                .then(() => window.localStorage.setItem(pinSlot, challenge.helperPublicKey))
                .catch(() => {
                  // A failed pin or registration leaves code pairing available.
                });
            }
            const renewal = new AbortController();
            const track = captureTrack?.(share);
            try {
              if (!activeShare(share) || session.aborted) throw new Error("The Helper attachment is no longer valid.");
              const live = AbortSignal.any([session, renewal.signal]);
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
                  issue: async (signal) => {
                    const next = await issue(remembered, signal);
                    if ((next.remembered === true) !== remembered) throw new Error("Chalk Helper trust changed.");
                    return next;
                  },
                }),
              ]);
            } finally {
              renewal.abort();
              // A tab closing may prevent the delivery; the Helper's lease is the authority.
              void localRequest("/v1/exchange", AbortSignal.timeout(1500), { type: "disconnect" }, attachment.sessionSecret).catch(() => undefined);
            }
          } finally {
            stop.abort();
            unsubscribe();
          }
        },
      };
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
    async rememberKey(publicKey, signal) {
      await manageHelperDevice({ action: "remember", publicKey, tenantId: options.tenantId }, signal);
    },
    async issueLocalTicket({ challenge, share, signal, remembered }) {
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
          ...(remembered ? { remembered: true } : {}),
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
      accountId: options.accountId,
      authority,
    }),
    lookupCode: authority.lookupCode,
  };
}
