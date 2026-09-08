import type { FeedbackEvidenceInput, FeedbackScreenshotCapture, FeedbackScreenshotUnavailable } from "@q9labsai/chalk-client";
import { domToJpeg } from "modern-screenshot";

const MAX_SCREENSHOT_BYTES = 450 * 1024;
const MAX_SCREENSHOT_WIDTH = 1_920;
const MAX_SCREENSHOT_HEIGHT = 1_080;
const SAFE_COOKIE_NAMES = new Set(["chalk_theme", "chalk_sidebar_state", "account", "csrf", "__Host-chalk_account", "chalk_account_local", "__Host-chalk_csrf", "chalk_csrf_local"]);
const ACCOUNT_COOKIE_NAMES = ["account", "__Host-chalk_account", "chalk_account_local"];
const CSRF_COOKIE_NAMES = ["csrf", "__Host-chalk_csrf", "chalk_csrf_local"];

export type FeedbackScreenshotResult = FeedbackScreenshotCapture | FeedbackScreenshotUnavailable;

export function collectBrowserFeedbackEvidence(): FeedbackEvidenceInput {
  const tenantHint = readTenantHint();
  const telemetry = readTelemetrySummary();
  const dashboardRequests = readDashboardRequests();
  return {
    sdk: { client: "@q9labsai/chalk-client", react: "@q9labsai/chalk-react" },
    platform: { kind: "web", ...browserMetadata() },
    local_state: {
      ...(tenantHint ? { tenant_hint: tenantHint } : {}),
      ...(telemetry ? { telemetry } : {}),
      ...(dashboardRequests.length > 0 ? { dashboard_requests: dashboardRequests } : {}),
    },
    cookies: readFeedbackCookies(),
  };
}

export async function captureFeedbackScreenshot(root: HTMLElement | null): Promise<FeedbackScreenshotResult> {
  if (!root || typeof window === "undefined") return { state: "unavailable", failure_code: "unsupported" };

  try {
    const bounds = root.getBoundingClientRect();
    const width = Math.round(bounds.width);
    const height = Math.round(bounds.height);
    if (width <= 0 || height <= 0) return { state: "unavailable", failure_code: "unsupported" };
    const dataUrl = await domToJpeg(root, {
      quality: 0.78,
      width: Math.min(width, MAX_SCREENSHOT_WIDTH),
      height: Math.min(height, MAX_SCREENSHOT_HEIGHT),
      filter: (node) => !(node instanceof Element && Boolean(node.closest("[data-chalk-feedback-private], [data-chalk-host-content]"))),
    });
    const separator = dataUrl.indexOf(",");
    if (separator < 0) return { state: "unavailable", failure_code: "capture_failed" };
    const encoded = dataUrl.slice(separator + 1);
    if (encoded.length * 0.75 > MAX_SCREENSHOT_BYTES) return { state: "unavailable", failure_code: "too_large" };
    return {
      state: "captured",
      mime_type: "image/jpeg",
      width: Math.min(width, MAX_SCREENSHOT_WIDTH),
      height: Math.min(height, MAX_SCREENSHOT_HEIGHT),
      captured_at: new Date().toISOString(),
      data_base64: encoded,
    };
  } catch {
    return { state: "unavailable", failure_code: "capture_failed" };
  }
}

function browserMetadata(): Omit<FeedbackEvidenceInput["platform"], "kind"> {
  if (typeof navigator === "undefined") return {};
  return {
    browser_name: browserName(navigator.userAgent),
    device_class: typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches ? "phone" : "desktop",
  };
}

function browserName(userAgent: string): string | undefined {
  if (/edg\//iu.test(userAgent)) return "Edge";
  if (/firefox\//iu.test(userAgent)) return "Firefox";
  if (/chrome\//iu.test(userAgent)) return "Chrome";
  if (/safari\//iu.test(userAgent)) return "Safari";
  return undefined;
}

function readTenantHint(): string | undefined {
  try {
    const value = window.localStorage.getItem("chalk.tenant-hint") ?? undefined;
    return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readTelemetrySummary(): NonNullable<FeedbackEvidenceInput["local_state"]>["telemetry"] | undefined {
  try {
    let pendingCount = 0;
    let found = false;
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key !== "chalk.web.telemetry.v1" && !key?.startsWith("chalk.web.telemetry.v1.")) continue;
      const raw = key ? window.localStorage.getItem(key) : null;
      if (!raw) continue;
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value)) continue;
      found = true;
      pendingCount = Math.min(500, pendingCount + value.length);
    }
    return found ? { storage_key: "chalk.web.telemetry.v1", pending_count: pendingCount } : undefined;
  } catch {
    return undefined;
  }
}

function readDashboardRequests(): NonNullable<NonNullable<FeedbackEvidenceInput["local_state"]>["dashboard_requests"]> {
  try {
    const requests: { action: string; pending: true }[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith("chalk.dashboard-request.")) continue;
      const action = key.slice("chalk.dashboard-request.".length);
      if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(action)) continue;
      requests.push({ action, pending: true });
    }
    return requests.slice(0, 32);
  } catch {
    return [];
  }
}

function readFeedbackCookies(): FeedbackEvidenceInput["cookies"] {
  if (typeof document === "undefined") return {};
  const values = new Map<string, string>();
  for (const item of document.cookie.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const name = item.slice(0, separator).trim();
    if (SAFE_COOKIE_NAMES.has(name)) values.set(name, item.slice(separator + 1));
  }
  const theme = values.get("chalk_theme");
  const sidebarState = values.get("chalk_sidebar_state");
  return {
    ...(theme === "light" || theme === "dark" || theme === "system" ? { theme } : {}),
    ...(sidebarState === "true" || sidebarState === "false" ? { sidebar_state: sidebarState === "true" } : {}),
    account_present: ACCOUNT_COOKIE_NAMES.some((name) => values.has(name)),
    csrf_present: CSRF_COOKIE_NAMES.some((name) => values.has(name)),
  };
}
