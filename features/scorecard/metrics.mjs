// The metric families beyond action.*: web.*, sfu.*, proof.* and device.*. schema.mjs merges them into METRICS.
// Ids are stable and dotted. Renaming one, or changing its unit, breaks history, so add a new id instead.

// The web call check's metrics: its own name, the id segment and the unit.
export const CALL_METRICS = {
  videoDroppedFramePercent: { segment: "video_dropped_frame_pct", unit: "percent", description: "Video frames dropped" },
  layoutShift: { segment: "layout_shift", unit: "score", description: "Cumulative layout shift" },
  frameP95Ms: { segment: "frame_p95_ms", unit: "ms", description: "p95 frame time" },
  droppedFramePercent: { segment: "dropped_frame_pct", unit: "percent", description: "Frames dropped" },
  longTasks: { segment: "long_tasks", unit: "count", description: "Long main-thread tasks" },
  blockingMs: { segment: "blocking_ms", unit: "ms", description: "Total main-thread blocking time" },
  interactionMs: { segment: "interaction_ms", unit: "ms", description: "Click to next paint" },
  heapMiB: { segment: "heap_mib", unit: "mib", description: "JavaScript heap" },
  domNodes: { segment: "dom_nodes", unit: "count", description: "DOM nodes" },
  firstCallMs: { segment: "first_call_ms", unit: "ms", description: "Navigation until the call is on screen" },
  jsGzipKiB: { segment: "js_gzip_kib", unit: "kib", description: "Gzipped JavaScript the scenario loads" },
  cssGzipKiB: { segment: "css_gzip_kib", unit: "kib", description: "Gzipped CSS the scenario loads" },
};
export const ROUTE_METRICS = {
  routeJsGzipKiB: { segment: "js_gzip_kib", unit: "kib", description: "Gzipped JavaScript the pre-join route loads" },
  routeCssGzipKiB: { segment: "css_gzip_kib", unit: "kib", description: "Gzipped CSS the pre-join route loads" },
};
const CALL_DEVICES = ["laptop", "phone"];
const CALL_SCENARIOS = ["calm-six", "grid-24", "panels", "spotlight-share", "board", "reactions", "reconnect", "first-load"];

export const callMetricId = (device, scenario, metric) => `web.${device}.${scenario}.${CALL_METRICS[metric].segment}`;
export const routeMetricId = (metric) => `web.route.${ROUTE_METRICS[metric].segment}`;

const web = {};
for (const metric of Object.keys(ROUTE_METRICS)) web[routeMetricId(metric)] = { unit: ROUTE_METRICS[metric].unit, description: ROUTE_METRICS[metric].description };
for (const device of CALL_DEVICES) {
  for (const scenario of CALL_SCENARIOS) {
    for (const [metric, { unit, description }] of Object.entries(CALL_METRICS)) {
      if (metric === "firstCallMs" && scenario !== "first-load") continue;
      web[callMetricId(device, scenario, metric)] = { unit, description: `${description}, ${scenario} on ${device}` };
    }
  }
}

// sfu.*: "per class" is one class of three Participants on the own SFU. Values are normalised by the classes held.
const sfu = {
  "sfu.cpu_work_pct_per_class": { unit: "percent", description: "Node CPU busy minus steal, per class" },
  "sfu.pps_in_per_class": { unit: "pps", description: "Packets per second received by the node, per class" },
  "sfu.pps_out_per_class": { unit: "pps", description: "Packets per second sent by the node, per class" },
  "sfu.egress_mbit_s_per_class": { unit: "mbit_s", description: "Egress in Mbit/s, per class" },
  "sfu.loss_pct": { unit: "percent", description: "Media packets a receiver expected and did not get" },
  "sfu.stalls_per_class_hour": { unit: "count", description: "Camera, screen and audio stalls, per class-hour" },
  "sfu.freeze_ms_per_minute": { unit: "ms", description: "Video frozen, in milliseconds per minute" },
  "sfu.admission_refusals": { unit: "count", description: "Samples in which the node refused new Episodes" },
  "sfu.loopback.pass": { unit: "pass", description: "Share of loopback tests that passed (real HTTP and real Pion peers)" },
  "sfu.impairment.pass": { unit: "pass", description: "Share of impaired-network tests that passed (loss, delay and rate limits)" },
};

const proof = {
  "proof.leave_median_ms": { unit: "ms", description: "Leave proof: median time until the leave is confirmed" },
};

// device.*: a mobile device's own scenarios, written by the device lane in the shape README.md documents.
export const DEVICE_SCENARIOS = {
  network_switch: { timing: "device.reconnect_ms", description: "after a network switch, time until the call reconnects" },
  background_resume: { timing: "device.background_resume_ms", description: "after 30 to 60 s in the background, time until media flows again" },
  ice_restart: { timing: "device.ice_restart_ms", description: "ICE restart time" },
};
const device = {};
for (const [name, { timing, description }] of Object.entries(DEVICE_SCENARIOS)) {
  device[timing] = { unit: "ms", description: `Device: ${description}` };
  device[`device.${name}.pass`] = { unit: "pass", description: `Device: share of ${name} runs that passed` };
}

export const FAMILY_METRICS = { ...web, ...sfu, ...proof, ...device };
