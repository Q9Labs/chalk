import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { installChunkLoadAutoReload } from "../lib/chunkReload";
import { THEME_BOOTSTRAP_SCRIPT } from "../lib/theme";
import { ThemeProvider } from "../lib/theme-context";
import { WebTelemetryProvider } from "../lib/web-telemetry-context";
import appCss from "../styles.css?url";

installChunkLoadAutoReload();

export const Route = createRootRoute({
  notFoundComponent: BlankPage,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#f8f7f2" },
      { title: "Chalk" },
      {
        name: "description",
        content: "Chalk is a real-time collaboration and communication layer built around durable Spaces and bounded Episodes.",
      },
    ],
    links: [
      { rel: "manifest", href: "/manifest.json" },
      { rel: "icon", href: "/brand/chalk/chalk-icon.svg", type: "image/svg+xml" },
      { rel: "icon", href: "/favicon.ico", sizes: "64x64" },
      { rel: "apple-touch-icon", href: "/brand/chalk/apple-touch-icon.png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Figtree:wght@400..700&family=Nunito+Sans:opsz,wght@6..12,400..800&family=Spline+Sans+Mono:wght@400;500&display=swap",
      },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
});

function RootComponent() {
  return (
    <ThemeProvider>
      <Outlet />
    </ThemeProvider>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    // The bootstrap script writes the theme onto this element before React
    // hydrates, so its class and attributes are expected to differ from the HTML.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>
        <WebTelemetryProvider>{children}</WebTelemetryProvider>
        <Scripts />
      </body>
    </html>
  );
}

function BlankPage() {
  return null;
}
