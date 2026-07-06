import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { installChunkLoadAutoReload } from "../lib/chunkReload";
import appCss from "../styles.css?url";

installChunkLoadAutoReload();

export const Route = createRootRoute({
  notFoundComponent: BlankPage,
  head: () => ({
    meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }, { title: "Chalk" }],
    links: [{ rel: "stylesheet", href: appCss }],
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
