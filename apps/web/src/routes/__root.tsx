import { createRootRoute, HeadContent, Outlet, Scripts, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import { ErrorProvider } from "../context/error";
import { ThemeProvider } from "../context/theme";
import { installChunkLoadAutoReload } from "../lib/chunkReload";
import { createWebTokenProvider, getApiUrl, shouldPrimeTokenCache } from "../lib/internalAuth";
import { getPublicAppUrl } from "../lib/publicUrl";

// SSR check - ChalkProvider requires browser APIs
const isServer = typeof window === "undefined";

// If a new deploy removes old hashed chunks, long-lived tabs can start failing
// on route navigation. Auto-reload once on chunk load failures.
installChunkLoadAutoReload();

// import "../../../../packages/sdk-react/src/styles/base.css";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => {
    const canonicalPath =
      typeof window === "undefined"
        ? "/"
        : `${window.location.pathname}${window.location.search}`;

    return {
      meta: [
        {
          charSet: "utf-8",
        },
        {
          name: "viewport",
          content: "width=device-width, initial-scale=1",
        },
        {
          title: "Chalk",
        },
      ],
      links: [
        {
          rel: "canonical",
          href: getPublicAppUrl(canonicalPath),
        },
        {
          rel: "icon",
          type: "image/svg+xml",
          href: "/chalk-icon.svg",
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
    };
  },

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
  const location = useLocation();
  useEffect(() => {
    if (isServer || !shouldPrimeTokenCache(location.pathname)) return;
    const apiUrl = getApiUrl();
    const tokenProvider = createWebTokenProvider(apiUrl);
    // Prime token cache so first Join click avoids auth round-trip; fail-open by design.
    void tokenProvider().catch(() => {});
  }, [location.pathname]);

  const content = (
    <ThemeProvider>
      <ErrorProvider>
        <div className="overflow-hidden bg-[#0A0A0B] text-foreground">
          <div className="chalk-wipe-container chalk-wipe-active min-h-screen">
            <Outlet />
          </div>
        </div>
      </ErrorProvider>
    </ThemeProvider>
  );

  return content;
}
