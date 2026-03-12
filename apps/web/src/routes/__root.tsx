import { createTokenProvider } from "@q9labs/chalk-core";
import { ChalkProvider, type ChalkPostHogClient, createHttpIncidentReporter, useWhatsNew, WhatsNewDialog, WhatsNewTrigger } from "@q9labs/chalk-react";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { DebugDialog } from "../components/DebugDialog";
import { PwaInstallPrompt } from "../components/PwaInstallPrompt";
import { ErrorProvider } from "../context/error";
import { ThemeProvider } from "../context/theme";
import { installChunkLoadAutoReload } from "../lib/chunkReload";
import { createWebTokenProvider, getApiUrl, getJoinContext, isLocalHost, shouldPrimeTokenCache, shouldUseInternalRoomAuth } from "../lib/internalAuth";
import { getThemeColor } from "../lib/pwa";

// SSR check - ChalkProvider requires browser APIs
const isServer = typeof window === "undefined";

// If a new deploy removes old hashed chunks, long-lived tabs can start failing
// on route navigation. Auto-reload once on chunk load failures.
installChunkLoadAutoReload();

// import "../../../../packages/sdk-react/src/styles/base.css";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      {
        name: "application-name",
        content: "Chalk",
      },
      {
        title: "Chalk",
      },
      {
        name: "description",
        content: "Ultra low-latency video conferencing for education.",
      },
      {
        name: "theme-color",
        content: getThemeColor("dark"),
      },
      {
        name: "mobile-web-app-capable",
        content: "yes",
      },
      {
        name: "apple-mobile-web-app-capable",
        content: "yes",
      },
      {
        name: "apple-mobile-web-app-status-bar-style",
        content: "black-translucent",
      },
      {
        name: "apple-mobile-web-app-title",
        content: "Chalk",
      },
    ],
    links: [
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "/chalk-icon.svg",
      },
      {
        rel: "icon",
        href: "/favicon.ico",
      },
      {
        rel: "shortcut icon",
        href: "/favicon.ico",
      },
      {
        rel: "manifest",
        href: "/manifest.json",
      },
      {
        rel: "apple-touch-icon",
        href: "/apple-touch-icon.png",
      },
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),

  shellComponent: RootDocument,
  component: RootComponent,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var theme = localStorage.getItem('chalk-theme') || 'dark';
                  var root = document.documentElement;
                  root.classList.remove('light', 'dark', 'nord');
                  if (theme === 'nord') {
                    root.classList.add('dark', 'nord');
                  } else {
                    root.classList.add(theme);
                  }
                  root.style.colorScheme = (theme === 'light' ? 'light' : 'dark');
                  root.setAttribute('data-chalk-theme', theme);
                  var themeColor = theme === 'light' ? '#ffffff' : theme === 'nord' ? '#2e3440' : '#030303';
                  document.querySelectorAll('meta[name="theme-color"]').forEach(function(meta) {
                    meta.setAttribute('content', themeColor);
                  });
                } catch (e) {}
              })();
            `,
          }}
        />
        {import.meta.env.DEV && <script src="//unpkg.com/react-grab/dist/index.global.js" crossOrigin="anonymous" />}
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  // API URL for backend - use env var or default to production
  const apiUrl = getApiUrl();
  const apiHost = useMemo(() => new URL(apiUrl).hostname, [apiUrl]);
  const isLocalApi = useMemo(() => isLocalHost(apiHost), [apiHost]);
  // WebSocket URL for real-time features (chat, reactions, whiteboard, etc.)
  // Note: Production uses separate subdomain because API Gateway doesn't support
  // mixing HTTP and WebSocket APIs on the same custom domain
  const configuredWsUrl = import.meta.env.VITE_WS_URL;
  const wsUrl =
    (!isLocalApi && configuredWsUrl) ||
    (apiUrl
      ? (() => {
          const api = new URL(apiUrl);
          // Production: use dedicated WebSocket subdomain (direct to ALB)
          if (api.host === "chalk-api.q9labs.ai") {
            return "wss://chalk-ws.q9labs.ai/ws";
          }
          // Local/other: derive from API URL
          const wsProtocol = api.protocol === "https:" ? "wss:" : "ws:";
          return `${wsProtocol}//${api.host}/ws`;
        })()
      : undefined);

  // Token provider: handles API key → JWT exchange and auto-refresh
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
        : null,
    [apiKey, apiUrl],
  );
  const tokenProvider = useMemo(
    () => async () => {
      if (!isServer && window.location.pathname.startsWith("/room/") && (getJoinContext() || shouldUseInternalRoomAuth(window.location.pathname, window.location.search))) {
        return webTokenProvider();
      }
      if (apiKeyTokenProvider) {
        return apiKeyTokenProvider();
      }
      return webTokenProvider();
    },
    [apiKeyTokenProvider, webTokenProvider],
  );

  useEffect(() => {
    if (isServer) return;
    if (!shouldPrimeTokenCache(window.location.pathname)) return;
    // Prime token cache so first Join click avoids auth round-trip; fail-open by design.
    void tokenProvider().catch(() => {});
  }, [tokenProvider]);

  const [isDebugOpen, setIsDebugOpen] = useState(false);
  const [posthogClient, setPosthogClient] = useState<ChalkPostHogClient | undefined>(undefined);

  const posthogKey = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  const posthogHost = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || "https://us.i.posthog.com";

  useEffect(() => {
    if (isServer || !posthogKey) return;
    const normalizedKey = posthogKey.trim();
    // PostHog JS requires the project API key (typically `phc_...`), not personal keys (`phx_...`).
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

  const content = (
    <ThemeProvider>
      <ErrorProvider>
        <div className="overflow-hidden bg-background text-foreground">
          <Outlet context={{ setIsDebugOpen }} />
          <PwaInstallPrompt />
          <WhatsNew apiBaseUrl={`${apiUrl}/api/v1`} />

          {/* Version Trigger - Bottom Right */}
          <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
            <button onClick={() => setIsDebugOpen(true)} className="text-[10px] font-mono text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer select-none" title="System Information">
              sdk v{__SDK_REACT_VERSION__} · web v{__WEB_APP_VERSION__}
            </button>
          </div>

          {!isServer && <DebugDialog isOpen={isDebugOpen} onClose={() => setIsDebugOpen(false)} />}
        </div>
      </ErrorProvider>
    </ThemeProvider>
  );

  // ChalkProvider requires browser APIs - skip during SSR/prerender
  if (isServer) {
    return content;
  }

  return (
    <ChalkProvider
      debug={true}
      demoMode={false}
      apiUrl={apiUrl}
      wsUrl={wsUrl}
      tokenProvider={tokenProvider}
      posthog={posthogConfig}
      incident={{
        reporter: incidentReporter,
        maxBreadcrumbs: 80,
      }}
    >
      {content}
    </ChalkProvider>
  );
}

function WhatsNew({ apiBaseUrl }: { apiBaseUrl: string }) {
  const { isOpen, open, close, releases, currentIndex, next, prev, markAllAsSeen, later, hasSeen, shouldAutoOpen } = useWhatsNew({ apiBaseUrl });

  // Auto-open for returning users with unseen updates
  useEffect(() => {
    if (shouldAutoOpen) open();
  }, [shouldAutoOpen, open]);

  return (
    <>
      {/* Floating trigger button - only show when there are unseen releases */}
      {releases.length > 0 && (
        <div className="fixed bottom-4 right-4 z-40">
          <WhatsNewTrigger hasUnseen={!hasSeen} onClick={open} />
        </div>
      )}

      {/* Dialog */}
      {isOpen && releases.length > 0 && <WhatsNewDialog isOpen={isOpen} onClose={close} releases={releases} currentIndex={currentIndex} onNext={next} onPrev={prev} onSkipAll={markAllAsSeen} onLater={later} />}
    </>
  );
}
