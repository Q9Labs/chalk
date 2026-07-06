import { createFileRoute } from "@tanstack/react-router";
import { V1Aurora } from "../landing/V1Aurora";
import baseCss from "../landing/base.css?url";
import v1Css from "../landing/v1.css?url";

const DESCRIPTION =
  "Chalk is ultra-low-latency video conferencing built for education. Start a live class in one click.";

export const Route = createFileRoute("/v1")({
  head: () => ({
    meta: [
      { title: "Chalk — Teach in real time" },
      { name: "description", content: DESCRIPTION },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@400;500;600;700&display=swap",
      },
      { rel: "stylesheet", href: baseCss },
      { rel: "stylesheet", href: v1Css },
    ],
  }),
  component: V1Aurora,
});
