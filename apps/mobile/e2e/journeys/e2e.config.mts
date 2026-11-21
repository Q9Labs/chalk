import type { E2EConfig } from "e2e";
import { mobile } from "@e2e-dev/mobile";

const bundleId = "ai.q9labs.chalk.mobile";

export default {
  tests: "**/*.e2e.mts",
  workers: 1,
  targets: [
    { name: "iphone", engine: mobile({ platform: "ios", device: process.env.CHALK_ANNOTATION_IPHONE }), app: { bundleId } },
    { name: "ipad", engine: mobile({ platform: "ios", device: process.env.CHALK_ANNOTATION_IPAD }), app: { bundleId } },
    { name: "android", engine: mobile({ platform: "android", device: process.env.CHALK_ANNOTATION_ANDROID }), app: { bundleId } },
  ],
} satisfies E2EConfig;
