import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";

export default {
  tests: ["tests/screen-annotation.e2e.ts"],
  targets: [
    {
      name: "annotation-web",
      engine: web({ viewport: { width: 1260, height: 820 } }),
      app: { url: process.env.CHALK_ANNOTATION_WEB_URL ?? "http://127.0.0.1:3071" },
    },
  ],
  output: ".private/annotation",
  workers: 1,
  retries: 0,
  timeout: 30_000,
} satisfies E2EConfig;
