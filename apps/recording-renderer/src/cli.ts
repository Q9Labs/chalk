import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page, type Route } from "playwright";
import { loadVerifiedRenderInputs } from "./node/inputs.js";
import { parseFrameRenderRequestV1, type FrameRenderRequestV1 } from "./node/request.js";
import type { RecordingRendererFrameProfile } from "./runtime-api.js";
import { startRenderServer } from "./node/server.js";
import { resolveVerifiedClientBuild } from "./node/ui-build-registry.js";

const FRAME_RESULT_VERSION = "recording-frame-render-result.v1";
const MAXIMUM_REQUEST_BYTES = 64 << 10;
// page.clock replaces in-page timers, including requestAnimationFrame. Keep
// the stall deadline here so it measures wall time instead of synthetic ticks.
const FRAME_PREPARATION_DEADLINE_MS = 30_000;

interface Arguments {
  readonly requestPath: string;
  readonly resultPath: string;
  readonly profilePath?: string;
  readonly inspectionDirectory?: string;
  readonly concurrency: number;
}

interface FrameRenderResultV1 {
  readonly schema_version: typeof FRAME_RESULT_VERSION;
  readonly recording_id: string;
  readonly episode_id: string;
  readonly presentation_sha256: string;
  readonly ui_build_sha256: string;
  readonly decoded_media_sha256: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frame_count: number;
  readonly first_elapsed_ms: number;
  readonly last_elapsed_ms: number;
  readonly startup_wall_ms: number;
  readonly frame_preparation_wall_ms: number;
  readonly frame_capture_wall_ms: number;
  readonly output_wall_ms: number;
  readonly inspection_wall_ms: number;
  readonly wall_duration_ms: number;
}

interface FrameTiming {
  readonly frameCount: number;
  readonly lastElapsedMs: number;
  readonly preparationWallMs: number;
  readonly captureWallMs: number;
  readonly outputWallMs: number;
}

interface ProfileBatch {
  readonly startWallMs: number;
  readonly firstIndex: number;
  readonly frameCount: number;
  readonly preparationWallMs: number;
  readonly captureWallMs: number;
  readonly outputWallMs: number;
  readonly framePreparationWallMs: readonly number[];
  readonly frameCaptureWallMs: readonly number[];
  readonly frameOutputWallMs: readonly number[];
  readonly pngBytes: readonly number[];
  readonly rendererFrameProfiles: readonly (RecordingRendererFrameProfile | undefined)[];
}

type VerifiedRenderInputs = Awaited<ReturnType<typeof loadVerifiedRenderInputs>>;

