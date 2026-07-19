import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useEffect } from "react";
import { installChunkLoadAutoReload } from "../lib/chunkReload";
import { createWebTelemetry } from "../lib/telemetry";
import { installWebTelemetryLifecycle } from "../lib/telemetryLifecycle";
import appCss from "../styles.css?url";

installChunkLoadAutoReload();

export const Route = createRootRoute({
  notFoundComponent: BlankPage,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Chalk — Video calls. Your call." },
      {
        name: "description",
        content: "Chalk is an open-source video-conferencing stack under active development, with a Go API, durable realtime sync, and TypeScript, React, and React Native SDKs.",
      },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Figtree:wght@400..700&family=Spline+Sans+Mono:wght@400;500&display=swap",
      },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  shellComponent: RootDocument,
  component: Outlet,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <WebTelemetryBootstrap />
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function WebTelemetryBootstrap() {
  useEffect(() => {
    const webTelemetry = createWebTelemetry();
    const journey = webTelemetry.startJourney({ kind: "web.application" });
    return installWebTelemetryLifecycle(webTelemetry, journey);
  }, []);

  return null;
}

function BlankPage() {
  return null;
}
