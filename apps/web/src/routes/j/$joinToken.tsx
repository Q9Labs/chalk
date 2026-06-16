import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import z from "zod";
import { exchangeJoinToken, getApiUrl, setJoinContext } from "../../lib/internalAuth";
import { buildMobileJoinIntent, type MobileJoinPlatform } from "../../lib/mobileJoinRedirect";

const MOBILE_REDIRECT_FALLBACK_DEEP_LINK_DELAY_MS = 900;
const MOBILE_REDIRECT_STORE_FALLBACK_TIMEOUT_MS = 1800;

export const Route = createFileRoute("/j/$joinToken")({
  component: JoinLinkPage,
  params: z.object({
    joinToken: z.string(),
  }),
});

function JoinLinkPage() {
  const { joinToken } = Route.useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [mobileFallbackReady, setMobileFallbackReady] = useState(false);
  const mobileJoinIntent = useMemo(() => {
    if (typeof navigator === "undefined") {
      return null;
    }

    return buildMobileJoinIntent({
      joinToken,
      userAgent: navigator.userAgent,
      iosStoreUrl: import.meta.env.VITE_IOS_APP_STORE_URL,
    });
  }, [joinToken]);

  useEffect(() => {
    if (mobileJoinIntent) {
      return undefined;
    }

    let cancelled = false;
    (async () => {
      try {
        const redirectPath = await resolveJoinLinkRedirect(joinToken);
        if (cancelled) return;
        await navigate({ href: redirectPath, replace: true });
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [joinToken, mobileJoinIntent, navigate]);

  useEffect(() => {
    if (!mobileJoinIntent) {
      return undefined;
    }

    let didHandOffToApp = false;
    let didAttemptFallbackDeepLink = false;
    const handleVisibilityChange = () => {
      if (document.hidden) {
        didHandOffToApp = true;
        setMobileFallbackReady(false);
        window.clearTimeout(fallbackDeepLinkTimeout);
        window.clearTimeout(storeFallbackTimeout);
      }
    };

    const fallbackDeepLinkTimeout = window.setTimeout(() => {
      if (didHandOffToApp || didAttemptFallbackDeepLink || !mobileJoinIntent.fallbackDeepLinkUrl) {
        return;
      }

      didAttemptFallbackDeepLink = true;
      window.location.replace(mobileJoinIntent.fallbackDeepLinkUrl);
    }, MOBILE_REDIRECT_FALLBACK_DEEP_LINK_DELAY_MS);

    const storeFallbackTimeout = window.setTimeout(() => {
      if (didHandOffToApp) {
        return;
      }
      setMobileFallbackReady(true);
      if (mobileJoinIntent.storeUrl) {
        window.location.replace(mobileJoinIntent.storeUrl);
      }
    }, MOBILE_REDIRECT_STORE_FALLBACK_TIMEOUT_MS);

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.location.replace(mobileJoinIntent.deepLinkUrl);

    return () => {
      window.clearTimeout(fallbackDeepLinkTimeout);
      window.clearTimeout(storeFallbackTimeout);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [mobileJoinIntent]);

  if (mobileJoinIntent) {
    return <MobileJoinRedirectScreen deepLinkUrl={mobileJoinIntent.deepLinkUrl} fallbackReady={mobileFallbackReady} platform={mobileJoinIntent.platform} storeUrl={mobileJoinIntent.storeUrl} />;
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-3">
        <h1 className="text-xl font-semibold">Joining meeting</h1>
        <p className="text-sm text-muted-foreground">{error ? "Could not join." : "Preparing your session..."}</p>
        {error && <pre className="rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">{error}</pre>}
      </div>
    </div>
  );
}

function MobileJoinRedirectScreen({ deepLinkUrl, fallbackReady, platform, storeUrl }: { deepLinkUrl: string; fallbackReady: boolean; platform: MobileJoinPlatform; storeUrl: string | null }) {
  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-3xl border border-border/60 bg-card/80 p-6 shadow-2xl backdrop-blur-sm space-y-5">
        <div className="space-y-2 text-center">
          <p className="text-xs font-medium uppercase tracking-[0.28em] text-primary/80">Open in Chalk</p>
          <h1 className="text-3xl font-semibold leading-tight">Joining on mobile works better in the app.</h1>
          <p className="text-sm text-muted-foreground">We’re opening Chalk now so you land directly in the lobby instead of the mobile web room.</p>
        </div>

        <div className="rounded-2xl border border-primary/20 bg-primary/8 p-4 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Invite token ready</p>
          <p className="mt-1">If the app is already installed, it should open automatically.</p>
          {fallbackReady && storeUrl ? <p className="mt-2 text-foreground">Didn’t open? Download Chalk below and retry the same link.</p> : null}
          {fallbackReady && !storeUrl ? <p className="mt-2 text-foreground">Didn’t open? Install Chalk from the {platform === "ios" ? "App Store" : "Play Store"} once the store URL is configured.</p> : null}
        </div>

        <div className="grid gap-3">
          <a className="inline-flex min-h-12 items-center justify-center rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:opacity-95" href={deepLinkUrl}>
            Open Chalk app
          </a>
          {storeUrl ? (
            <a className="inline-flex min-h-12 items-center justify-center rounded-2xl border border-border bg-background px-4 text-sm font-medium text-foreground transition hover:bg-muted" href={storeUrl}>
              {platform === "ios" ? "Download on the App Store" : "Get it on Google Play"}
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export async function resolveJoinLinkRedirect(joinToken: string): Promise<string> {
  const apiUrl = getApiUrl();
  const ex = await exchangeJoinToken(apiUrl, joinToken);
  setJoinContext({
    joinToken,
    roomId: ex.room_id,
    roomName: ex.room_name,
    accessToken: ex.access_token,
    expiresAtMs: Date.now() + ex.expires_in * 1000,
  });
  const params = new URLSearchParams();
  if (ex.room_name) {
    params.set("roomName", ex.room_name);
  }
  const search = params.toString();
  return `/room/${encodeURIComponent(ex.room_id)}${search ? `?${search}` : ""}`;
}
