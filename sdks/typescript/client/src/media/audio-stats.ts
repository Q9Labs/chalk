export type AudioStats = { bytesReceived?: number };

export function audioStats(report: RTCStatsReport | undefined): Map<string, AudioStats> {
  const result = new Map<string, AudioStats>();
  report?.forEach((row) => {
    if (row.type === "inbound-rtp" && row.kind === "audio" && typeof row.trackIdentifier === "string") result.set(row.trackIdentifier, row);
  });
  return result;
}

export function increased(current: number | undefined, previous: number | undefined): boolean {
  return current !== undefined && previous !== undefined && current > previous;
}

export async function readStats(connection: RTCPeerConnection | null): Promise<RTCStatsReport | undefined> {
  try {
    return await connection?.getStats();
  } catch {
    return undefined;
  }
}
