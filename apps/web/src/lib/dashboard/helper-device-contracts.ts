import { z } from "zod";

export const helperDeviceAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("lookup"), code: z.string().max(16) }),
  z.strictObject({
    action: z.literal("approve"),
    requestId: z.uuid(),
    mediaProof: z.string().min(1).max(4096),
    layerId: z.uuid(),
    publicationId: z.string().min(1).max(512),
    refresh: z.boolean(),
  }),
  z.strictObject({ action: z.literal("revoke"), deviceId: z.uuid() }),
]);

export type HelperDeviceAction = z.infer<typeof helperDeviceAction>;
