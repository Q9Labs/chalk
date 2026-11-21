import { helperDeviceAction } from "../src/lib/dashboard/helper-device-contracts";
import type { DashboardEnvironment } from "./config";
import { body, DashboardError, json } from "./http";

export async function helperDevices(request: Request, env: DashboardEnvironment, tenantId: string): Promise<Response> {
  const action = request.method === "POST" ? helperDeviceAction.parse(await body(request)) : undefined;
  const path = `/v1/tenants/${tenantId}/helper-devices${action ? "/" + action.action : ""}`;
  const reply = await fetch(new URL(path, env.CHALK_API_ORIGIN), {
    method: request.method,
    headers: { Authorization: `Bearer ${env.DASHBOARD_SERVICE_TOKEN}`, "Content-Type": "application/json" },
    body: action && JSON.stringify(Object.fromEntries(Object.entries(action).filter(([key]) => key !== "action"))),
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!reply.ok) {
    if (reply.status === 429) throw new DashboardError(429, "rate_limited");
    if (reply.status === 401 || reply.status === 403) throw new DashboardError(403, "helper_device_unavailable");
    throw new DashboardError(503, "helper_device_unavailable");
  }
  return reply.status === 204 ? json({ ok: true }) : json(await reply.json());
}
