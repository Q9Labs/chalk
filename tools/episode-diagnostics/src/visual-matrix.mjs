// @ts-check

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FIXTURE_CLOCK, FIXTURE_ENVIRONMENT, fixtureReference, VISUAL_VIEWPORTS } from "./fixture-server.mjs";

// These are the states the real route can deterministically exercise from the
// loopback API fixture. Loading, empty, export-progress/failure, and
// permission-denied remain API/component fixtures; they are not silently
// represented as browser coverage until the route drives each one end to end.
export const VISUAL_STATES = Object.freeze(["live", "reconnecting", "stalled", "ended", "error", "failed", "export", "disconnected"]);
export const REQUIRED_VIEWS = Object.freeze(["Run", "Graph", "Trace", "Flame", "Issues", "Participants", "Epilogue"]);
export const REQUIRED_ACTIONS = Object.freeze(["copy-agent", "copy-all", "download-json", "reconnect", "gap"]);
export const RECOVERY_STATES = Object.freeze(["failed", "error"]);
export const GAP_STATES = Object.freeze(["reconnecting", "disconnected"]);
export const VISUAL_MATRIX = Object.freeze(VISUAL_STATES.flatMap((state) => VISUAL_VIEWPORTS.map((width) => ({ state, width, height: 900 }))));
const FIXED_EPOCH = Date.parse(FIXTURE_CLOCK);
const VIEWPORT_HEIGHT = 900;
const DEBUGGER_ROOT_SELECTOR = 'main.episode-debugger[data-chalk], [data-testid="episode-diagnostics-debugger"],[data-episode-debugger],[data-chalk-episode-debugger]';
const ACTION_SELECTORS = Object.freeze({
  "copy-agent": '[data-episode-action="copy-agent"]',
  "copy-all": '[data-episode-action="copy-all"]',
  "download-json": '[data-episode-action="download-json"]',
  reconnect: '[data-episode-action="retry-stream"]',
});
const ACTION_LABELS = Object.freeze({
  "copy-agent": ["copy for agent", "copy-agent", "copyagent"],
  "copy-all": ["copy all", "copy-all", "copyall"],
  "download-json": ["download json", "download-json", "export json"],
  reconnect: ["retry stream", "reconnect", "stream reconnect"],
});
const ACTION_CONTROL_NAMES = new Set(Object.keys(ACTION_LABELS));
const EMPTY_ACCESSIBILITY = Object.freeze({ rootNamed: false, lang: "", unlabeledControls: -1 });

/**
 * Run the real Episode Debugger visual matrix. `debuggerUrl` must point at the
 * caller's actual debugger route. The deterministic API fixture is deliberately
 * not used here: a static fixture page cannot prove the product UI exists.
 *
 * @param {{ debuggerUrl: string; environment?: "localhost"|"development"|"staging"; browser?: any; pageFactory?: (entry: { state: string; width: number; height: number }) => Promise<any>; outputDir?: string; states?: readonly string[]; viewports?: readonly number[]; screenshot?: boolean; timeoutMs?: number }} options
 */
export async function runVisualMatrix(options) {
  const config = normalizeVisualMatrixOptions(options);
  await ensureScreenshotDirectory(config);
  const results = await collectVisualResults(config);
  assertRecoveryEvidence(results);
  return { debuggerUrl: config.debuggerUrl, clock: FIXTURE_CLOCK, states: [...config.states], viewports: [...config.viewports], results };
}

/** @param {any} config */
async function ensureScreenshotDirectory(config) {
  if (!config.outputDir) return;
  if (!config.captureScreenshots) return;
  await mkdir(config.outputDir, { recursive: true });
}

/** @param {any} config */
async function collectVisualResults(config) {
  const results = [];
  for (const state of config.states) results.push(...(await collectStateResults(config, state)));
  return results;
}

/** @param {any} config @param {string} state */
async function collectStateResults(config, state) {
  validateVisualState(state);
  const results = [];
  for (const width of config.viewports) {
    validateVisualViewport(width);
    const entry = { state, width, height: VIEWPORT_HEIGHT };
    results.push(await captureVisualEntry(config, entry));
  }
  return results;
}

