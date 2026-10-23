import { z } from "zod";

const environmentSchema = z.object({
  CHALK_ENVIRONMENT: z.enum(["local", "test", "staging", "nightly", "production"]),
  CHALK_API_ORIGIN: z.url(),
  DASHBOARD_ORIGIN: z.url(),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  APPLE_SERVICES_ID: z.string().min(1),
  APPLE_TEAM_ID: z.string().min(1),
  APPLE_KEY_ID: z.string().min(1),
  APPLE_PRIVATE_KEY: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  DASHBOARD_SERVICE_TOKEN: z.string().min(1),
  DASHBOARD_IDENTITY_PROVIDER: z.enum(["oauth", "fixture"]).default("oauth"),
});
export type DashboardEnvironment = z.infer<typeof environmentSchema>;
export type DashboardBindings = { [K in keyof DashboardEnvironment]: string };
export function configuration(bindings: DashboardBindings): DashboardEnvironment {
  const env = environmentSchema.parse(bindings);
  const origin = new URL(env.DASHBOARD_ORIGIN);
  const local = env.CHALK_ENVIRONMENT === "local" || env.CHALK_ENVIRONMENT === "test";
  if (origin.origin !== env.DASHBOARD_ORIGIN || (!local && origin.protocol !== "https:")) throw new Error("Invalid dashboard origin");
  if (!local && env.DASHBOARD_IDENTITY_PROVIDER !== "oauth") throw new Error("Fixture identity is local/test only");
  if (!local && new URL(env.CHALK_API_ORIGIN).protocol !== "https:") throw new Error("Engine HTTPS required");
  if (local && origin.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) throw new Error("Local HTTP must use loopback");
  return env;
}
