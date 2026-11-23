import type { TransportDiagnostic } from "../transport-diagnostics";

type NetworkType = NonNullable<TransportDiagnostic["network_type"]>;

const NETWORK_TYPES: ReadonlySet<unknown> = new Set<NetworkType>(["bluetooth", "cellular", "ethernet", "none", "other", "unknown", "wifi", "wimax"]);
const isNetworkType = (value: unknown): value is NetworkType => NETWORK_TYPES.has(value);

/** The connection type the browser reports through the Network Information API, or nothing where the platform does not offer it. It is never inferred. */
export function reportedNetworkType(): NetworkType | undefined {
  if (typeof navigator !== "object" || navigator === null || !("connection" in navigator)) return undefined;
  const { connection } = navigator;
  if (typeof connection !== "object" || connection === null || !("type" in connection)) return undefined;
  const { type } = connection;
  return isNetworkType(type) ? type : undefined;
}
