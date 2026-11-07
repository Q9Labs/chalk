import "../lib/whiteboard-assets";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { installChunkLoadAutoReload } from "../lib/chunkReload";
import { BRAND_DIR, FAVICON_ICO } from "../lib/site-head";
import { THEME_BOOTSTRAP_SCRIPT } from "../lib/theme";
import { ThemeProvider } from "../lib/theme-context";
import appCss from "../styles.css?url";
installChunkLoadAutoReload();
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#000000" },
      { title: "Chalk" },
      {
        name: "description",
        content: "Chalk is a real-time collaboration and communication layer built around durable Spaces and bounded Episodes.",
      },
    ],
    links: [
      { rel: "manifest", href: "/manifest.json" },
      { rel: "icon", href: `${BRAND_DIR}/chalk-icon.svg`, type: "image/svg+xml" },
      { rel: "icon", href: FAVICON_ICO, sizes: "16x16 32x32 48x48" },
      { rel: "apple-touch-icon", href: `${BRAND_DIR}/apple-touch-icon.png` },
      { rel: "stylesheet", href: "/fonts/site.css" },
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
        {children}
        <Scripts />
      </body>
    </html>
  );
}