interface BrowserPool {
  readonly browsers: Browser[];
  readonly contexts: BrowserContext[];
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const request = await readRequest(args.requestPath);
  await validateOutputPaths(args, request.workspaceDirectory);
  const inputs = await loadVerifiedRenderInputs(request);
  const clientDirectory = await resolveVerifiedClientBuild(fileURLToPath(new URL("../", import.meta.url)), request.uiBuildSha256);
  const server = await startRenderServer(inputs, clientDirectory);
  const pool: BrowserPool = { browsers: [], contexts: [] };
  const started = process.hrtime.bigint();
  let primaryError: unknown;
  try {
    await executeRender(args, request, inputs, server.origin, pool, started);
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = await closeRenderResources(pool, server.close);
  throwExecutionErrors(primaryError, cleanupErrors);
}

async function validateOutputPaths(args: Arguments, workspaceDirectory: string): Promise<void> {
  await validateResultPath(args.resultPath, workspaceDirectory);
  if (args.profilePath !== undefined) await validateResultPath(args.profilePath, workspaceDirectory);
  if (args.inspectionDirectory !== undefined) await validateInspectionDirectory(args.inspectionDirectory, workspaceDirectory);
}

async function executeRender(args: Arguments, request: FrameRenderRequestV1, inputs: VerifiedRenderInputs, origin: string, pool: BrowserPool, started: bigint): Promise<void> {
  const { profilePath } = args;
  const profileBatches: ProfileBatch[] | undefined = profilePath === undefined ? undefined : [];
  const pages = await initializeRenderPages(args.concurrency, pool, request, inputs, origin, profileBatches !== undefined);
  const startupWallMs = elapsedMilliseconds(started);
  const timing = await writeFrames(pages, request, args.inspectionDirectory, profileBatches, started);
  const inspectionStarted = process.hrtime.bigint();
  await writeReplayInspectionIfRequested(pages, request, args.inspectionDirectory);
  const inspectionWallMs = elapsedMilliseconds(inspectionStarted);
  await Promise.all(pages.map(({ cdp }) => cdp.detach()));
  const wallDurationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
  await writeResult(args.resultPath, request, timing, startupWallMs, inspectionWallMs, wallDurationMs);
  if (profilePath !== undefined && profileBatches !== undefined) {
    await writeFile(
      profilePath,
      `${JSON.stringify({ schemaVersion: "recording-render-profile.v1", concurrency: args.concurrency, frameCount: timing.frameCount, startupWallMs, wallDurationMs, resourceUsage: process.resourceUsage(), peakNodeRssBytes: process.memoryUsage.rss(), batches: profileBatches })}\n`,
      { flag: "wx", mode: 0o600 },
    );
  }
}

async function initializeRenderPages(concurrency: number, pool: BrowserPool, request: FrameRenderRequestV1, inputs: VerifiedRenderInputs, origin: string, profilingEnabled: boolean): Promise<RenderPage[]> {
  const initialized = await Promise.allSettled(Array.from({ length: concurrency }, () => openRenderPage(pool, request, inputs, origin, profilingEnabled)));
  const pages: RenderPage[] = [];
  const errors: unknown[] = [];
  for (const result of initialized) {
    if (result.status === "fulfilled") pages.push(result.value);
    else errors.push(result.reason);
  }
  if (errors.length > 0) throw new AggregateError(errors, "recording renderer browser initialization failed");
  return pages;
}

async function openRenderPage(pool: BrowserPool, request: FrameRenderRequestV1, inputs: VerifiedRenderInputs, origin: string, profilingEnabled: boolean): Promise<RenderPage> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-sync", "--metrics-recording-only", "--no-first-run"],
  });
  pool.browsers.push(browser);
  const context = await browser.newContext({
    viewport: { width: request.width, height: request.height },
    deviceScaleFactor: 1,
    colorScheme: inputs.timeline.initial.profile.theme.colorScheme,
    locale: inputs.timeline.initial.profile.locale,
    timezoneId: inputs.timeline.initial.profile.timeZone,
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  pool.contexts.push(context);
  await constrainNetwork(context, origin);
  return prepareRenderPage(context, origin, profilingEnabled);
}

async function writeReplayInspectionIfRequested(pages: readonly RenderPage[], request: FrameRenderRequestV1, directory: string | undefined): Promise<void> {
  if (directory === undefined) return;
  const firstPage = pages[0];
  if (firstPage === undefined) return;
  await writeReplayInspection(firstPage.page, firstPage.cdp, request, directory);
}

async function closeRenderResources(pool: BrowserPool, closeServer: () => Promise<void>): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const close of [...pool.contexts.map((context) => () => context.close()), ...pool.browsers.map((browser) => () => browser.close()), closeServer]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function throwExecutionErrors(primaryError: unknown, cleanupErrors: readonly unknown[]): void {
  if (primaryError === undefined) {
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "recording renderer execution or cleanup failed");
    return;
  }
  if (cleanupErrors.length === 0) throw primaryError;
  throw new AggregateError([primaryError, ...cleanupErrors], "recording renderer execution or cleanup failed");
}

interface RenderPage {
  readonly page: Page;
  readonly cdp: CDPSession;
}

interface PreparedFrame {
  readonly preparationWallMs: number;
  readonly rendererFrameProfile: RecordingRendererFrameProfile | undefined;
}

interface CapturedFrame {
  readonly image: Uint8Array;
  readonly captureWallMs: number;
}

interface WrittenFrames {
  readonly lastElapsedMs: number;
  readonly outputWallMs: readonly number[];
}

async function prepareRenderPage(context: BrowserContext, origin: string, profilingEnabled: boolean): Promise<RenderPage> {
  const page = await context.newPage();
  const pageFailure = new Promise<never>((_resolve, reject) => {
    page.once("pageerror", (error) => reject(new Error(`recording renderer page failed: ${error.message}`)));
  });
  await page.clock.install({ time: 0 });
  const url = profilingEnabled ? `${origin}/?recording_profile=1` : origin;
  await page.goto(url, { waitUntil: "load" });
  await Promise.race([page.waitForFunction(() => window.chalkRecordingRenderer?.ready === true), pageFailure]);
  return { page, cdp: await context.newCDPSession(page) };
}

