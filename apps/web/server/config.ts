import { z } from "zod";

const environmentSchema = z.object({
  CHALK_ENVIRONMENT: z.enum(["local", "test", "staging", "production"]),
  CHALK_API_ORIGIN: z.url(),
  DASHBOARD_ORIGIN: z.url(),
  WORKOS_REDIRECT_URI: z.url(),
  WORKOS_CLIENT_ID: z.string().min(1),
  WORKOS_API_KEY: z.string().min(1),
  WORKOS_COOKIE_PASSWORD: z.string().min(32),
  DASHBOARD_SERVICE_TOKEN: z.string().min(1),
  DASHBOARD_IDENTITY_PROVIDER: z.enum(["workos", "fixture"]).default("workos"),
});
export type DashboardEnvironment = z.infer<typeof environmentSchema>;
export type DashboardBindings = { [K in keyof DashboardEnvironment]: string };
export function configuration(bindings: DashboardBindings): DashboardEnvironment {
  const env = environmentSchema.parse(bindings);
  const origin = new URL(env.DASHBOARD_ORIGIN);
  const local = env.CHALK_ENVIRONMENT === "local" || env.CHALK_ENVIRONMENT === "test";
  if (origin.origin !== env.DASHBOARD_ORIGIN || (!local && origin.protocol !== "https:")) throw new Error("Invalid dashboard origin");
  if (env.WORKOS_REDIRECT_URI !== `${origin.origin}/auth/callback`) throw new Error("Callback must be the fixed dashboard callback");
  if (!local && env.DASHBOARD_IDENTITY_PROVIDER !== "workos") throw new Error("Fixture identity is local/test only");
  if (!local && new URL(env.CHALK_API_ORIGIN).protocol !== "https:") throw new Error("Engine HTTPS required");
  if (local && origin.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) throw new Error("Local HTTP must use loopback");
  return env;
}
