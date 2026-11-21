import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useEffect } from "react";

import { bootBeaconScript, markAppShown, sendEntryEvent } from "../lib/boot-beacon";
import { installChunkLoadAutoReload } from "../lib/chunkReload";
import { EntrySurface } from "../lib/entry-surface";
import { BRAND_DIR, FAVICON_ICO } from "../lib/site-head";
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
  errorComponent: RootErrorComponent,
  onCatch: (error) => {
    sendEntryEvent("boot.render_failed", { error_name: error instanceof Error ? error.name : "Error" });
  },
});
function RootComponent() {
  useEffect(() => {
    markAppShown();
  }, []);
  return (
    <EntrySurface name="boot.app" fields={{}}>
      <ThemeProvider>
        <Outlet />
      </ThemeProvider>
    </EntrySurface>
  );
}
function RootErrorComponent() {
  return (
    <EntrySurface name="boot.error_page" fields={{}}>
      <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
        <p>Something went wrong. Reload to try again.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </EntrySurface>
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
        <script dangerouslySetInnerHTML={{ __html: bootBeaconScript() }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
