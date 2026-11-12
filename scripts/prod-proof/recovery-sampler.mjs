// Page code of the recovery run (recovery.mjs installs it as a function in each guest page).
/**
 * Runs in a guest page: every 100 ms records whether media arrived since the last tick and the SDK status, and the running totals of
 * received video bytes (vb) and decoded frames (vf) with the width of the frame being decoded (vw), so a run can plot bitrate, frame
 * rate and layer.
 */
export function installRecoverySampler() {
  const now = () => performance.timeOrigin + performance.now();
  const samples = [];
  const previous = new Map();
  let videoBytes = 0;
  let videoFrames = 0;
  async function tick() {
    let fa = false;
    let fv = false;
    let width = 0;
    try {
      for (const [index, peer] of (window.proofConnections ?? []).entries()) {
        if (peer.connectionState === "closed") continue;
        for (const row of (await peer.getStats()).values()) {
          if (row.type !== "inbound-rtp") continue;
          const key = `${index}:${row.id}`;
          const count = (row.kind === "video" ? row.framesDecoded : row.packetsReceived) ?? 0;
          // A connection the SDK built after the fault starts its counters at zero: its first packets count as flow.
          if (count > (previous.get(key) ?? 0)) row.kind === "video" ? (fv = true) : (fa = true);
          previous.set(key, count);
          if (row.kind === "video") {
            const bytesKey = `${key}:bytes`;
            videoBytes += Math.max(0, (row.bytesReceived ?? 0) - (previous.get(bytesKey) ?? 0));
            previous.set(bytesKey, row.bytesReceived ?? 0);
            videoFrames += Math.max(0, count - (previous.get(`${key}:frames`) ?? 0));
            previous.set(`${key}:frames`, count);
            width = Math.max(width, row.frameWidth ?? 0);
          }
        }
      }
    } catch {
      // A peer that closes mid-read gives no sample for this tick.
    }
    const status = window.proofClient?.getSnapshot()?.connection.status ?? null;
    samples.push({ t: now(), fa, fv, vb: videoBytes, vf: videoFrames, vw: width, status: typeof status === "string" ? status : null });
  }
  const loop = async () => {
    await tick();
    setTimeout(loop, 100);
  };
  void loop();
  window.proofSampler = { take: () => samples.splice(0) };
}
