import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useEffect } from "react";
import { ErrorProvider } from "../context/error";
import { ThemeProvider } from "../context/theme";
import { installChunkLoadAutoReload } from "../lib/chunkReload";
import { isLegacyDocsPath, redirectToExternalDocs } from "../lib/docsRedirect";
import { getPublicAppUrl } from "../lib/publicUrl";

// SSR check - ChalkProvider requires browser APIs
const isServer = typeof window === "undefined";

// If a new deploy removes old hashed chunks, long-lived tabs can start failing
// on route navigation. Auto-reload once on chunk load failures.
installChunkLoadAutoReload();

// import "../../../../packages/sdk-react/src/styles/base.css";
import appCss from "../styles.css?url";

const APP_TITLE = "Chalk";
const APP_DESCRIPTION = "Ultra low-latency video meetings with edge-routed audio and video, private rooms, and no downloads required.";

export const Route = createRootRoute({
  notFoundComponent: () => {
    useEffect(() => {
      if (isLegacyDocsPath(window.location.pathname)) {
        redirectToExternalDocs(window.location.pathname, window.location.search, window.location.hash);
      }
    }, []);

    if (isServer) {
      return (
        <div className="min-h-screen flex items-center justify-center text-foreground bg-background">
          <p className="text-sm text-muted-foreground">Page not found.</p>
        </div>
      );
    }

    if (isLegacyDocsPath(window.location.pathname)) {
      return null;
    }

    return (
      <div className="min-h-screen flex items-center justify-center text-foreground bg-background">
        <p className="text-sm text-muted-foreground">Page not found.</p>
      </div>
    );
  },
  head: () => {
    const canonicalPath = typeof window === "undefined" ? "/" : `${window.location.pathname}${window.location.search}`;

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
          title: APP_TITLE,
        },
        {
          name: "description",
          content: APP_DESCRIPTION,
        },
        {
          property: "og:title",
          content: APP_TITLE,
        },
        {
          property: "og:description",
          content: APP_DESCRIPTION,
        },
        {
          property: "og:type",
          content: "website",
        },
        {
          name: "twitter:card",
          content: "summary",
        },
        {
          name: "twitter:title",
          content: APP_TITLE,
        },
        {
          name: "twitter:description",
          content: APP_DESCRIPTION,
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
          href: "/brand/chalk/chalk-icon.svg",
        },
        {
          rel: "apple-touch-icon",
          href: "/brand/chalk/apple-touch-icon.png",
        },
        {
          rel: "manifest",
          href: "/manifest.json",
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
          // biome-ignore lint/security/noDangerouslySetInnerHtml: It's safe here, we're setting a small script snippet
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var theme = localStorage.getItem('chalk-theme') || 'dark';
                  var root = document.documentElement;
                  if (theme !== 'dark' && theme !== 'light') {
                    theme = 'dark';
                  }
                  root.classList.remove('light', 'dark');
                  root.classList.add(theme);
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
  const content = (
    <ThemeProvider>
      <ErrorProvider>
        <div className="bg-[#0A0A0B] text-foreground min-h-screen animate-in fade-in duration-700">
          <Outlet />
        </div>
      </ErrorProvider>
    </ThemeProvider>
  );

  return content;
}
