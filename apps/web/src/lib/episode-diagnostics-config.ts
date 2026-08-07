const EPISODE_DIAGNOSTICS_MODES = ["off", "localhost", "hosted"] as const;
export type EpisodeDiagnosticsMode = (typeof EPISODE_DIAGNOSTICS_MODES)[number];

const EPISODE_DIAGNOSTICS_ENVIRONMENTS = ["localhost", "development", "staging", "production"] as const;
export type EpisodeDiagnosticsEnvironment = (typeof EPISODE_DIAGNOSTICS_ENVIRONMENTS)[number];

export type EpisodeDiagnosticsConfig = Readonly<{
  enabled: boolean;
  mode: EpisodeDiagnosticsMode;
  environment: EpisodeDiagnosticsEnvironment;
}>;

export const HOSTED_EPISODE_DIAGNOSTICS_GATEWAY_CONTRACT = Object.freeze({
  path: "/_internal/episode-diagnostics",
  configuration: "CHALK_EPISODE_DIAGNOSTICS_GATEWAY=verified",
  browserCredentials: "same-origin",
  browserAuthorizationHeader: false,
  gatewayAuthorizationHeader: "authorization",
  gatewayResponsibility: "authenticate the operator and inject an environment-owned diagnostics bearer token upstream",
});

export class EpisodeDiagnosticsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpisodeDiagnosticsConfigError";
  }
}

const includes = <T extends string>(values: readonly T[], value: string): value is T => (values as readonly string[]).includes(value);

export const resolveEpisodeDiagnosticsConfig = (modeInput: string | undefined, environmentInput: string | undefined, hostedGatewayInput?: string): EpisodeDiagnosticsConfig => {
  const mode = modeInput?.trim() || "off";
  const environment = environmentInput?.trim() || "production";

  if (!includes(EPISODE_DIAGNOSTICS_MODES, mode)) {
    throw new EpisodeDiagnosticsConfigError(`CHALK_EPISODE_DIAGNOSTICS must be one of ${EPISODE_DIAGNOSTICS_MODES.join("|")}; received ${mode}`);
  }
  if (!includes(EPISODE_DIAGNOSTICS_ENVIRONMENTS, environment)) {
    throw new EpisodeDiagnosticsConfigError(`CHALK_ENVIRONMENT must be one of ${EPISODE_DIAGNOSTICS_ENVIRONMENTS.join("|")}; received ${environment}`);
  }
  if (environment === "production" && mode !== "off") {
    throw new EpisodeDiagnosticsConfigError("Episode diagnostics must be off in production; the route and proxy are omitted from the build");
  }
  if (mode === "localhost" && environment !== "localhost") {
    throw new EpisodeDiagnosticsConfigError("Episode diagnostics localhost mode requires CHALK_ENVIRONMENT=localhost");
  }
  if (mode === "hosted" && environment !== "development" && environment !== "staging") {
    throw new EpisodeDiagnosticsConfigError("Episode diagnostics hosted mode requires CHALK_ENVIRONMENT=development or staging");
  }
  if (mode === "hosted" && hostedGatewayInput?.trim() !== "verified") {
    throw new EpisodeDiagnosticsConfigError("Episode diagnostics hosted mode requires CHALK_EPISODE_DIAGNOSTICS_GATEWAY=verified after the same-origin operator gateway is configured");
  }

  return { enabled: mode !== "off", mode, environment };
};

export const isLoopbackHostname = (hostname: string): boolean => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