/** @param {any} options */
function normalizeVisualMatrixOptions(options) {
  const environment = defaultOption(options.environment, FIXTURE_ENVIRONMENT);
  const debuggerUrl = requireDebuggerURL(options.debuggerUrl, environment);
  assertStateTemplate(debuggerUrl);
  return {
    ...options,
    environment,
    debuggerUrl,
    states: defaultOption(options.states, VISUAL_STATES),
    viewports: defaultOption(options.viewports, VISUAL_VIEWPORTS),
    outputDir: options.outputDir,
    timeoutMs: defaultOption(options.timeoutMs, 10_000),
    captureScreenshots: options.screenshot !== false,
  };
}

/** @param {any} value @param {any} fallback */
function defaultOption(value, fallback) {
  return value ?? fallback;
}

/** @param {string} template */
function assertStateTemplate(template) {
  if (template.includes("{reference}") || template.includes("{state}")) return;
  throw new Error("Debugger URL template must contain {reference} or {state} for named fixture states");
}

/** @param {string} state */
function validateVisualState(state) {
  if (!VISUAL_STATES.includes(state)) throw new Error(`Unknown visual state ${state}`);
}

/** @param {number} width */
function validateVisualViewport(width) {
  if (!VISUAL_VIEWPORTS.includes(width)) throw new Error(`Unsupported visual viewport ${width}`);
}

/** @param {any} config @param {{ state: string; width: number; height: number }} entry */
async function captureVisualEntry(config, entry) {
  let resources;
  try {
    resources = await openVisualResources(config, entry);
    return await collectVisualProof(config, resources.page, entry);
  } catch (error) {
    throw await createVisualFailure(error, entry, resources?.page);
  } finally {
    await closeVisualResources(resources);
  }
}

/** @param {any} config @param {{ state: string; width: number; height: number }} entry */
async function openVisualResources(config, entry) {
  if (config.pageFactory) return { page: await config.pageFactory(entry) };
  if (!config.browser || typeof config.browser.newContext !== "function") throw new Error("Visual matrix requires a browser or pageFactory");
  const context = await config.browser.newContext({ viewport: { width: entry.width, height: entry.height }, locale: "en-US", timezoneId: "UTC" });
  await installFixedClock(context);
  return { context, page: await context.newPage() };
}

/** @param {any} context */
async function installFixedClock(context) {
  if (typeof context.addInitScript !== "function") return;
  await context.addInitScript({
    content: `Date.now = () => ${FIXED_EPOCH}; Date.prototype.getTime = () => ${FIXED_EPOCH}; document.documentElement.dataset.episodeDiagnosticsFixedClock = ${JSON.stringify(FIXTURE_CLOCK)};`,
  });
}

/** @param {any} config @param {any} page @param {{ state: string; width: number; height: number }} entry */
async function collectVisualProof(config, page, entry) {
  if (typeof page.setViewportSize === "function") await page.setViewportSize({ width: entry.width, height: entry.height });
  const url = resolveDebuggerURL(config.debuggerUrl, entry.state, config.environment);
  if (typeof page.goto !== "function") throw new Error("Debugger proof page cannot navigate to the supplied URL");
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: config.timeoutMs });
  await waitForDebuggerReady(page, entry.state, config.timeoutMs);
  const contract = await inspectDebuggerContract(page);
  assertDebuggerContract(contract, entry);
  const viewProof = await exerciseViews(page, contract, config.timeoutMs, {
    capture: shouldCaptureViewScreenshots(config, entry.state),
    outputDir: config.outputDir,
    state: entry.state,
    width: entry.width,
  });
  const actionProof = await exerciseActions(page, contract, entry.state, config.timeoutMs);
  const readiness = await readReadiness(page);
  assertReadiness(readiness, entry);
  const screenshotPath = finalScreenshotPath(config, entry);
  await captureScreenshot(page, screenshotPath);
  return { ...entry, readiness, contract, views: viewProof, actions: actionProof, screenshotPath };
}