async function writeFrames(pages: readonly RenderPage[], request: FrameRenderRequestV1, inspectionDirectory: string | undefined, profileBatches: ProfileBatch[] | undefined, renderStarted: bigint): Promise<FrameTiming> {
  const frameCount = Math.ceil((request.durationMs * request.fps) / 1_000);
  const profilingEnabled = profileBatches !== undefined;
  let lastElapsedMs = 0;
  let preparationNanoseconds = 0n;
  let captureNanoseconds = 0n;
  let outputNanoseconds = 0n;
  for (let firstIndex = 0; firstIndex < frameCount; firstIndex += pages.length) {
    const batchStartWallMs = profilingEnabled ? elapsedMilliseconds(renderStarted) : 0;
    const batch = pages.slice(0, Math.min(pages.length, frameCount - firstIndex));
    const preparationStarted = process.hrtime.bigint();
    const preparedFrames = await prepareFrames(batch, firstIndex, request.fps, profilingEnabled);
    const preparationElapsed = process.hrtime.bigint() - preparationStarted;
    preparationNanoseconds += preparationElapsed;
    const captureStarted = process.hrtime.bigint();
    const capturedFrames = await captureFrames(batch, profilingEnabled);
    const captureElapsed = process.hrtime.bigint() - captureStarted;
    captureNanoseconds += captureElapsed;
    const outputStarted = process.hrtime.bigint();
    const writtenFrames = await writeFrameOutput(
      capturedFrames.map((frame) => frame.image),
      firstIndex,
      request.fps,
      inspectionDirectory,
      profilingEnabled,
    );
    const outputElapsed = process.hrtime.bigint() - outputStarted;
    outputNanoseconds += outputElapsed;
    lastElapsedMs = writtenFrames.lastElapsedMs;
    if (profilingEnabled)
      profileBatches.push({
        startWallMs: batchStartWallMs,
        firstIndex,
        frameCount: batch.length,
        preparationWallMs: nanosecondsToMilliseconds(preparationElapsed),
        captureWallMs: nanosecondsToMilliseconds(captureElapsed),
        outputWallMs: nanosecondsToMilliseconds(outputElapsed),
        framePreparationWallMs: preparedFrames.map((frame) => frame.preparationWallMs),
        frameCaptureWallMs: capturedFrames.map((frame) => frame.captureWallMs),
        frameOutputWallMs: writtenFrames.outputWallMs,
        pngBytes: capturedFrames.map((frame) => frame.image.byteLength),
        rendererFrameProfiles: preparedFrames.map((frame) => frame.rendererFrameProfile),
      });
  }
  return {
    frameCount,
    lastElapsedMs,
    preparationWallMs: nanosecondsToMilliseconds(preparationNanoseconds),
    captureWallMs: nanosecondsToMilliseconds(captureNanoseconds),
    outputWallMs: nanosecondsToMilliseconds(outputNanoseconds),
  };
}

async function prepareFrames(pages: readonly RenderPage[], firstIndex: number, fps: number, profilingEnabled: boolean): Promise<readonly PreparedFrame[]> {
  const lastIndex = firstIndex + pages.length - 1;
  return await withFramePreparationDeadline(Promise.all(pages.map(({ page }, offset) => prepareFrame(page, firstIndex + offset, fps, profilingEnabled))), firstIndex, lastIndex);
}

async function prepareFrame(page: Page, index: number, fps: number, profilingEnabled: boolean): Promise<PreparedFrame> {
  const elapsedMs = Math.floor((index * 1_000) / fps);
  const frameStarted = process.hrtime.bigint();
  const rendererFrameProfile = await page.evaluate(
    async ({ frameMs, frameToken, profile }) => {
      await window.chalkRecordingRenderer.renderFrame(frameMs, frameToken);
      return profile ? window.chalkRecordingRenderer.readLastFrameProfile() : undefined;
    },
    { frameMs: elapsedMs, frameToken: `${index}:${elapsedMs}`, profile: profilingEnabled },
  );
  return { preparationWallMs: profilingEnabled ? elapsedMilliseconds(frameStarted) : 0, rendererFrameProfile };
}

async function captureFrames(pages: readonly RenderPage[], profilingEnabled: boolean): Promise<readonly CapturedFrame[]> {
  return await Promise.all(
    pages.map(async ({ cdp }) => {
      const frameStarted = process.hrtime.bigint();
      const image = await captureFrame(cdp);
      return { image, captureWallMs: profilingEnabled ? elapsedMilliseconds(frameStarted) : 0 };
    }),
  );
}

async function writeFrameOutput(frames: readonly Uint8Array[], firstIndex: number, fps: number, inspectionDirectory: string | undefined, profilingEnabled: boolean): Promise<WrittenFrames> {
  const outputWallMs: number[] = [];
  let lastElapsedMs = 0;
  for (const [offset, frame] of frames.entries()) {
    const index = firstIndex + offset;
    const elapsedMs = Math.floor((index * 1_000) / fps);
    const frameStarted = process.hrtime.bigint();
    await writeStandardOutput(frame);
    if (inspectionDirectory !== undefined) await writeFile(join(inspectionDirectory, `frame-${String(index).padStart(6, "0")}-${String(elapsedMs).padStart(10, "0")}.png`), frame, { flag: "wx", mode: 0o600 });
    if (profilingEnabled) outputWallMs[offset] = elapsedMilliseconds(frameStarted);
    lastElapsedMs = elapsedMs;
  }
  return { lastElapsedMs, outputWallMs };
}

