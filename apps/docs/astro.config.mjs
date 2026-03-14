import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://docs.chalk.q9labs.ai",
  output: "static",
  integrations: [
    starlight({
      title: "Chalk",
      logo: {
        src: "./src/assets/chalk-logo.svg",
        replacesTitle: true,
      },
      social: {
        github: "https://github.com/q9labs/chalk",
      },
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", slug: "getting-started" },
            { label: "Installation", slug: "getting-started/installation" },
            { label: "Authentication", slug: "getting-started/authentication" },
          ],
        },
        {
          label: "SDK",
          items: [{ label: "React", slug: "sdk/react" }],
        },
        {
          label: "API Reference",
          items: [
            { label: "Overview", slug: "api" },
            { label: "Tenants", slug: "api/tenants" },
            { label: "Authentication", slug: "api/authentication" },
            { label: "Rooms", slug: "api/rooms" },
            { label: "Participants", slug: "api/participants" },
            { label: "Recordings", slug: "api/recordings" },
            { label: "Transcription", slug: "api/transcription" },
            { label: "Webhooks", slug: "api/webhooks" },
            { label: "WebSocket", slug: "api/websocket" },
          ],
        },
      ],
      customCss: ["./src/styles/custom.css"],
    }),
    sitemap(),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
