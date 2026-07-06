import { createFileRoute } from "@tanstack/react-router";
import { Minimal } from "../landing/Minimal";
import minimalCss from "../landing/minimal.css?url";

const DESCRIPTION =
  "Chalk is simple, low-latency video for classes, tutoring, and office hours. No downloads, no accounts.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Chalk — Real-time video for teaching" },
      { name: "description", content: DESCRIPTION },
    ],
    links: [{ rel: "stylesheet", href: minimalCss }],
  }),
  component: Minimal,
});
