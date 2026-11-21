import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { centroid, decodeRgb, inkPixel, nearestRank, TARGETS, targetPixel } from "./pixels.mjs";

const SURFACES = new Set(["remote", "sharer_overlay", "export"]);
const ALIGNMENT_COVERAGE = ["portrait", "landscape", "contain", "cover", "resize", "scroll", "tab", "window", "monitor", "mixed_dpi_negative_origin", "android_rotation_insets"];
const NETWORKS = ["controlled", "real_web", "real_mobile"];
const LATENCY_TARGET_MS = { remote: 150, sharer_overlay: 200 };
const PRESENTATION_METHODS = new Set(["synchronized_video", "frame_callback"]);
const SAMPLING = ["macos", "windows", "android"];

function measureAlignment(scenarios, evidenceFile) {
  assert.ok(Array.isArray(scenarios));
  const results = [];
  for (const scenario of scenarios) {
    assert.ok(SURFACES.has(scenario.surface), "invalid alignment surface");
    assert.ok(Array.isArray(scenario.tags) && scenario.tags.every((tag) => ALIGNMENT_COVERAGE.includes(tag)), "invalid alignment tags");
    assert.ok(Array.isArray(scenario.samples) && scenario.samples.length, "alignment has no attempts");
    const errors = [];
    let unmapped = 0;
    let missingMarks = 0;
    for (const sample of scenario.samples) {
      if (sample.mapping === "unmapped") {
        assert.ok(typeof sample.cause === "string" && sample.cause.length > 0, "unmapped attempt needs a cause");
        unmapped++;
        continue;
      }
      assert.equal(sample.mapping, "mapped");
      assert.ok(Number.isFinite(sample.displayedFrameWidthPx) && sample.displayedFrameWidthPx > 0, "invalid mapped frame width");
      const before = evidenceFile(sample.reference);
      const after = evidenceFile(sample.frame);
      assert.equal(before.width, after.width);
      assert.equal(before.height, after.height);
      const target = centroid(before, sample.region, targetPixel);
      assert.ok(target, "reference frame does not contain the expected fiducial");
      assert.equal(centroid(before, sample.region, inkPixel), null, "reference already contains the proof ink color");
      const mark = centroid(after, sample.region, inkPixel);
      if (mark === null) {
        missingMarks++;
        continue;
      }
      errors.push(Math.hypot(target.x - mark.x, target.y - mark.y) / sample.displayedFrameWidthPx);
    }
    const p95 = nearestRank(errors, 0.95);
    const verdict = missingMarks > 0 || (p95 !== null && p95 >= 0.005) ? "fail" : p95 === null ? "unmapped" : "pass";
    results.push({ id: scenario.id, surface: scenario.surface, tags: scenario.tags, samples: errors.length, unmapped, missingMarks, p95FrameWidthFraction: p95, verdict });
  }
  return results;
}

function measureLatency(scenarios) {
  assert.ok(Array.isArray(scenarios));
  return scenarios.map((scenario) => {
    const targetMs = LATENCY_TARGET_MS[scenario.surface];
    assert.ok(targetMs && NETWORKS.includes(scenario.environment), "invalid latency surface or environment");
    const { rttMs, jitterMs, lossPercent } = scenario.network;
    assert.ok([rttMs, jitterMs, lossPercent].every((value) => Number.isFinite(value) && value >= 0) && lossPercent <= 100, "invalid network conditions");
    assert.ok(Number.isFinite(scenario.frameRate) && scenario.frameRate > 0, "invalid presentation rate");
    assert.ok(PRESENTATION_METHODS.has(scenario.presentation), "latency must be based on presented frames, not receipts");
    const { receiverMinusSenderMs, uncertaintyMs, domain } = scenario.clock;
    assert.ok(Number.isFinite(receiverMinusSenderMs) && Number.isFinite(uncertaintyMs) && uncertaintyMs >= 0, "invalid clock alignment");
    if (domain === "same_monotonic_clock") {
      assert.equal(receiverMinusSenderMs, 0);
    } else {
      assert.equal(domain, "synchronized_monotonic_clocks");
    }
    assert.ok(Array.isArray(scenario.samples), "latency has no attempts");
    const ids = new Set();
    const previews = [];
    const commits = [];
    let previousReleaseMs = -Infinity;
    for (const sample of scenario.samples) {
      assert.ok(typeof sample.id === "string" && sample.id.length && !ids.has(sample.id), "missing or duplicated latency sample ID");
      ids.add(sample.id);
      assert.ok(Number.isFinite(sample.pointerMs) && sample.pointerMs > previousReleaseMs, "samples must be spaced after the previous release");
      assert.ok(Number.isFinite(sample.releaseMs) && sample.releaseMs >= sample.pointerMs, "invalid pointer release time");
      previousReleaseMs = sample.releaseMs;
      addLatency(previews, sample.previewPresentedMs, sample.pointerMs, receiverMinusSenderMs, uncertaintyMs);
      addLatency(commits, sample.committedPresentedMs, sample.releaseMs, receiverMinusSenderMs, uncertaintyMs);
    }
    const attempts = scenario.samples.length;
    const preview = summarizeLatency(previews, attempts, uncertaintyMs);
    const commit = summarizeLatency(commits, attempts, uncertaintyMs);
    const excessiveLoss = Math.max(preview.missing, commit.missing) > attempts / 100;
    const verdict = attempts < 100 ? "incomplete" : excessiveLoss || preview.p95UpperMs >= targetMs ? "fail" : "pass";
    return {
      id: scenario.id,
      surface: scenario.surface,
      environment: scenario.environment,
      network: scenario.network,
      clock: scenario.clock,
      presentation: scenario.presentation,
      frameRate: scenario.frameRate,
      attempts,
      preview,
      commit,
      targetMs,
      verdict,
    };
  });
}

