import { afterEach, describe, expect, it, vi } from "vitest";

import { joinParticipant, launchBrowser, leaveParticipant, stopParticipantCamera } from "./media-smoke-browser.mjs";

afterEach(() => vi.unstubAllEnvs());

describe("media smoke browser launch", () => {
  it("uses bundled Chromium first and falls back to the installed Chrome channel when it is missing", async () => {
    vi.stubEnv("CHALK_E2E_CHROMIUM_EXECUTABLE", "");
    const calls = [];
    const browser = { close: async () => {} };
    const browserType = {
      launch: async (options) => {
        calls.push(options);
        if (calls.length === 1) throw new Error("Executable doesn't exist at /missing/chromium");
        return browser;
      },
    };

    await expect(launchBrowser({ browserType })).resolves.toBe(browser);
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toHaveProperty("channel");
    expect(calls[0].args).toContain("--use-fake-device-for-media-stream");
    expect(calls[0].args).toContain("--use-fake-ui-for-media-stream");
    expect(calls[1].channel).toBe("chrome");
  });

  it("waits for a delayed pre-join control before declaring the join UI unsupported", async () => {
    const events = [];
    const controls = {
      name: createDelayedLocator("Enter your name", events),
      join: createDelayedLocator("Join Space", events),
      toolbar: createDelayedLocator("Episode controls", events),
    };
    const page = {
      async goto(url) {
        events.push(`goto:${url}`);
      },
      getByPlaceholder() {
        return controls.name;
      },
      getByRole(role, { name } = {}) {
        if (role === "button" && name?.test?.("Join Space")) return controls.join;
        throw new Error(`unexpected role lookup: ${role}`);
      },
      locator(selector) {
        expect(selector).toBe('[data-tour="video-grid"]');
        return controls.toolbar;
      },
    };

    await expect(joinParticipant({ page, name: "Chalk smoke primary" }, { webURL: "http://127.0.0.1:3070", webJoinPath: "/local", joinTimeoutMs: 50 })).resolves.toBeUndefined();
    expect(events).toEqual(["goto:http://127.0.0.1:3070/local?name=Chalk+smoke+primary", "wait:Enter your name", "fill:Chalk smoke primary", "wait:Join Space", "click:Join Space", "wait:Episode controls"]);
  });

  it("does not replace an explicit executable override after a launch error", async () => {
    vi.stubEnv("CHALK_E2E_CHROMIUM_EXECUTABLE", "/tmp/chalk-chromium");
    const calls = [];
    const browserType = {
      launch: async (options) => {
        calls.push(options);
        throw new Error("Executable doesn't exist at /tmp/chalk-chromium");
      },
    };

    await expect(launchBrowser({ browserType })).rejects.toThrow("/tmp/chalk-chromium");
    expect(calls).toHaveLength(1);
    expect(calls[0].executablePath).toBe("/tmp/chalk-chromium");
  });

  it("does not retry errors unrelated to the bundled executable", async () => {
    vi.stubEnv("CHALK_E2E_CHROMIUM_EXECUTABLE", "");
    const calls = [];
    const browserType = {
      launch: async (options) => {
        calls.push(options);
        throw new Error("Browser launch was denied");
      },
    };

    await expect(launchBrowser({ browserType })).rejects.toThrow("Browser launch was denied");
    expect(calls).toHaveLength(1);
  });

  it("checks the primary participant's remote guest track after a committed camera stop", async () => {
    const primary = createStopCameraPage({ remoteVideo: { kind: "video", readyState: "live", muted: false } });
    const guest = createStopCameraPage({ remoteVideo: { kind: "video", readyState: "live", muted: false } });
    primary.onStop = () => {
      primary.remoteVideo.readyState = "ended";
      primary.frames.push({ type: "ack", outcome: "committed", hasEventID: true, eventNames: [] });
      guest.frames.push({ type: "ack", outcome: "committed", hasEventID: true, eventNames: [] });
      primary.frames.push({ type: "event", eventNames: ["participant_camera_stopped"] });
      guest.frames.push({ type: "event", eventNames: ["participant_camera_stopped"] });
    };

    await expect(stopParticipantCamera({ page: primary.page }, { name: "Guest", page: guest.page }, { mediaTimeoutMs: 50, pollIntervalMs: 1 })).resolves.toMatchObject({ outcome: "committed" });
    expect(primary.remoteVideo.readyState).toBe("ended");
    expect(guest.remoteVideo.readyState).toBe("live");
  });

  it("closes an open participants panel before clicking Leave", async () => {
    const events = [];
    const panel = createVisibleLocator("panel", events);
    const close = createVisibleLocator("close", events, () => {
      panel.visible = false;
    });
    panel.getByRole = () => close;
    const leave = createVisibleLocator("leave", events, () => {
      if (panel.visible) throw new Error("leave was intercepted by participants panel");
    });
    const page = {
      getByRole(role, { name } = {}) {
        if (role === "complementary") return panel;
        if (role === "button" && name?.test?.("Close participant panel")) return close;
        return leave;
      },
    };

    await expect(leaveParticipant({ page })).resolves.toBeUndefined();
    expect(events).toEqual(["click:close", "click:leave"]);
  });
});

function createDelayedLocator(label, events) {
  let visible = false;
  return {
    async waitFor() {
      visible = true;
      events.push(`wait:${label}`);
    },
    async count() {
      return visible ? 1 : 0;
    },
    async fill(value) {
      events.push(`fill:${value}`);
    },
    async click() {
      events.push(`click:${label}`);
    },
  };
}

function createStopCameraPage({ remoteVideo }) {
  const frames = [];
  const controls = new Map();
  const state = { page: undefined, frames, remoteVideo, onStop: undefined };
  const getControl = (name) => {
    if (!controls.has(name)) controls.set(name, createVisibleLocator(name, [], name === "Stop camera" ? () => state.onStop?.() : undefined));
    return controls.get(name);
  };
  const panel = createVisibleLocator("Participants list", []);
  panel.getByRole = (_role, { name }) => getControl(name);
  const page = {
    getByRole(role, { name } = {}) {
      return role === "complementary" ? panel : getControl(name);
    },
    async evaluate(_callback, method) {
      if (method === "tracks") return { hasRtcConnection: true, remote: [remoteVideo], frames, journeyIds: [] };
      return undefined;
    },
  };
  state.page = page;
  return state;
}

function createVisibleLocator(label, events, onClick) {
  const locator = {
    visible: true,
    async count() {
      return locator.visible ? 1 : 0;
    },
    async isVisible() {
      return locator.visible;
    },
    async click() {
      events.push(`click:${label}`);
      await onClick?.();
    },
    getByRole() {
      return locator;
    },
  };
  return locator;
}
