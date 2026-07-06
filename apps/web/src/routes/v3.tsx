import { createFileRoute } from "@tanstack/react-router";
import { V3Bento } from "../landing/V3Bento";
import baseCss from "../landing/base.css?url";
import v3Css from "../landing/v3.css?url";

const DESCRIPTION =
  "Chalk is real-time video built for teaching — a classroom that keeps up with you. Under 100ms, edge to edge.";

export const Route = createFileRoute("/v3")({
  head: () => ({
    meta: [
      { title: "Chalk — A classroom that keeps up" },
      { name: "description", content: DESCRIPTION },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Sora:wght@400;500;600;700&display=swap",
      },
      { rel: "stylesheet", href: baseCss },
      { rel: "stylesheet", href: v3Css },
    ],
  }),
  component: V3Bento,
});