async function withFramePreparationDeadline<T>(operation: Promise<T>, firstIndex: number, lastIndex: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`recording renderer timed out preparing frame batch ${firstIndex}-${lastIndex}`)), FRAME_PREPARATION_DEADLINE_MS);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function writeReplayInspection(page: Page, cdp: CDPSession, request: FrameRenderRequestV1, directory: string): Promise<void> {
  const elapsedMs = Math.min(2_000, request.durationMs - 1);
  await renderInspectionFrame(page, cdp, elapsedMs, "replay-a", join(directory, `replay-${elapsedMs}-a.png`));
  await renderInspectionFrame(page, cdp, elapsedMs, "replay-b", join(directory, `replay-${elapsedMs}-b.png`));
  await page.evaluate(async () => {
    await window.chalkRecordingRenderer.renderFrame(0, "seek-away");
  });
  await renderInspectionFrame(page, cdp, elapsedMs, "replay-after-seek", join(directory, `replay-${elapsedMs}-after-seek.png`));
  await writeFile(join(directory, "inspection.json"), `${JSON.stringify({ schema_version: "recording-render-inspection.v1", elapsed_ms: elapsedMs, width: request.width, height: request.height })}\n`, { flag: "wx", mode: 0o600 });
}

async function renderInspectionFrame(page: Page, cdp: CDPSession, elapsedMs: number, token: string, path: string): Promise<void> {
  await page.evaluate(
    async ({ frameMs, frameToken }) => {
      await window.chalkRecordingRenderer.renderFrame(frameMs, frameToken);
    },
    { frameMs: elapsedMs, frameToken: token },
  );
  await writeFile(path, await captureFrame(cdp), { flag: "wx", mode: 0o600 });
}

async function captureFrame(cdp: CDPSession): Promise<Uint8Array> {
  const response = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true });
  return Buffer.from(response.data, "base64");
}

async function constrainNetwork(context: BrowserContext, origin: string): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || url.protocol === "data:" || url.protocol === "blob:") await route.continue();
    else await route.abort("blockedbyclient");
  });
}

async function readRequest(path: string): Promise<FrameRenderRequestV1> {
  const facts = await stat(path);
  if (!facts.isFile() || facts.size < 1 || facts.size > MAXIMUM_REQUEST_BYTES) throw new TypeError("frame render request exceeds its byte bound");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  return parseFrameRenderRequestV1(value);
}

async function validateResultPath(path: string, workspace: string): Promise<void> {
  if (!isAbsolute(path)) throw new TypeError("frame render result path must be absolute");
  const [workspaceRoot, resultParent] = await Promise.all([realpath(workspace), realpath(dirname(path))]);
  const pathFromWorkspace = relative(workspaceRoot, resultParent);
  if (pathFromWorkspace === ".." || pathFromWorkspace.startsWith(`..${sep}`)) throw new TypeError("frame render result path escapes the attempt workspace");
}

async function validateInspectionDirectory(path: string, workspace: string): Promise<void> {
  if (!isAbsolute(path)) throw new TypeError("recording inspection directory must be absolute");
  const workspaceRoot = await realpath(workspace);
  const parent = await realpath(dirname(path));
  const pathFromWorkspace = relative(workspaceRoot, parent);
  if (pathFromWorkspace === ".." || pathFromWorkspace.startsWith(`..${sep}`)) throw new TypeError("recording inspection directory escapes the attempt workspace");
  await mkdir(path, { mode: 0o700 });
}

