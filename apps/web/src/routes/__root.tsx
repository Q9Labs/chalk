import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { installChunkLoadAutoReload } from "../lib/chunkReload";
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
        content: "Chalk is a real-time video platform with two front doors: a meeting app that works out of the box, and an SDK that drops into your product. Managed or self-hosted.",
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
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function BlankPage() {
  return null;
}
