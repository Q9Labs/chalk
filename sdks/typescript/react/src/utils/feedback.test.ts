// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const domToJpeg = vi.hoisted(() => vi.fn());
vi.mock("modern-screenshot", () => ({ domToJpeg }));

import { captureFeedbackScreenshot, collectBrowserFeedbackEvidence } from "./feedback";

const localStorageState = new Map<string, string>();
const localStorageStub = {
  get length() {
    return localStorageState.size;
  },
  key: (index: number) => [...localStorageState.keys()][index] ?? null,
  getItem: (key: string) => localStorageState.get(key) ?? null,
  setItem: (key: string, value: string) => localStorageState.set(key, value),
  removeItem: (key: string) => localStorageState.delete(key),
  clear: () => localStorageState.clear(),
};

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { configurable: true, value: localStorageStub });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorageStub.clear();
  document.cookie = "chalk_theme=; max-age=0";
  document.cookie = "chalk_sidebar_state=; max-age=0";
  document.cookie = "chalk_account_local=; max-age=0";
  document.cookie = "chalk_csrf_local=; max-age=0";
});

describe("feedback browser evidence", () => {
  it("only reports allowlisted cookies and validated local state", () => {
    window.localStorage.setItem("chalk.tenant-hint", "11111111-1111-4111-8111-111111111111");
    window.localStorage.setItem("chalk.web.telemetry.v1.22222222-2222-4222-8222-222222222222", JSON.stringify([{}, {}]));
    window.localStorage.setItem("chalk.dashboard-request.space_create", JSON.stringify({ key: "secret", fingerprint: "private" }));
    window.localStorage.setItem("host.private", "secret");
    document.cookie = "chalk_theme=dark";
    document.cookie = "chalk_sidebar_state=true";
    document.cookie = "private=secret";

    const evidence = collectBrowserFeedbackEvidence();

    expect(evidence.local_state?.tenant_hint).toBe("11111111-1111-4111-8111-111111111111");
    expect(evidence.local_state?.telemetry).toEqual({ storage_key: "chalk.web.telemetry.v1", pending_count: 2 });
    expect(evidence.local_state?.dashboard_requests).toEqual([{ action: "space_create", pending: true }]);
    expect(evidence.cookies).toEqual({ theme: "dark", sidebar_state: true, account_present: false, csrf_present: false });
  });

  it("reports presence for the Dashboard cookie names without exposing values", () => {
    document.cookie = "chalk_account_local=secret-account";
    document.cookie = "chalk_csrf_local=secret-csrf";

    expect(collectBrowserFeedbackEvidence().cookies).toEqual({ account_present: true, csrf_present: true });
  });
});

describe("captureFeedbackScreenshot", () => {
  it("excludes private nodes and returns a typed JPEG payload", async () => {
    const root = document.createElement("div");
    const safe = document.createElement("span");
    const privateNode = document.createElement("span");
    privateNode.dataset.chalkFeedbackPrivate = "true";
    root.append(safe, privateNode);
    root.getBoundingClientRect = () => new DOMRect(0, 0, 640, 480);
    domToJpeg.mockResolvedValue("data:image/jpeg;base64,ZmFrZQ==");

    const result = await captureFeedbackScreenshot(root);

    expect(result).toMatchObject({ state: "captured", mime_type: "image/jpeg", width: 640, height: 480, data_base64: "ZmFrZQ==" });
    const options = domToJpeg.mock.calls[0]?.[1];
    expect(options?.filter?.(root)).toBe(true);
    expect(options?.filter?.(privateNode)).toBe(false);
  });

  it("turns DOM measurement failures into an unavailable result", async () => {
    const root = document.createElement("div");
    root.getBoundingClientRect = () => {
      throw new Error("detached");
    };

    await expect(captureFeedbackScreenshot(root)).resolves.toEqual({ state: "unavailable", failure_code: "capture_failed" });
  });
});
