const baseView = {
  preferences: { style: "island", dock: { edge: "top", offset: 0.5 } },
  segment: null,
  strokes: [],
  draft: [],
  drawing: false,
  paused: false,
  color: "#ffffff",
  hotkey: false,
  fixture: false,
  approval: null,
  connected: false,
  liveDrawingAvailable: false,
  monitors: [],
  canFollowWindow: false,
  overlay: null,
  updateAvailable: false,
  updateStatus: null,
  device: { available: true, code: null, fingerprint: null, status: null },
  permission: { phase: "idle" },
  spaceName: null,
  captureStatus: null,
  launchAtLogin: true,
};
const display = (name, width, height) => ({ name, width, height });

export const SETTINGS_STATES = {
  waiting: { ...baseView, hotkey: true },
  pair: { ...baseView, approval: { fingerprint: "4F2A-91C0", confirmationCode: null, approved: false } },
  confirm: { ...baseView, approval: { fingerprint: "4F2A-91C0", confirmationCode: "K7QM-2X9F-HT4C-WP6N", approved: true } },
  display: { ...baseView, connected: true, captureStatus: "unbound", monitors: [display("Built-in display", 3024, 1964), display("LG UltraFine 27", 5120, 2880)] },
  permission: { ...baseView, connected: true, captureStatus: "unbound", canFollowWindow: true, permission: { phase: "needed" } },
  "permission-waiting": { ...baseView, connected: true, captureStatus: "unbound", canFollowWindow: true, permission: { phase: "settings_open" } },
  live: { ...baseView, connected: true, captureStatus: "ready", liveDrawingAvailable: true, canFollowWindow: true },
  "live-later": { ...baseView, connected: true, captureStatus: "ready", canFollowWindow: true, permission: { phase: "later" } },
  device: { ...baseView, device: { available: true, code: "K7QM2X9F", fingerprint: "7F3A-91C2", status: "Approve this code in your signed-in Chalk call." } },
};

export const OVERLAY_STATES = {
  hud: { ...baseView, fixture: true },
  "hud-drawing": { ...baseView, fixture: true, drawing: true },
  "draw-bar": { ...baseView, fixture: true, drawing: true },
};
