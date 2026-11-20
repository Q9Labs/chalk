import { LEGACY, type EventName } from "./registry.ts";

// Names the registry event an older row stands for, such as an sdk.telemetry row of type call_ended, so readers
// can treat rows written before the kernel the same way as kernel records.
export function legacyEventName(row: { readonly [field: string]: unknown }): EventName | undefined {
  return LEGACY.find((entry) => Object.entries(entry.match).every(([field, value]) => row[field] === value))?.event;
}
