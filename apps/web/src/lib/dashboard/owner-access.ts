import { DashboardRequestError } from "./client";

/** Use the SDK's HTTP access contract, rather than disguising denials as outages. */
export function dashboardAccessFailure(error: unknown): Response {
  if (error instanceof DashboardRequestError && error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status)) return Response.json({ error: { code: error.code } }, { status: error.status });
  throw error;
}
