import { createTokenProvider } from "@q9labs/chalk-core";
import { ChalkProvider, type ChalkPostHogClient, createHttpIncidentReporter, useWhatsNew, WhatsNewDialog, WhatsNewTrigger } from "@q9labs/chalk-react";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { DebugDialog } from "../components/DebugDialog";
import { createWebTokenProvider, getApiUrl, getChalkSessionCacheKey, isLocalHost, shouldUseRoomScopedTokenProvider } from "../lib/internalAuth";

const isServer = typeof window === "undefined";

type WebChalkRuntimeRenderProps = {
  openDebug: () => void;
};

type WebChalkRuntimeProps = {
  children: React.ReactNode | ((props: WebChalkRuntimeRenderProps) => React.ReactNode);
  fallback?: React.ReactNode;
};

export function WebChalkRuntime({ children, fallback = null }: WebChalkRuntimeProps) {
  const location = useLocation();
  const apiUrl = getApiUrl();
  const apiHost = useMemo(() => new URL(apiUrl).hostname, [apiUrl]);
  const isLocalApi = useMemo(() => isLocalHost(apiHost), [apiHost]);
  const configuredWsUrl = import.meta.env.VITE_WS_URL;
  const wsUrl =
    (!isLocalApi && configuredWsUrl) ||
    (apiUrl
      ? (() => {
          const api = new URL(apiUrl);
          if (api.host === "chalk-api.q9labs.ai") {
            return "wss://chalk-ws.q9labs.ai/ws";
          }
          const wsProtocol = api.protocol === "https:" ? "wss:" : "ws:";
          return `${wsProtocol}//${api.host}/ws`;
        })()
      : undefined);

  const apiKey = import.meta.env.VITE_CHALK_API_KEY;
  const webTokenProvider = useMemo(() => createWebTokenProvider(apiUrl), [apiUrl]);
  const apiKeyTokenProvider = useMemo(
    () =>
      apiKey
        ? createTokenProvider({
            apiKey,
            apiUrl,
            storage: "sessionStorage",
          })
        : undefined,
    [apiKey, apiUrl],
  );
  const tokenProvider = useMemo(() => {
    if (shouldUseRoomScopedTokenProvider(location.pathname) || !apiKeyTokenProvider) {
      return webTokenProvider;
    }
    return apiKeyTokenProvider;
  }, [apiKeyTokenProvider, location.pathname, webTokenProvider]);

  const [isDebugOpen, setIsDebugOpen] = useState(false);
  const [posthogClient, setPosthogClient] = useState<ChalkPostHogClient | undefined>(undefined);

  const posthogKey = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  const posthogHost = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || "https://us.i.posthog.com";

  useEffect(() => {
    if (isServer || !posthogKey) return;
    const normalizedKey = posthogKey.trim();
    if (normalizedKey.startsWith("phx_")) {
      console.warn("[chalk:web] PostHog disabled: VITE_POSTHOG_KEY is a personal API key (phx_*). Use the project API key (phc_*).");
      return;
    }

    let active = true;
    void import("posthog-js")
      .then(({ default: posthog }) => {
        posthog.init(normalizedKey, {
          api_host: posthogHost,
          disable_session_recording: true,
        });
        if (active) setPosthogClient(posthog);
      })
      .catch(() => {
        // PostHog is optional for local/dev environments.
      });

    return () => {
      active = false;
    };
  }, [posthogHost, posthogKey]);

  const posthogConfig = useMemo(
    () =>
      posthogClient
        ? {
            client: posthogClient,
            properties: {
              app: "web",
            },
          }
        : undefined,
    [posthogClient],
  );

  const incidentReporter = useMemo(() => {
    if (isServer) return undefined;
    const trimmedApiKey = typeof apiKey === "string" ? apiKey.trim() : "";
    if (!trimmedApiKey) return undefined;
    return createHttpIncidentReporter({
      endpoint: `${apiUrl}/api/v1/debug/client-incident`,
      headers: {
        "x-api-key": trimmedApiKey,
        "x-chalk-source": "chalk-web",
      },
      retries: 1,
      retryDelayMs: 200,
      timeoutMs: 3000,
      useBeacon: true,
    });
  }, [apiKey, apiUrl]);

  const sessionCacheKey = useMemo(
    () => getChalkSessionCacheKey(location.pathname, location.search),
    [location.pathname, location.search],
  );

  if (isServer) {
    return <>{fallback}</>;
  }

  const renderedChildren =
    typeof children === "function"
      ? children({
          openDebug: () => setIsDebugOpen(true),
        })
      : children;

  return (
    <ChalkProvider
      debug={true}
      demoMode={false}
      apiUrl={apiUrl}
      sessionCacheKey={sessionCacheKey}
      wsUrl={wsUrl}
      tokenProvider={tokenProvider}
      posthog={posthogConfig}
      incident={{
        reporter: incidentReporter,
        maxBreadcrumbs: 80,
      }}
    >
      {renderedChildren}
      <WhatsNew apiBaseUrl={`${apiUrl}/api/v1`} />

      <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
        <button onClick={() => setIsDebugOpen(true)} className="text-[10px] font-mono text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer select-none" title="System Information">
          sdk v{__SDK_REACT_VERSION__} · web v{__WEB_APP_VERSION__}
        </button>
      </div>

      <DebugDialog isOpen={isDebugOpen} onClose={() => setIsDebugOpen(false)} />
    </ChalkProvider>
  );
}

function WhatsNew({ apiBaseUrl }: { apiBaseUrl: string }) {
  const { isOpen, open, close, releases, currentIndex, next, prev, markAllAsSeen, later, hasSeen, shouldAutoOpen } = useWhatsNew({ apiBaseUrl });

  useEffect(() => {
    if (shouldAutoOpen) open();
  }, [shouldAutoOpen, open]);

  return (
    <>
      {releases.length > 0 && (
        <div className="fixed bottom-4 right-4 z-40">
          <WhatsNewTrigger hasUnseen={!hasSeen} onClick={open} />
        </div>
      )}

      {isOpen && releases.length > 0 && <WhatsNewDialog isOpen={isOpen} onClose={close} releases={releases} currentIndex={currentIndex} onNext={next} onPrev={prev} onSkipAll={markAllAsSeen} onLater={later} />}
    </>
  );
}
