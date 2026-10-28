import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { webMediaFixture } from "./scripts/web-proof/media.mjs";

const engine = web({ viewport: { width: 1440, height: 960 }, initScripts: [webMediaFixture(1)] });

export default {
  tests: process.env.CHALK_CLASS_CHECKLIST === "1" ? ["tests/class-checklist.e2e.ts"] : ["tests/call.e2e.ts", "tests/board.e2e.ts"],
  targets: [{ name: "web", engine, app: { url: process.env.CHALK_PROOF_WEB_URL ?? "http://localhost:3000" } }],
  workers: 1,
  retries: 0,
  timeout: process.env.CHALK_CLASS_CHECKLIST === "1" ? 660_000 : 240_000,
  cleanupTimeout: 30_000,
  output: ".private/web-proof/e2e",
  trace: "off",
  video: "off",
} satisfies E2EConfig;
