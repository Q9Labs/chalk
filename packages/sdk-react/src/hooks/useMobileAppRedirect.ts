import {
  ChalkErrorClass,
  ErrorCode,
  type ChalkError,
} from "@q9labs/chalk-core";
import { useEffect, useMemo, useState } from "react";

import { useChalkSession } from "../context/chalk-provider";
import { replaceWindowLocation } from "../utils/browserNavigation";
import {
  buildMobileJoinIntent,
  buildPublicJoinLink,
  detectMobileJoinPlatform,
  resolveJoinTokenFromJoinTarget,
  type MobileJoinPlatform,
} from "../utils/mobileRedirect";

const MOBILE_REDIRECT_FALLBACK_DEEP_LINK_DELAY_MS = 900;
const MOBILE_REDIRECT_STORE_FALLBACK_TIMEOUT_MS = 1800;

export interface UseMobileAppRedirectOptions {
  roomId?: string;
  joinToken?: string;
  inviteLink?: string;
  iosStoreUrl?: string;
  publicAppUrl?: string;
  onError?: (error: ChalkError) => void;
}

export interface UseMobileAppRedirectResult {
  isBlocking: boolean;
  status: "inactive" | "resolving" | "opening" | "failed";
  platform: MobileJoinPlatform | null;
  error: string | null;
  publicInviteLink: string | null;
}

function createMobileRedirectError(
  message: string,
  details: Record<string, unknown>,
  cause?: unknown,
) {
  return new ChalkErrorClass(ErrorCode.INVALID_REQUEST, message, {
    cause: cause instanceof Error ? cause : undefined,
    details,
  });
}

function isChalkErrorLike(error: unknown): error is ChalkError {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { name?: unknown; message?: unknown; code?: unknown };
  return (
    candidate.name === "ChalkError" &&
    typeof candidate.message === "string" &&
    typeof candidate.code === "string"
  );
}

export function useMobileAppRedirect({
  roomId,
  joinToken,
  inviteLink,
  iosStoreUrl,
  publicAppUrl,
  onError,
}: UseMobileAppRedirectOptions): UseMobileAppRedirectResult {
  const { session } = useChalkSession();
  const [status, setStatus] = useState<UseMobileAppRedirectResult["status"]>(
    "inactive",
  );
  const [error, setError] = useState<string | null>(null);
  const [publicInviteLink, setPublicInviteLink] = useState<string | null>(null);

  const platform = useMemo(() => {
    if (typeof navigator === "undefined") {
      return null;
    }

    return detectMobileJoinPlatform(navigator.userAgent);
  }, []);

  const directJoinToken = useMemo(
    () => resolveJoinTokenFromJoinTarget({ inviteLink, joinToken }),
    [inviteLink, joinToken],
  );

  useEffect(() => {
    if (!platform) {
      setStatus("inactive");
      setError(null);
      setPublicInviteLink(null);
      return;
    }

    if (!roomId && !directJoinToken) {
      setStatus("inactive");
      setError(null);
      setPublicInviteLink(null);
      return;
    }

    let cancelled = false;
    let handoffSucceeded = false;
    let fallbackDeepLinkTimeoutId = 0;
    let storeFallbackTimeoutId = 0;
    let attemptedFallbackDeepLink = false;
    let removeVisibilityListener = () => {};

    const fail = (nextError: ChalkError) => {
      if (cancelled) {
        return;
      }
      setStatus("failed");
      setError(nextError.message);
      onError?.(nextError);
    };

    void (async () => {
      try {
        setStatus("resolving");
        setError(null);

        let nextJoinToken = directJoinToken;
        if (!nextJoinToken) {
          if (!roomId) {
            throw createMobileRedirectError(
              "Missing room join target for mobile app redirect.",
              {
                stage: "mobile_redirect_resolve_target",
              },
            );
          }

          const created = await session.createJoinToken(roomId);
          nextJoinToken = created.joinToken?.trim() || null;
          if (!nextJoinToken) {
            throw createMobileRedirectError(
              "Could not create a public Chalk join link.",
              {
                stage: "mobile_redirect_create_join_token",
                roomId,
              },
            );
          }
        }

        if (cancelled) {
          return;
        }

        const nextPublicInviteLink = buildPublicJoinLink(
          nextJoinToken,
          publicAppUrl,
          typeof window === "undefined" ? undefined : window.location.origin,
        );
        setPublicInviteLink(nextPublicInviteLink);

        const mobileJoinIntent = buildMobileJoinIntent({
          joinToken: nextJoinToken,
          userAgent: navigator.userAgent,
          iosStoreUrl,
        });
        if (!mobileJoinIntent) {
          setStatus("inactive");
          return;
        }

        setStatus("opening");

        const handleVisibilityChange = () => {
          if (document.hidden) {
            handoffSucceeded = true;
            window.clearTimeout(fallbackDeepLinkTimeoutId);
            window.clearTimeout(storeFallbackTimeoutId);
          }
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);
        removeVisibilityListener = () => {
          document.removeEventListener("visibilitychange", handleVisibilityChange);
        };

        fallbackDeepLinkTimeoutId = window.setTimeout(() => {
          if (
            cancelled ||
            handoffSucceeded ||
            attemptedFallbackDeepLink ||
            !mobileJoinIntent.fallbackDeepLinkUrl
          ) {
            return;
          }

          attemptedFallbackDeepLink = true;
          replaceWindowLocation(mobileJoinIntent.fallbackDeepLinkUrl);
        }, MOBILE_REDIRECT_FALLBACK_DEEP_LINK_DELAY_MS);

        storeFallbackTimeoutId = window.setTimeout(() => {
          if (cancelled || handoffSucceeded) {
            return;
          }

          if (mobileJoinIntent.storeUrl) {
            replaceWindowLocation(mobileJoinIntent.storeUrl);
            return;
          }

          fail(
            createMobileRedirectError(
              platform === "ios"
                ? "Chalk could not open because the App Store URL is not configured."
                : "Chalk could not open in the mobile app.",
              {
                stage: "mobile_redirect_store_fallback",
                platform,
                roomId,
                joinToken: nextJoinToken,
                publicInviteLink: nextPublicInviteLink,
                deepLinkUrl: mobileJoinIntent.deepLinkUrl,
                fallbackDeepLinkUrl: mobileJoinIntent.fallbackDeepLinkUrl,
              },
            ),
          );
        }, MOBILE_REDIRECT_STORE_FALLBACK_TIMEOUT_MS);

        replaceWindowLocation(mobileJoinIntent.deepLinkUrl);
      } catch (caughtError) {
        fail(
          isChalkErrorLike(caughtError)
            ? caughtError
            : createMobileRedirectError(
                "Could not open Chalk in the mobile app.",
                {
                  stage: "mobile_redirect_prepare",
                  platform,
                  roomId,
                  joinToken: directJoinToken,
                },
                caughtError,
              ),
        );
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(fallbackDeepLinkTimeoutId);
      window.clearTimeout(storeFallbackTimeoutId);
      removeVisibilityListener();
    };
  }, [directJoinToken, iosStoreUrl, onError, platform, publicAppUrl, roomId, session]);

  return {
    isBlocking: status !== "inactive",
    status,
    platform,
    error,
    publicInviteLink,
  };
}
