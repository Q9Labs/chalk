import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { installChunkLoadAutoReload } from "../lib/chunkReload";
import { BRAND_DIR, FAVICON_ICO } from "../lib/site-head";
import { DASHBOARD_BOOT_SCRIPT } from "../lib/dashboard-boot";
import { THEME_BOOTSTRAP_SCRIPT } from "../lib/theme";
import { ThemeProvider } from "../lib/theme-context";
import { installWhiteboardAssets } from "../lib/whiteboard-assets";
import appCss from "../styles.css?url";

installChunkLoadAutoReload();
installWhiteboardAssets();

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
        {/* Draws the dashboard's opening frame before the app loads; does nothing on other pages. */}
        <script dangerouslySetInnerHTML={{ __html: DASHBOARD_BOOT_SCRIPT }} />
        {children}
        <Scripts />
      </body>
    </html>
  );
}