/** @param {any} config @param {string} state */
function shouldCaptureViewScreenshots(config, state) {
  return config.outputDir && config.captureScreenshots && config.states[0] === state;
}

/** @param {any} config @param {{ state: string; width: number }} entry */
function finalScreenshotPath(config, entry) {
  if (!config.outputDir || !config.captureScreenshots) return undefined;
  return join(config.outputDir, `episode-diagnostic-${entry.state}-${entry.width}.png`);
}

/** @param {any} page @param {string|undefined} screenshotPath */
async function captureScreenshot(page, screenshotPath) {
  if (!screenshotPath) return;
  if (typeof page.screenshot !== "function") return;
  await page.screenshot({ path: screenshotPath, fullPage: true });
}

/** @param {any} error @param {{ state: string; width: number }} entry @param {any} page */
async function createVisualFailure(error, entry, page) {
  const message = error instanceof Error ? error.message : String(error);
  const pageState = await readPageState(page);
  const suffix = pageState ? `; page state: ${pageState}` : "";
  return new Error(`Debugger proof failed for ${entry.state} at ${entry.width}px: ${message}${suffix}`, { cause: error });
}

/** @param {any} page */
async function readPageState(page) {
  if (!page) return "";
  if (typeof page.evaluate !== "function") return "";
  try {
    return await page.evaluate((rootSelector) => {
      const root = document.querySelector(rootSelector);
      const details = root ? { streamState: root.getAttribute("data-episode-stream-state") || "", hasGap: Boolean(root.querySelector("[data-episode-gap]")), text: root.textContent } : { streamState: "", hasGap: false, text: document.body ? document.body.textContent : "" };
      return JSON.stringify({
        url: location.href,
        root: Boolean(root),
        streamState: details.streamState,
        hasGap: details.hasGap,
        text: String(details.text).replace(/\s+/gu, " ").trim().slice(0, 600),
      });
    }, DEBUGGER_ROOT_SELECTOR);
  } catch {
    return "page state unavailable";
  }
}

/** @param {any} resources */
async function closeVisualResources(resources) {
  if (!resources) return;
  if (await closeVisualResource(resources.context)) return;
  await closeVisualResource(resources.page);
}

/** @param {any} resource */
async function closeVisualResource(resource) {
  if (!resource) return false;
  if (typeof resource.close !== "function") return false;
  await resource.close();
  return true;
}

/** @param {any[]} results */
function assertRecoveryEvidence(results) {
  if (!results.some((result) => result.actions?.exercised?.includes("gap"))) throw new Error("Debugger visual proof did not observe a visibility-gap marker");
  if (!results.some((result) => result.actions?.exercised?.includes("reconnect"))) throw new Error("Debugger visual proof did not exercise stream recovery");
}

/**
 * Validate and constrain the target before a browser opens it. Hosted proof
 * callers must opt into their environment; localhost proof never follows a
 * network hostname or a public IP by accident.
 *
 * @param {unknown} value
 * @param {string} environment
 */
export function requireDebuggerURL(value, environment = "localhost") {
  const template = replaceURLPlaceholders(requireURLValue(value));
  const url = parseDebuggerURL(template);
  assertHTTPProtocol(url);
  assertLoopbackURL(url, environment);
  return restoreURLPlaceholders(url.toString());
}

/** @param {unknown} value */
function requireURLValue(value) {
  if (typeof value !== "string") throw new Error("Debugger proof requires a caller-supplied debuggerUrl");
  if (value.length === 0) throw new Error("Debugger proof requires a caller-supplied debuggerUrl");
  return value;
}

/** @param {string} value */
function replaceURLPlaceholders(value) {
  return value.replaceAll("{reference}", "CHALKDIAGREFERENCE").replaceAll("{state}", "CHALKDIAGSTATE");
}

/** @param {string} value */
function parseDebuggerURL(value) {
  try {
    return new URL(value);
  } catch {
    throw new Error("Debugger proof URL is invalid");
  }
}

/** @param {URL} url */
function assertHTTPProtocol(url) {
  if (url.protocol === "http:" || url.protocol === "https:") return;
  throw new Error("Debugger proof URL must use HTTP or HTTPS");
}

