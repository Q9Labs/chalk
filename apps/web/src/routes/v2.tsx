import { createFileRoute } from "@tanstack/react-router";
import { V2Editorial } from "../landing/V2Editorial";
import baseCss from "../landing/base.css?url";
import v2Css from "../landing/v2.css?url";

const DESCRIPTION =
  "Chalk streams your lessons the instant they happen — ultra-low-latency video built for education.";

export const Route = createFileRoute("/v2")({
  head: () => ({
    meta: [
      { title: "Chalk — The classroom, without the lag" },
      { name: "description", content: DESCRIPTION },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Caveat:wght@500;700&family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600&display=swap",
      },
      { rel: "stylesheet", href: baseCss },
      { rel: "stylesheet", href: v2Css },
    ],
  }),
  component: V2Editorial,
});