async function writeResult(path: string, request: FrameRenderRequestV1, timing: FrameTiming, startupWallMs: number, inspectionWallMs: number, wallDurationMs: number): Promise<void> {
  const result: FrameRenderResultV1 = {
    schema_version: FRAME_RESULT_VERSION,
    recording_id: request.recordingId,
    episode_id: request.episodeId,
    presentation_sha256: request.presentationSha256,
    ui_build_sha256: request.uiBuildSha256,
    decoded_media_sha256: request.decodedMediaSha256,
    width: request.width,
    height: request.height,
    fps: request.fps,
    frame_count: timing.frameCount,
    first_elapsed_ms: 0,
    last_elapsed_ms: timing.lastElapsedMs,
    startup_wall_ms: startupWallMs,
    frame_preparation_wall_ms: timing.preparationWallMs,
    frame_capture_wall_ms: timing.captureWallMs,
    output_wall_ms: timing.outputWallMs,
    inspection_wall_ms: inspectionWallMs,
    wall_duration_ms: wallDurationMs,
  };
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(result)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function elapsedMilliseconds(started: bigint): number {
  return nanosecondsToMilliseconds(process.hrtime.bigint() - started);
}

function nanosecondsToMilliseconds(value: bigint): number {
  return Number(value / 1_000_000n);
}

async function writeStandardOutput(bytes: Uint8Array): Promise<void> {
  if (process.stdout.write(bytes)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      process.stdout.off("drain", drained);
      process.stdout.off("error", failed);
    };
    const drained = (): void => {
      cleanup();
      resolve();
    };
    const failed = (error: Error): void => {
      cleanup();
      reject(error);
    };
    process.stdout.once("drain", drained);
    process.stdout.once("error", failed);
  });
}

function parseArguments(values: readonly string[]): Arguments {
  const { requestPath, resultPath } = parseRequiredArguments(values);
  return { requestPath, resultPath, ...parseOptionalArguments(values.slice(4)) };
}

function parseRequiredArguments(values: readonly string[]): Pick<Arguments, "requestPath" | "resultPath"> {
  if (!hasRequiredArgumentCount(values.length)) throwRendererUsage();
  const requestPath = readRequiredRendererOption(values, 0, "--request");
  const resultPath = readRequiredRendererOption(values, 2, "--result");
  if (!isAbsolute(requestPath) || !isAbsolute(resultPath)) throw new TypeError("recording renderer argument paths must be absolute");
  return { requestPath, resultPath };
}

function hasRequiredArgumentCount(count: number): boolean {
  return count >= 4 && count % 2 === 0;
}

function readRequiredRendererOption(values: readonly string[], index: number, expectedName: string): string {
  if (values[index] !== expectedName) throwRendererUsage();
  const value = values[index + 1];
  if (value === undefined) throwRendererUsage();
  return value;
}

function parseOptionalArguments(values: readonly string[]): Pick<Arguments, "profilePath" | "inspectionDirectory" | "concurrency"> {
  let options: Pick<Arguments, "profilePath" | "inspectionDirectory" | "concurrency"> = { concurrency: 1 };
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 2) {
    const option = readRendererOption(values, index, seen);
    options = applyRendererOption(options, option.name, option.value);
  }
  return options;
}

function readRendererOption(values: readonly string[], index: number, seen: Set<string>): { readonly name: string; readonly value: string } {
  const name = values[index];
  const value = values[index + 1];
  if (name === undefined) throw new TypeError("recording renderer option is missing or duplicated");
  if (value === undefined) throw new TypeError("recording renderer option is missing or duplicated");
  if (seen.has(name)) throw new TypeError("recording renderer option is missing or duplicated");
  seen.add(name);
  return { name, value };
}

function applyRendererOption(options: Pick<Arguments, "profilePath" | "inspectionDirectory" | "concurrency">, name: string, value: string): Pick<Arguments, "profilePath" | "inspectionDirectory" | "concurrency"> {
  if (name === "--profile-output") return { ...options, profilePath: parseProfilePath(value) };
  if (name === "--inspection-dir") return { ...options, inspectionDirectory: parseInspectionDirectory(value) };
  if (name === "--concurrency") return { ...options, concurrency: parseConcurrency(value) };
  throw new TypeError("recording renderer option is unsupported or invalid");
}

function parseProfilePath(value: string): string {
  if (!isAbsolute(value)) throw new TypeError("recording renderer option is unsupported or invalid");
  return value;
}

function parseInspectionDirectory(value: string): string {
  if (!isAbsolute(value)) throw new TypeError("recording renderer option is unsupported or invalid");
  return value;
}

function parseConcurrency(value: string): number {
  if (!/^[1-8]$/.test(value)) throw new TypeError("recording renderer option is unsupported or invalid");
  return Number(value);
}

function throwRendererUsage(): never {
  throw new TypeError("usage: recording-renderer --request <absolute-path> --result <absolute-path> [--profile-output <absolute-path>] [--inspection-dir <absolute-path>] [--concurrency <1-8>]");
}

main().catch((error: unknown) => {
  const message = describeError(error);
  process.stderr.write(`recording-renderer: ${message}\n`);
  process.exitCode = 1;
});

function describeError(error: unknown): string {
  if (error instanceof AggregateError) return `${error.message}: ${error.errors.map(describeError).join("; ")}`;
  return error instanceof Error ? error.message : String(error);
}