/** @param {URL} url @param {string} environment */
function assertLoopbackURL(url, environment) {
  if (environment !== "localhost") return;
  if (isLoopbackHostname(url.hostname)) return;
  throw new Error("Localhost debugger proof accepts loopback URLs only");
}

/** @param {string} value */
function restoreURLPlaceholders(value) {
  return value.replaceAll("CHALKDIAGREFERENCE", "{reference}").replaceAll("CHALKDIAGSTATE", "{state}");
}

/**
 * Resolve one named visual state to the canonical fixture Diagnostic
 * Reference. A template must expose `{reference}` or `{state}` when more than
 * one fixture state is being captured; silently appending a query to one fixed
 * reference would make every screenshot the same Episode state.
 *
 * @param {string} template
 * @param {string} state
 * @param {"localhost"|"development"|"staging"} [environment]
 */
export function resolveDebuggerURL(template, state, environment = FIXTURE_ENVIRONMENT) {
  const normalized = requireDebuggerURL(template, environment);
  const reference = fixtureReference(state, environment);
  assertStateTemplate(normalized);
  const resolved = normalized.replaceAll("{reference}", encodeURIComponent(reference)).replaceAll("{state}", encodeURIComponent(state));
  assertNoURLPlaceholders(resolved);
  return resolved;
}

/** @param {string} value */
function assertNoURLPlaceholders(value) {
  if (!value.includes("{") && !value.includes("}")) return;
  throw new Error("Debugger URL template contains an unsupported placeholder");
}

/**
 * @param {any} page
 * @param {string} fixtureState
 * @param {number} timeoutMs
 */
async function waitForDebuggerReady(page, fixtureState, timeoutMs) {
  if (typeof page.waitForFunction === "function") {
    await page.waitForFunction(
      ({ requiredState, rootSelector, gapStates }) => {
        const root = document.querySelector(rootSelector);
        const rootNode = root ?? document.createElement("div");
        const streamState = rootNode.getAttribute("data-episode-stream-state");
        const hasGap = Boolean(rootNode.querySelector("[data-episode-gap]"));
        const fonts = document.fonts;
        return [Boolean(root), ![null, "", "loading", "connecting"].includes(streamState), !gapStates.includes(requiredState) || hasGap, fonts === undefined || fonts.status === "loaded"].every(Boolean);
      },
      { requiredState: fixtureState, rootSelector: DEBUGGER_ROOT_SELECTOR, gapStates: [...GAP_STATES] },
      { timeout: timeoutMs },
    );
  }
}

/**
 * Read only the explicit debugger proof contract. The broad selectors are
 * aliases for the same product-owned data attributes, not a generic page
 * scrape: a page without the root cannot pass this proof.
 *
 * @param {any} page
 */
