// @ts-check

import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DiagnosticInspectError } from "./errors.mjs";

/**
 * @typedef {{ bytes: Uint8Array; size: number; sha256: string; contentType: string; url: string }} FeedbackDownload
 */

/** @typedef {import("./feedback-parsers.mjs").FeedbackReport} FeedbackReport */
/** @typedef {{ path: string; size: number; sha256: string; content_type: string }} FeedbackPullFile */
/** @typedef {{ report: FeedbackReport; evidence: FeedbackDownload; screenshot?: FeedbackDownload; output?: string; cwd?: string; now?: Date }} FeedbackPullOptions */
/** @typedef {{ output: string; files: string[]; manifest: string }} FeedbackPullResult */

/**
 * Write one report's evidence and optional screenshot into a new directory.
 * The normal (new target) path is assembled beside the destination and renamed
 * into place, so an interrupted pull cannot expose a partial report.
 *
 * @param {FeedbackPullOptions} options
 * @returns {Promise<FeedbackPullResult>}
 */
export async function writeFeedbackPull(options) {
  const reportId = options.report.id;
  const target = resolve(options.cwd ?? process.cwd(), options.output ?? defaultOutputName(reportId, options.now ?? new Date()));
  await assertOutputTarget(target);
  const targetState = await outputState(target);
  const staging = await prepareStaging(target);
  return commitPull(staging, target, targetState, options);
}

/** @param {string} target */
async function prepareStaging(target) {
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  return mkdirStaging(parent, basename(target));
}

/** @param {string} staging @param {string} target @param {"absent" | "existing-empty"} targetState @param {FeedbackPullOptions} options */
async function commitPull(staging, target, targetState, options) {
  let committed = false;
  try {
    const files = await writePullFiles(staging, options);
    await commitStaging(staging, target, targetState);
    committed = true;
    return pullResult(target, files);
  } finally {
    if (!committed) await rm(staging, { recursive: true, force: true });
  }
}

/** @param {string} staging @param {string} target @param {"absent" | "existing-empty"} targetState */
async function commitStaging(staging, target, targetState) {
  if (targetState === "absent") return rename(staging, target);
  return replaceExistingEmptyDirectory(staging, target);
}

/** @param {string} target @param {FeedbackPullFile[]} files @returns {Promise<FeedbackPullResult>} */
async function pullResult(target, files) {
  return { output: target, files: files.map((file) => file.path), manifest: await readFile(join(target, "manifest.json"), "utf8") };
}

/** @param {string} reportId @param {Date} now */
function defaultOutputName(reportId, now) {
  const stamp = now
    .toISOString()
    .replace(/[-:.TZ]/gu, "")
    .slice(0, 14);
  return `feedback-${reportId}-${stamp}-${randomUUID().slice(0, 8)}`;
}

/** @param {string} target */
async function assertOutputTarget(target) {
  try {
    await validateExistingOutput(target);
  } catch (error) {
    handleOutputInspectionError(error);
  }
}

/** @param {unknown} error */
function handleOutputInspectionError(error) {
  if (error instanceof DiagnosticInspectError) throw error;
  if (error?.code !== "ENOENT") throw new DiagnosticInspectError("unsafe_output", "Feedback output path could not be inspected", { cause: error });
}

/** @param {string} target */
async function validateExistingOutput(target) {
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new DiagnosticInspectError("unsafe_output", "Feedback output must be a directory path");
  const entries = await readdir(target);
  if (entries.length > 0) throw new DiagnosticInspectError("unsafe_output", "Feedback output directory is not empty");
}

/** @param {string} target */
async function outputState(target) {
  try {
    return await existingOutputState(target);
  } catch (error) {
    return outputInspectionState(error);
  }
}

/** @param {unknown} error @returns {"absent"} */
function outputInspectionState(error) {
  if (error instanceof DiagnosticInspectError) throw error;
  if (error?.code === "ENOENT") return "absent";
  throw new DiagnosticInspectError("unsafe_output", "Feedback output path could not be inspected", { cause: error });
}

/** @param {string} target @returns {Promise<"existing-empty">} */
async function existingOutputState(target) {
  const metadata = await lstat(target);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new DiagnosticInspectError("unsafe_output", "Feedback output must be a directory path");
  return "existing-empty";
}

/** @param {string} parent @param {string} targetName */
async function mkdirStaging(parent, targetName) {
  const firstPath = join(parent, `.${targetName}.staging-${randomUUID()}`);
  try {
    await mkdir(firstPath, { recursive: false, mode: 0o700 });
    return firstPath;
  } catch {
    try {
      const path = join(parent, `.${targetName}.staging-${randomUUID()}`);
      await mkdir(path, { recursive: false, mode: 0o700 });
      return path;
    } catch (error) {
      throw new DiagnosticInspectError("unsafe_output", "Feedback output staging directory could not be created", { cause: error });
    }
  }
}

/** @param {string} staging @param {FeedbackPullOptions} options @returns {Promise<FeedbackPullFile[]>} */
async function writePullFiles(staging, options) {
  const files = [];
  files.push(await writeFileEntry(staging, "evidence.json", options.evidence.bytes, options.evidence.sha256, "application/json"));
  if (options.screenshot) files.push(await writeFileEntry(staging, screenshotName(options.screenshot), options.screenshot.bytes, options.screenshot.sha256, options.screenshot.contentType));
  const manifest = { schema_version: "FeedbackPullManifest/v1", report_id: options.report.id, files };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(staging, "manifest.json"), manifestBytes, { mode: 0o600, flag: "wx" });
  await tightenFiles(staging, [...files.map((file) => file.path), "manifest.json"]);
  return [...files, { path: "manifest.json", size: manifestBytes.byteLength, sha256: digest(manifestBytes), content_type: "application/json" }];
}

/** @param {string} staging @param {string} path @param {Uint8Array} bytes @param {string} sha256 @param {string} contentType */
async function writeFileEntry(staging, path, bytes, sha256, contentType) {
  const target = join(staging, path);
  if (dirname(path) !== "." || basename(path) !== path) throw new DiagnosticInspectError("unsafe_output", "Feedback output filename is invalid");
  await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
  return { path, size: bytes.byteLength, sha256, content_type: contentType };
}

/** @param {FeedbackDownload} download */
function screenshotName(download) {
  const type = download.contentType.toLowerCase().split(";", 1)[0];
  const extension = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" }[type];
  if (!extension) throw new DiagnosticInspectError("invalid_contract", "Feedback screenshot content type is unsupported");
  return `screenshot${extension}`;
}

/** @param {string} staging @param {string[]} paths */
async function tightenFiles(staging, paths) {
  if (process.platform === "win32") return;
  for (const path of paths) {
    try {
      await chmod(join(staging, path), 0o600);
    } catch (error) {
      throw new DiagnosticInspectError("unsafe_output", "Feedback pull file permissions could not be tightened", { cause: error });
    }
  }
}

/** @param {string} staging @param {string} target */
async function replaceExistingEmptyDirectory(staging, target) {
  try {
    await rmdir(target);
    await rename(staging, target);
  } catch (error) {
    throw new DiagnosticInspectError("unsafe_output", "Feedback output directory could not be committed", { cause: error });
  }
}

/** @param {Uint8Array} bytes */
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export const feedbackPullManifestSchema = "FeedbackPullManifest/v1";
