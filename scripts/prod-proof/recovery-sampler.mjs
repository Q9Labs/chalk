// Page code of the recovery run (recovery.mjs installs it as a function in each guest page).
/** Runs in a guest page: every 100 ms records whether media arrived since the last tick and the SDK status. */
export function installRecoverySampler() {
  const now = () => performance.timeOrigin + performance.now();
  const samples = [];
  const previous = new Map();
  async function tick() {
    let fa = false;
    let fv = false;
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
        }
      }
    } catch {
      // A peer that closes mid-read gives no sample for this tick.
    }
    const status = window.proofClient?.getSnapshot()?.connection.status ?? null;
    samples.push({ t: now(), fa, fv, status: typeof status === "string" ? status : null });
  }
  const loop = async () => {
    await tick();
    setTimeout(loop, 100);
  };
  void loop();
  window.proofSampler = { take: () => samples.splice(0) };
}