async function inspectDebuggerContract(page) {
  if (typeof page.evaluate !== "function") throw new Error("Debugger proof page cannot inspect the debugger contract");
  return page.evaluate((rootSelector) => {
    const root = document.querySelector(rootSelector);
    const rootNode = root ?? document.createElement("div");
    const attributeValue = (element, name) => element.getAttribute(name) || "";
    const text = (element) => String(element.textContent).replace(/\s+/gu, " ").trim();
    const controlLabel = (control) => [attributeValue(control, "aria-label"), attributeValue(control, "title"), attributeValue(control, "data-testid"), control.textContent].filter(Boolean).join(" ").toLowerCase();
    const controlAccessibilityLabel = (control) => [attributeValue(control, "aria-label"), attributeValue(control, "title"), control.textContent].filter(Boolean).join(" ").trim();
    const controls = [...rootNode.querySelectorAll("button,a,[role=button],[role=tab]")];
    const controlLabels = controls.map(controlLabel).join("\u0000");
    const viewLabels = new Set(controls.map((control) => text(control).toLowerCase()));
    const find = (needles) => needles.some((needle) => controlLabels.includes(needle));
    const views = Object.fromEntries(
      [
        ["Run", "run"],
        ["Graph", "graph"],
        ["Trace", "trace"],
        ["Flame", "flame"],
        ["Issues", "issues"],
        ["Participants", "participants"],
        ["Epilogue", "epilogue"],
      ].map(([name, viewName]) => [name, Boolean(rootNode.querySelector(`[data-episode-view="${viewName}"]`)) || viewLabels.has(name.toLowerCase())]),
    );
    const actionDefinitions = [
      ["copy-agent", '[data-episode-action="copy-agent"]', ["copy for agent", "copy-agent", "copyagent"]],
      ["copy-all", '[data-episode-action="copy-all"]', ["copy all", "copy-all", "copyall"]],
      ["download-json", '[data-episode-action="download-json"]', ["download json", "download-json", "export json"]],
      ["reconnect", '[data-episode-action="retry-stream"]', ["retry stream", "reconnect", "stream reconnect"]],
    ];
    const actions = Object.fromEntries(actionDefinitions.map(([name, selector, needles]) => [name, Boolean(rootNode.querySelector(selector)) || find(needles)]));
    actions.gap = Boolean(rootNode.querySelector('[data-episode-gap],[data-diagnostic-gap],[data-testid*="gap" i],[data-state="gap"],[data-state="partial"],.episode-stream-banner[data-episode-gap]'));
    const rootName = [attributeValue(rootNode, "aria-label"), attributeValue(rootNode, "data-testid"), attributeValue(rootNode, "role")].find(Boolean) || (root ? "main" : "");
    const streamState = attributeValue(rootNode, "data-episode-stream-state");
    const unlabeledControls = controls.filter((control) => controlAccessibilityLabel(control).length === 0).length;
    return {
      root: Boolean(root),
      rootName,
      streamState,
      views,
      actions,
      accessibility: { rootNamed: rootName.length > 0, unlabeledControls, lang: attributeValue(document.documentElement, "lang") },
    };
  }, DEBUGGER_ROOT_SELECTOR);
}

/** @param {any} contract @param {{ state: string; width: number }} entry */
function assertDebuggerContract(contract, entry) {
  assertDebuggerRoot(contract, entry);
  assertDebuggerStreamState(contract, entry);
  assertDebuggerViews(contract, entry);
  assertDebuggerActions(contract, entry);
  assertDebuggerAccessibility(contract, entry);
}

/** @param {any} contract @param {{ state: string; width: number }} entry */
function assertDebuggerRoot(contract, entry) {
  if (contract?.root) return;
  throw new Error(`Debugger root is absent for ${entry.state} at ${entry.width}px`);
}

/** @param {any} contract @param {{ state: string; width: number }} entry */
function assertDebuggerStreamState(contract, entry) {
  if (typeof contract.streamState === "string" && contract.streamState.length > 0) return;
  throw new Error(`Debugger stream-state marker is absent for ${entry.state} at ${entry.width}px`);
}

/** @param {any} contract @param {{ state: string; width: number }} entry */
function assertDebuggerViews(contract, entry) {
  const missingViews = REQUIRED_VIEWS.filter((view) => contract.views?.[view] !== true);
  if (missingViews.length === 0) return;
  throw new Error(`Debugger views are absent for ${entry.state} at ${entry.width}px: ${missingViews.join(", ")}`);
}

/** @param {any} contract @param {{ state: string; width: number }} entry */
function assertDebuggerActions(contract, entry) {
  const requiredActions = requiredActionsForState(entry.state);
  const missingActions = requiredActions.filter((action) => contract.actions?.[action] !== true);
  if (missingActions.length === 0) return;
  throw new Error(`Debugger proof actions are absent for ${entry.state} at ${entry.width}px: ${missingActions.join(", ")}`);
}

/** @param {string} state */
function requiredActionsForState(state) {
  const requiredActions = ["copy-agent", "copy-all", "download-json"];
  if (RECOVERY_STATES.includes(state)) requiredActions.push("reconnect");
  if (GAP_STATES.includes(state)) requiredActions.push("gap");
  return requiredActions;
}

