import { execFileSync } from "node:child_process";
import { repositoryRoot } from "../lib/repository.mjs";

export function readBaselineAt(ref, path) {
  if (!ref) throw new Error("GATE_BASE_REF is required for baseline monotonicity");
  let source;
  try {
    source = execFileSync("git", ["show", `${ref}:${path}`], { cwd: repositoryRoot, encoding: "utf8" });
  } catch {
    throw new Error(`Cannot read ${path} at ${ref}; baseline monotonicity fails closed`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${path} at ${ref} is not valid JSON; baseline monotonicity fails closed`);
  }
}

export function baselineIncreases(previous, candidate, label = "baseline") {
  const failures = [];
  const compare = (before, after, path) => {
    if (Array.isArray(after)) {
      if (!Array.isArray(before)) {
        failures.push(`${path} is new in ${label}; baselines may only fall.`);
        return;
      }
      if (after.length > before.length) failures.push(`${path} adds entries in ${label}; baselines may only fall.`);
      for (let index = 0; index < Math.min(before.length, after.length); index += 1) {
        compare(before[index], after[index], `${path}[${index}]`);
      }
      return;
    }
    if (after !== null && typeof after === "object") {
      if (before === null || typeof before !== "object" || Array.isArray(before)) {
        failures.push(`${path} is new in ${label}; baselines may only fall.`);
        return;
      }
      for (const [key, value] of Object.entries(after)) {
        if (!Object.hasOwn(before, key)) failures.push(`${path}.${key} is new in ${label}; baselines may only fall.`);
        else compare(before[key], value, `${path}.${key}`);
      }
      return;
    }
    if (typeof after === "number") {
      if (typeof before !== "number") failures.push(`${path} is new in ${label}; baselines may only fall.`);
      else if (after > before) failures.push(`${path} rose from ${before} to ${after} in ${label}; baselines may only fall.`);
      return;
    }
    if (after !== before) failures.push(`${path} changed in ${label}; baselines may only fall.`);
  };
  compare(previous, candidate, label);
  return failures;
}