function addLatency(values, presentedMs, fromMs, offsetMs, uncertaintyMs) {
  if (presentedMs === null) return;
  assert.ok(Number.isFinite(presentedMs), "missing paints must be null, not omitted");
  const delayMs = presentedMs - offsetMs - fromMs;
  assert.ok(delayMs >= -uncertaintyMs, "presented before input outside reported clock error");
  values.push(Math.max(0, delayMs));
}

function summarizeLatency(values, attempts, uncertaintyMs) {
  const p95 = nearestRank(values, 0.95);
  return { samples: values.length, missing: attempts - values.length, p50Ms: nearestRank(values, 0.5), p95Ms: p95, p95UpperMs: p95 === null ? null : p95 + uncertaintyMs };
}

function measureExclusion(scenarios, evidenceFile) {
  assert.ok(Array.isArray(scenarios));
  return scenarios.map((scenario) => {
    assert.ok(SAMPLING.includes(scenario.platform), "invalid exclusion platform");
    const overlay = evidenceFile(scenario.overlay.frame);
    const mark = centroid(overlay, scenario.overlay.region, inkPixel);
    const tracks = ["outgoing", "remote"].map((kind) => {
      const sample = scenario[kind];
      const before = evidenceFile(sample.before);
      const after = evidenceFile(sample.during);
      assert.equal(before.width, after.width);
      assert.equal(before.height, after.height);
      const pristine = centroid(before, sample.region, targetPixel);
      const current = centroid(after, sample.region, targetPixel);
      const baselineInk = centroid(before, sample.region, inkPixel);
      const capturedInk = centroid(after, sample.region, inkPixel);
      const verdict = pristine && current && !baselineInk && !capturedInk ? "pass" : "fail";
      return { kind, verdict };
    });
    return { id: scenario.id, platform: scenario.platform, tracks, verdict: mark && tracks.every((track) => track.verdict === "pass") ? "pass" : "fail" };
  });
}

const [mode, filename] = process.argv.slice(2);
if (mode === "fixture" && filename) {
  const output = resolve(filename);
  mkdirSync(dirname(output), { recursive: true });
  const canvas = `<!doctype html><meta charset="utf-8"><title>Annotation fiducial capture</title>
<style>html,body,canvas{margin:0;width:100%;height:100%;display:block;background:#222}</style>
<canvas aria-label="Five asymmetric orange crosshairs"></canvas>
<script>
const points = ${JSON.stringify(TARGETS)};
const canvas = document.querySelector("canvas");
function draw() {
  canvas.width = Math.round(innerWidth * devicePixelRatio);
  canvas.height = Math.round(innerHeight * devicePixelRatio);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#222222";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ff9e2a";
  const radius = Math.max(8, Math.min(canvas.width, canvas.height) * 0.02);
  for (const point of points) {
    const x = point.x * canvas.width;
    const y = point.y * canvas.height;
    ctx.fillRect(x - radius, y - 2, radius * 2, 4);
    ctx.fillRect(x - 2, y - radius, 4, radius * 2);
  }
}
addEventListener("resize", draw);
draw();
</script>\n`;
  writeFileSync(output, canvas, { flag: "wx" });
  process.stdout.write(`${output}\n`);
} else if (mode === "measure" && filename) {
  const bundle = JSON.parse(readFileSync(filename, "utf8"));
  assert.equal(bundle.version, 1, "unsupported measurement bundle");
  const root = realpathSync(dirname(filename));
  let lastImage = null;
  const evidenceFile = ({ path, frame = 0 }) => {
    assert.equal(isAbsolute(path), false, "evidence path must be relative");
    assert.ok(Number.isSafeInteger(frame) && frame >= 0, "invalid frame index");
    const file = realpathSync(join(root, path));
    const fromRoot = relative(root, file);
    assert.ok(fromRoot && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`), "evidence file escapes bundle");
    if (lastImage?.file === file && lastImage.frame === frame) return lastImage.image;
    const image = decodeRgb(file, frame);
    lastImage = { file, frame, image };
    return image;
  };
  const alignment = measureAlignment(bundle.alignment, evidenceFile);
  const latency = measureLatency(bundle.latency);
  const exclusion = measureExclusion(bundle.exclusion, evidenceFile);
  const coverage = {
    missingAlignmentTags: ALIGNMENT_COVERAGE.filter((tag) => !alignment.some((result) => result.tags.includes(tag))),
    missingAlignmentSurfaces: [...SURFACES].filter((surface) => !alignment.some((result) => result.surface === surface && result.verdict === "pass")),
    missingLatency: Object.keys(LATENCY_TARGET_MS).flatMap((surface) => NETWORKS.filter((environment) => !latency.some((result) => result.surface === surface && result.environment === environment && result.verdict === "pass")).map((environment) => `${surface}/${environment}`)),
    missingExclusionPlatforms: SAMPLING.filter((platform) => !exclusion.some((result) => result.platform === platform && result.verdict === "pass")),
  };
  const results = [...alignment, ...latency, ...exclusion];
  const verdict = results.some((result) => result.verdict === "fail") ? "fail" : results.some((result) => result.verdict === "incomplete") || Object.values(coverage).some((missing) => missing.length > 0) ? "incomplete" : "pass";
  process.stdout.write(`${JSON.stringify({ verdict, coverage, alignment, latency, exclusion }, null, 2)}\n`);
  if (verdict !== "pass") process.exitCode = 1;
} else {
  process.stderr.write("Usage: node measure.mjs fixture <capture.html> | measure <bundle.json>\n");
  process.exitCode = 2;
}