/** @param {any} contract @param {{ state: string; width: number }} entry */
function assertDebuggerAccessibility(contract, entry) {
  const accessibility = contract.accessibility || EMPTY_ACCESSIBILITY;
  const checks = [accessibility.rootNamed === true, accessibility.lang !== "", accessibility.unlabeledControls === 0];
  if (checks.every(Boolean)) return;
  throw new Error(`Debugger accessibility contract failed for ${entry.state} at ${entry.width}px`);
}

/**
 * @param {any} page
 * @param {any} contract
 * @param {number} timeoutMs
 * @param {{ capture?: boolean; outputDir?: string; state?: string; width?: number }} [screenshotOptions]
 */
async function exerciseViews(page, contract, timeoutMs, screenshotOptions = {}) {
  const exercised = [];
  const screenshotPaths = [];
  for (const view of REQUIRED_VIEWS) {
    await clickControl(page, view, timeoutMs);
    exercised.push(view);
    const screenshotPath = await captureViewScreenshot(page, screenshotOptions, view);
    if (screenshotPath) screenshotPaths.push(screenshotPath);
  }
  return { required: [...REQUIRED_VIEWS], exercised, available: contract.views, screenshotPaths };
}

/** @param {any} page @param {{ capture?: boolean; outputDir?: string; state?: string; width?: number }} options @param {string} view */
async function captureViewScreenshot(page, options, view) {
  if (!options.capture || !options.outputDir) return undefined;
  if (typeof page.screenshot !== "function") return undefined;
  const screenshotPath = join(options.outputDir, `episode-diagnostic-${options.state}-${view.toLowerCase()}-${options.width}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return screenshotPath;
}

/** @param {any} page @param {any} contract @param {number} timeoutMs */
async function exerciseActions(page, contract, state, timeoutMs) {
  const exercised = await clickBaseActions(page, timeoutMs);
  exercised.push(...(await exerciseRecoveryAction(page, contract, state, timeoutMs)));
  // A gap is evidence, not a command. Reading the explicit gap marker proves
  // the UI keeps visibility loss visible while the reconnect action runs.
  if (contract.actions.gap === true) exercised.push("gap");
  assertGapEvidence(contract, state);
  return { required: [...REQUIRED_ACTIONS], exercised, available: contract.actions };
}

/** @param {any} page @param {number} timeoutMs */
async function clickBaseActions(page, timeoutMs) {
  const exercised = [];
  for (const action of ["copy-agent", "copy-all", "download-json"]) {
    await clickControl(page, action, timeoutMs);
    exercised.push(action);
  }
  return exercised;
}

/** @param {any} page @param {any} contract @param {string} state @param {number} timeoutMs */
async function exerciseRecoveryAction(page, contract, state, timeoutMs) {
  if (contract.actions.reconnect !== true) return [];
  if (!RECOVERY_STATES.includes(state)) return [];
  await clickControl(page, "reconnect", timeoutMs);
  return ["reconnect"];
}

/** @param {any} contract @param {string} state */
function assertGapEvidence(contract, state) {
  if (!GAP_STATES.includes(state)) return;
  if (contract.actions.gap === true) return;
  throw new Error("Debugger visibility-gap marker is absent");
}

/** @param {any} page @param {string} name @param {number} timeoutMs */
async function clickControl(page, name, timeoutMs) {
  const selectorResult = await clickSelector(page, ACTION_SELECTORS[name], timeoutMs);
  if (selectorResult) return selectorResult;
  const roleResult = await clickByRole(page, name, timeoutMs);
  if (roleResult) return roleResult;
  const evaluationResult = await clickByEvaluation(page, actionLabels(name));
  if (evaluationResult) return evaluationResult;
  throw new Error(`Debugger action could not be exercised: ${name}`);
}

/** @param {any} page @param {string|undefined} selector @param {number} timeoutMs */
async function clickSelector(page, selector, timeoutMs) {
  if (!selector) return undefined;
  if (typeof page.locator !== "function") return undefined;
  return clickLocator(page.locator(selector), timeoutMs);
}

/** @param {any} page @param {string} name @param {number} timeoutMs */
async function clickByRole(page, name, timeoutMs) {
  if (typeof page.getByRole !== "function") return undefined;
  const role = controlRole(name);
  for (const label of actionLabels(name)) {
    const result = await clickLocator(page.getByRole(role, { name: new RegExp(label, "iu") }), timeoutMs);
    if (result) return result;
  }
  return undefined;
}

/** @param {string} name */
function controlRole(name) {
  return ACTION_CONTROL_NAMES.has(name) ? "button" : "tab";
}

/** @param {any} locator @param {number} timeoutMs */
async function clickLocator(locator, timeoutMs) {
  const first = await firstLocator(locator);
  if (!first) return undefined;
  if (!(await locatorEnabled(first))) return { clicked: false, disabled: true };
  await first.click({ timeout: timeoutMs });
  return { clicked: true };
}

/** @param {any} locator */
async function firstLocator(locator) {
  if (typeof locator.count !== "function") return undefined;
  if ((await locator.count()) === 0) return undefined;
  return locator.first();
}

/** @param {any} locator */
async function locatorEnabled(locator) {
  if (typeof locator.isEnabled !== "function") return true;
  return locator.isEnabled();
}

/** @param {any} page @param {string[]} needles */
async function clickByEvaluation(page, needles) {
  if (typeof page.evaluate !== "function") return undefined;
  const didClick = await page.evaluate(
    (labels) => {
      const root = document.querySelector('main.episode-debugger[data-chalk], [data-testid="episode-diagnostics-debugger"],[data-episode-debugger],[data-chalk-episode-debugger]');
      const rootNode = root || document.createElement("div");
      const controls = [...rootNode.querySelectorAll("button,a,[role=button],[role=tab]")];
      const controlLabels = controls.map((control) => [control.getAttribute("aria-label"), control.getAttribute("title"), control.getAttribute("data-testid"), control.textContent].filter(Boolean).join(" ").toLowerCase());
      const control = controls.find((_candidate, index) => labels.some((label) => controlLabels[index].includes(label)));
      if (!control) return false;
      if (control.matches(":disabled,[aria-disabled='true']")) return true;
      control.click();
      return true;
    },
    needles.map((label) => label.toLowerCase()),
  );
  if (didClick === true) return { clicked: true };
  return undefined;
}

/** @param {string} name */
function actionLabels(name) {
  return ACTION_LABELS[name] ?? [name];
}

/** @param {any} page */
async function readReadiness(page) {
  if (typeof page.evaluate !== "function") return { fixedClock: false, fontReady: false, dataReady: false };
  return page.evaluate(() => ({
    fixedClock: document.documentElement.dataset.episodeDiagnosticsFixedClock ?? document.body?.dataset.fixedClock ?? "",
    fontReady: document.fonts === undefined || document.fonts.status === "loaded",
    dataReady: Boolean(document.querySelector('main.episode-debugger[data-chalk], [data-testid="episode-diagnostics-debugger"],[data-episode-debugger],[data-chalk-episode-debugger]')),
  }));
}

/** @param {any} readiness @param {{ state: string; width: number }} entry */
function assertReadiness(readiness, entry) {
  if (readiness.fontReady !== true) throw new Error(`Debugger readiness failed for ${entry.state} at ${entry.width}px`);
  if (readiness.dataReady !== true) throw new Error(`Debugger readiness failed for ${entry.state} at ${entry.width}px`);
  assertFixedClock(readiness);
}

/** @param {any} readiness */
function assertFixedClock(readiness) {
  if (!readiness.fixedClock) return;
  if (readiness.fixedClock === FIXTURE_CLOCK) return;
  throw new Error("Debugger proof clock was not fixed");
}

/** @param {string} hostname */
function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/** @param {string} debuggerUrl */
export function visualMatrixURLs(debuggerUrl) {
  return VISUAL_MATRIX.map(({ state, width, height }) => ({ state, width, height, url: resolveDebuggerURL(debuggerUrl, state, "localhost") }));
}

export { inspectDebuggerContract, assertDebuggerContract, readReadiness };
