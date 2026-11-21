import { z } from "zod";
import { dashboardPost } from "./client";

import type { HelperDeviceAction } from "./helper-device-contracts";

export const helperDeviceOffer = z.object({ requestId: z.uuid(), name: z.string(), fingerprint: z.string().regex(/^[A-Z2-9]{8}$/) });
const helperDevices = z.object({ devices: z.array(z.object({ deviceId: z.uuid(), name: z.string() })) });

const helperPath = "/dashboard-api/helper-devices";

export async function manageHelperDevice(action: HelperDeviceAction, signal?: AbortSignal): Promise<Response> {
  const response = await dashboardPost(helperPath, action, signal);
  if (!response.ok) throw new Error("The Helper request could not be completed.");
  return response;
}

export async function listHelperDevices(signal?: AbortSignal) {
  const response = await fetch(helperPath, { cache: "no-store", redirect: "error", signal });
  if (!response.ok) throw new Error("Couldn’t load Chalk Helper devices.");
  return helperDevices.parse(await response.json()).devices;
}
