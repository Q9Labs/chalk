import { DEVICE_SCENARIOS } from "../metrics.mjs";
import { metric, passMetric } from "./metric.mjs";

/**
 * deviceMetrics maps the file the device lane writes (shape in README.md): per scenario, a list of runs
 * with whether each passed and how long it took. Only passing runs are timed.
 */
export function deviceMetrics(file) {
  const source = "device-lane";
  const metrics = [];
  const dropped = [];
  for (const scenario of file.scenarios) {
    const known = DEVICE_SCENARIOS[scenario.name];
    if (!known) throw new Error(`Unknown device scenario ${scenario.name}`);
    const passed = scenario.runs.filter((run) => run.passed);
    metrics.push(
      metric(
        known.timing,
        passed.map((run) => run.ms),
        source,
      ),
    );
    metrics.push(
      passMetric(
        `device.${scenario.name}.pass`,
        scenario.runs.map((run) => run.passed),
        source,
      ),
    );
    if (passed.length < scenario.runs.length) dropped.push({ metric: known.timing, reason: "run_failed", count: scenario.runs.length - passed.length });
  }
  return { metrics, dropped };
}
