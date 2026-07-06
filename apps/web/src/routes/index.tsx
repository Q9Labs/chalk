import { createFileRoute } from "@tanstack/react-router";
import { Landing } from "../landing/Landing";
import landingCss from "../landing/landing.css?url";

const DESCRIPTION =
  "Chalk is fast, focused, ultra-low-latency video for classes, tutoring, and office hours. Share a link and you're live.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Chalk — Real-time video for teaching" },
      { name: "description", content: DESCRIPTION },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
      },
      { rel: "stylesheet", href: landingCss },
    ],
  }),
  component: Landing,
});
