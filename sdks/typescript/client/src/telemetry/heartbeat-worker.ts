/**
 * The heartbeat worker's own source, kept as text so the main thread starts it from a Blob URL and the bundle needs no
 * worker entry. It ticks every second, measures how late its own tick ran (worker or process suspension), pings the main
 * thread each second and measures the round trip (main-thread blockage), and reports one late tick over 45 s as a
 * client.timer_throttled candidate.
 */
export const HEARTBEAT_WORKER_SOURCE = `
let lastTick = Date.now();
let tickLate = 0;
setInterval(() => {
  const now = Date.now();
  tickLate = Math.max(tickLate, now - lastTick - 1000);
  lastTick = now;
}, 1000);
let pingAt = 0;
setInterval(() => {
  pingAt = Date.now();
  postMessage({ t: "ping" });
}, 1000);
onmessage = (event) => {
  const data = event.data;
  if (data && data.t === "pong") postMessage({ t: "ping_ms", ms: Date.now() - pingAt });
  if (data && data.t === "collect") { postMessage({ t: "tick_late", ms: tickLate, last: lastTick }); tickLate = 0; }
  if (data && data.t === "stop") close();
};
`;

export type HeartbeatWorkerMessage =
  | { readonly t: "ping" }
  | { readonly t: "ping_ms"; readonly ms: number }
  | { readonly t: "tick_late"; readonly ms: number; readonly last: number };
