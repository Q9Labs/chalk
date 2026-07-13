#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";

export const CAPTURE_LIMITS = Object.freeze({
  maxMeetings: 20,
  maxParticipants: 100,
  maxNodes: 11,
});

export const RENDER_LIMITS = Object.freeze({
  maxNodes: 10,
  globalComputeNodes: 21,
  subBudgetMinutes: 20,
});

function assertInteger(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function assertNonNegative(name, value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
}

// fallow-ignore-next-line complexity
export function desiredCaptureNodes({ meetings, participants, inputMbps, meetingsPerNode = 4, participantsPerNode = 40, inputMbpsPerNode = 16, readySpare = 0 }) {
  assertInteger("meetings", meetings, 0, CAPTURE_LIMITS.maxMeetings);
  assertInteger("participants", participants, 0, CAPTURE_LIMITS.maxParticipants);
  assertNonNegative("inputMbps", inputMbps);
  assertNonNegative("meetingsPerNode", meetingsPerNode);
  assertNonNegative("participantsPerNode", participantsPerNode);
  assertNonNegative("inputMbpsPerNode", inputMbpsPerNode);
  assertInteger("readySpare", readySpare, 0, 1);
  if (meetingsPerNode === 0 || participantsPerNode === 0 || inputMbpsPerNode === 0) {
    throw new Error("capture density must be positive");
  }

  const meetingNodes = Math.ceil(meetings / meetingsPerNode);
  const participantNodes = Math.ceil(participants / participantsPerNode);
  const bitrateNodes = Math.ceil(inputMbps / inputMbpsPerNode);
  const desired = Math.max(meetingNodes, participantNodes, bitrateNodes) + readySpare;
  if (desired > CAPTURE_LIMITS.maxNodes) {
    throw new Error(`capture demand requires ${desired} nodes, above the qualified ${CAPTURE_LIMITS.maxNodes}-node bound`);
  }
  return desired;
}

function canPackJobs(jobs, nodeCount, capacity) {
  const loads = Array.from({ length: nodeCount }, () => 0);
  const ordered = [...jobs].sort((left, right) => left.deadlineMinutes - right.deadlineMinutes || right.serviceMinutes - left.serviceMinutes);

  // fallow-ignore-next-line complexity
  function place(index) {
    if (index === ordered.length) return true;
    const job = ordered[index];
    const seen = new Set();
    for (let node = 0; node < loads.length; node += 1) {
      const nextLoad = loads[node] + job.serviceMinutes;
      if (nextLoad > capacity || nextLoad > job.deadlineMinutes || seen.has(loads[node])) continue;
      seen.add(loads[node]);
      loads[node] = nextLoad;
      if (place(index + 1)) return true;
      loads[node] -= job.serviceMinutes;
    }
    return false;
  }

  return place(0);
}

// fallow-ignore-next-line complexity
export function minimumRenderNodes(jobs, { subBudgetMinutes = RENDER_LIMITS.subBudgetMinutes, maxNodes = RENDER_LIMITS.maxNodes } = {}) {
  if (!Array.isArray(jobs) || jobs.length === 0) return 0;
  if (!Number.isFinite(subBudgetMinutes) || subBudgetMinutes <= 0) throw new Error("render sub-budget must be positive");
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > RENDER_LIMITS.maxNodes) throw new Error("render maxNodes must be between one and ten");
  for (const job of jobs) {
    if (!Number.isFinite(job.serviceMinutes) || job.serviceMinutes <= 0 || job.serviceMinutes > subBudgetMinutes || !Number.isFinite(job.deadlineMinutes) || job.deadlineMinutes <= 0 || job.deadlineMinutes > subBudgetMinutes) {
      throw new Error("every render job must fit within the per-node sub-budget");
    }
  }
  for (let nodes = 1; nodes <= maxNodes; nodes += 1) {
    if (canPackJobs(jobs, nodes, subBudgetMinutes)) return nodes;
  }
  throw new Error(`render jobs do not fit within ${maxNodes} nodes and the ${subBudgetMinutes}-minute sub-budget`);
}

export function assertReplacementWithinCap({ activeNodes, replacementNodes, maxNodes }) {
  assertInteger("activeNodes", activeNodes, 0, maxNodes);
  assertInteger("replacementNodes", replacementNodes, 0, maxNodes);
  if (activeNodes + replacementNodes > maxNodes) {
    throw new Error("replacement would overlap the pool cap; drain or fence the old node before creating its replacement");
  }
  return true;
}

function requireEnv(env, names) {
  const missing = names.filter((name) => !env[name] || env[name].trim() === "");
  if (missing.length > 0) throw new Error(`recorder gate is closed; missing ${missing.join(", ")}`);
}

// fallow-ignore-next-line complexity
export function assertOperationalReadiness(env = process.env) {
  requireEnv(env, ["RECORDER_STAGING_EVIDENCE_SHA256", "DO_CAPTURE_TOKEN", "DO_RENDER_TOKEN", "CLOUDFLARE_API_TOKEN", "RECORDER_CONTROL_PLANE_ROLE_ARN"]);
  if (!/^sha256:[0-9a-f]{64}$/.test(env.RECORDER_STAGING_EVIDENCE_SHA256)) {
    throw new Error("RECORDER_STAGING_EVIDENCE_SHA256 must be sha256:<64 lowercase hexadecimal characters>");
  }
  if (env.RECORDER_STAGING_EVIDENCE_VERIFIED !== "true") {
    throw new Error("recorder gate is closed until RECORDER_STAGING_EVIDENCE_VERIFIED=true");
  }
  if (!/^arn:aws:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]+$/.test(env.RECORDER_CONTROL_PLANE_ROLE_ARN)) {
    throw new Error("RECORDER_CONTROL_PLANE_ROLE_ARN must be a valid IAM role ARN");
  }
  if (env.RECORDER_ENVIRONMENT === "production") {
    requireEnv(env, ["RECORDER_BUCKET_NAME", "RECORDER_BUCKET_IMPORT_ID", "RECORDER_BUCKET_ADOPTION_PLAN_SHA256"]);
    if (!/^sha256:[0-9a-f]{64}$/.test(env.RECORDER_BUCKET_ADOPTION_PLAN_SHA256)) {
      throw new Error("RECORDER_BUCKET_ADOPTION_PLAN_SHA256 must be sha256:<64 lowercase hexadecimal characters>");
    }
  }
  return {
    stagingEvidenceDigest: env.RECORDER_STAGING_EVIDENCE_SHA256,
    captureTokenPresent: true,
    renderTokenPresent: true,
    cloudflareTokenPresent: true,
  };
}

// fallow-ignore-next-line complexity
async function readConfig(path) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  const capture = desiredCaptureNodes(parsed.capture);
  const render = minimumRenderNodes(parsed.render?.jobs ?? [], parsed.render?.limits);
  if (capture + (parsed.render?.desiredNodes ?? render) > RENDER_LIMITS.globalComputeNodes) {
    throw new Error("capture and render demand exceeds the twenty-one-node global recorder compute cap");
  }
  return { desiredCaptureNodes: capture, minimumRenderNodes: render };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const configPath = process.argv[2];
    if (configPath) {
      console.log(JSON.stringify(await readConfig(configPath)));
    } else {
      assertOperationalReadiness(process.env);
      console.log("recorder operational gate passed");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
