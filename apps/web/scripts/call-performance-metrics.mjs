export const METRICS = ["frameP95Ms", "droppedFramePercent", "longTasks", "blockingMs", "interactionMs", "heapMiB", "domNodes", "firstCallMs", "jsGzipKiB", "cssGzipKiB"];
export const BUNDLE_METRICS = ["jsGzipKiB", "cssGzipKiB"];

export function validateBudgets(budgets) {
  if (!/^[a-f0-9]{40}$/.test(budgets.baselineCommit)) throw new Error("Budget baseline must be a full commit SHA");
  if (!Number.isInteger(budgets.repeats) || budgets.repeats < 5) throw new Error("Budgets require at least five repetitions");
  if (!Number.isFinite(budgets.sampleMs) || budgets.sampleMs < 3000) throw new Error("Scenario windows must be at least 3000 ms");
  for (const metric of [...METRICS, "routeJsGzipKiB", "routeCssGzipKiB"]) {
    if (!Number.isFinite(budgets.limits[metric]) || budgets.limits[metric] < 0) throw new Error(`Missing/invalid budget: ${metric}`);
  }
  for (const name of ["laptop", "phone"]) {
    const device = budgets.devices[name];
    if (!device || !Number.isFinite(device.cpu) || device.cpu < 1 || !Number.isInteger(device.viewport.width) || !Number.isInteger(device.viewport.height) || typeof device.touch !== "boolean") throw new Error(`Invalid device profile: ${name}`);
  }
  for (const device of Object.values(budgets.scenarios ?? {})) {
    for (const limits of Object.values(device)) {
      for (const [metric, value] of Object.entries(limits)) {
        if (!METRICS.includes(metric) || !Number.isFinite(value) || value < 0) throw new Error(`Invalid scenario budget: ${metric}`);
      }
    }
  }
}

export function percentile(values, p) {
  if (!values.length || values.some((value) => !Number.isFinite(value))) throw new Error("Missing or invalid measurement");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1];
}

export function summarize(samples) {
  return Object.fromEntries(
    Object.keys(samples[0])
      .filter((key) => typeof samples[0][key] === "number")
      .map((key) => {
        const values = samples.map((sample) => sample[key]);
        return [key, { median: percentile(values, 0.5), min: Math.min(...values), max: Math.max(...values) }];
      }),
  );
}

export function budgetFailures(summary, limits, metrics) {
  return metrics.flatMap((metric) => {
    if (!Number.isFinite(summary[metric]?.median) || !Number.isFinite(limits[metric])) throw new Error(`Missing measurement or limit: ${metric}`);
    return summary[metric].median > limits[metric] ? [`${metric} ${summary[metric].median.toFixed(2)} > ${limits[metric]}`] : [];
  });
}

export function trustedInteractionMs(events, inputs) {
  if (events.some((entry) => !Number.isFinite(entry.startTime))) throw new Error("Event Timing entries must retain startTime for trusted-input matching");
  const matching = events.filter((entry) => inputs.some((input) => input.name === entry.name && Math.abs(input.at - entry.startTime) < 1));
  return Math.max(0, ...matching.map((entry) => entry.duration));
}
