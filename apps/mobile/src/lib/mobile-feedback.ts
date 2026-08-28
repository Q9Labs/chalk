import Constants from "expo-constants";
import type { FeedbackEvidenceInput } from "@q9labsai/chalk-client";

export function getMobileFeedbackEvidence(): Partial<FeedbackEvidenceInput> {
  const version = nonEmptyString(Constants.nativeAppVersion) ?? nonEmptyString(Constants.expoConfig?.version);
  const build = nonEmptyString(Constants.nativeBuildVersion);
  return {
    app: {
      name: "Chalk",
      ...(version ? { version } : {}),
      ...(build ? { build } : {}),
    },
  };
}

function nonEmptyString(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 64) : undefined;
}
