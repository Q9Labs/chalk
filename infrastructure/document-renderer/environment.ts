import type { DocumentRendererInputs } from "./config.ts";

export const buildEnvironment = (input: DocumentRendererInputs): { [key: string]: string } => ({
  CHALK_ENVIRONMENT: String(input.environment_name),
  CHALK_RELEASE_ID: String(input.release_id),
  CHALK_RELEASE_MANIFEST_DIGEST: String(input.release_manifest_digest),
  CHALK_CONFIG_DIGEST: String(input.config_digest),
  CONTROL_API_BASE_URL: String(input.control_api_url),
  LD_LIBRARY_PATH: "/var/task/lib",
});
