import { paintPermission } from "./permission-panel.js";
import { displayShape, groupedCode, settingsState, shortcutLabel, spaceLabel, spokenCode } from "./state.js";

let root;
let run;
let showError;
let refresh;
let listen;
let control;

export function mountSettings(deps) {
  ({ root, run, showError, refresh, listen, control } = deps);
  const hero = (icon, tone = "") => `<div class="hero ${tone}" aria-hidden="true"><svg viewBox="0 0 24 24">${icon}</svg></div>`;
  const shareIcon = '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M12 14V8M9 10l3-3 3 3M8 21h8"/>';
  const lockIcon = '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/>';
  const checkIcon = '<path d="M5 12l5 5 9-10"/>';
  const chevron = '<svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
  root.innerHTML = `<section class="settings" data-state="waiting">
    <header class="top"><span class="lamp" aria-hidden="true"></span><span id="space-label">Not connected</span></header>
    <h1 id="title" tabindex="-1">Share your screen in a Chalk call</h1>
    <p class="sr-only" role="status" id="announce"></p>
    <section class="pane" id="card-waiting" aria-labelledby="title" hidden>
      <div class="mid">${hero(shareIcon)}<p class="hint">Chalk Helper connects when your call asks.</p></div>
    </section>
    <section class="pane" id="card-pair" aria-labelledby="title" tabindex="-1" hidden>
      <div class="mid"><div class="code fp" id="pair-code" role="img"></div></div>
      <div class="actions"><button type="button" class="primary" id="allow">Yes, connect</button><button type="button" class="quiet" id="deny">No</button></div>
    </section>
    <section class="pane" id="card-confirm" aria-labelledby="title" tabindex="-1" hidden>
      <div class="mid"><div class="code cc" id="confirm-code" role="img"></div></div>
      <div class="actions"><button type="button" class="primary" id="copy-confirm" aria-label="Copy code">Copy code</button><button type="button" class="quiet" id="cancel-confirm">Cancel</button></div>
    </section>
    <section class="pane" id="card-display" aria-labelledby="title" hidden>
      <div class="mid"><div id="display-options" class="displays" role="group" aria-labelledby="title"></div></div>
    </section>
    <section class="pane" id="card-permission" aria-labelledby="title" hidden>
      <div class="mid">${hero(lockIcon)}</div>
      <div class="actions"><button type="button" class="primary" id="permission-primary" data-action="open_screen_recording_settings">Open System Settings</button><button type="button" class="quiet" id="permission-later">Not now</button></div>
    </section>
    <section class="pane" id="card-live" aria-labelledby="title" hidden>
      <div class="mid">${hero(checkIcon, "ok")}<p class="hint" id="live-text">Only you see Chalk Helper.</p></div>
      <div class="actions"><button type="button" class="primary" id="live-draw">Draw on my screen</button><button type="button" class="quiet" id="disconnect">Disconnect</button></div>
    </section>
    <section class="pane" id="card-device" aria-labelledby="title" hidden>
      <div class="mid form">
        <label class="field">Account ID from your Chalk call<input id="device-account" maxlength="36" autocomplete="off" spellcheck="false" /></label>
        <p id="device-status" role="status" class="hint"></p>
        <div class="code-row" id="device-code-row" hidden><div class="code small" id="device-value" role="img"></div><button type="button" class="copy" id="copy-device" aria-label="Copy device code">Copy</button></div>
        <p id="device-fingerprint" class="hint"></p>
      </div>
      <div class="actions"><button type="button" class="primary" id="new-device-code">Get a code</button><button type="button" class="quiet" id="device-back">Back</button></div>
    </section>
    <details class="advanced" id="advanced">
      <summary>${chevron}Details</summary>
      <div class="rows">
        <p data-for="pair">Connect only if your call shows the same code. It stops anyone else from drawing on your screen.</p>
        <p data-for="display">Pick the screen you chose in the browser.</p>
        <ol class="steps" data-for="permission">
          <li data-step="1"><span class="n" aria-hidden="true">1</span><span>Switch on Chalk Helper under Screen Recording</span></li>
          <li data-step="2"><span class="n" aria-hidden="true">2</span><span>If macOS asks to quit Chalk Helper, choose <b>Later</b></span></li>
        </ol>
        <p data-for="permission">Marks still show without it. With it, they stay on the window you share.</p>
        <p id="permission-wait" class="live-line" role="status" data-for="permission" hidden><span class="spin" aria-hidden="true"></span>Waiting for the switch. This updates on its own.</p>
        <button type="button" class="link" id="permission-finder" data-for="permission" hidden>Show Chalk Helper in Finder</button>
        <div class="row" id="follow-row" data-for="live" hidden><span class="grow">Keep marks on the shared window</span><button type="button" class="quiet small" id="follow-window">Turn on</button></div>
        <div class="row" data-for="waiting live"><span class="grow" id="login-label">Start with this Mac</span><button type="button" role="switch" class="switch" id="launch-at-login" aria-checked="false" aria-labelledby="login-label"></button></div>
        <div class="row" id="use-code-row" data-for="waiting" hidden><button type="button" class="quiet small" id="use-code">Use a device code</button></div>
        <div class="row muted" id="shortcut-row" data-for="live" hidden><span>Draw shortcut <kbd id="shortcut-keys"></kbd></span></div>
        <div class="row" data-for="waiting live"><span class="grow" id="style-label">Sharer control</span><div class="segment" role="group" aria-labelledby="style-label"><button type="button" data-style="island">Island</button><button type="button" data-style="pill">Pill</button></div></div>
        <div class="row" id="forget-row" data-for="waiting live" hidden><span class="grow">Saved device</span><button type="button" class="quiet small" id="forget-device">Remove</button></div>
        <div class="row" id="update-row" data-for="waiting live" hidden><span class="grow">Updates</span><button type="button" class="quiet small" id="update">Check for updates</button></div>
      </div>
    </details>
    <p role="status" id="status"></p>
  </section>`;
  root.querySelector("#shortcut-keys").textContent = shortcutLabel(navigator.platform);
  root.querySelectorAll("[data-style]").forEach((button) => {
    button.addEventListener("click", () => void run("change_style", { style: button.dataset.style }).catch(showError));
  });
  control("check_for_update", "#update");
  control("toggle_live_draw", "#live-draw");
  control("follow_window", "#follow-window");
  control("later_screen_recording", "#permission-later");
  control("show_app_in_finder", "#permission-finder");
  control("disconnect", "#disconnect");
  control("disconnect", "#cancel-confirm");
  control("forget_device", "#forget-device");
  listen("#permission-primary", "click", (event) => {
    const kind = event.currentTarget.dataset.action;
    if (kind) void run(kind).catch(showError);
  });
  listen("#launch-at-login", "click", (event) => {
    void run("set_launch_at_login", { enabled: event.currentTarget.getAttribute("aria-checked") !== "true" }).catch(showError);
  });
  listen("#use-code", "click", () => setDeviceOpen(true));
  listen("#device-back", "click", () => setDeviceOpen(false));
  listen("#new-device-code", "click", () => void run("start_device_code", { tenant_id: root.querySelector("#device-account").value }).catch(showError));
  for (const [id, allowed] of [
    ["#allow", true],
    ["#deny", false],
  ]) {
    listen(id, "click", () => void run("decide_pairing", { fingerprint: pairFingerprint, allowed }).catch(showError));
  }
  listen("#copy-confirm", "click", (event) => void copyValue(event.currentTarget, confirmCode));
  listen("#copy-device", "click", (event) => void copyValue(event.currentTarget, deviceCode));
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const escape = { pair: "#deny", permission: "#permission-later", device: "#device-back" }[shownState];
    if (escape) root.querySelector(escape).click();
  });
}

let pairFingerprint = "";
let confirmCode = "";
let deviceCode = "";
let deviceOpen = false;
let shownState;
let announced = "";
let autoSelected = false;

function setDeviceOpen(open) {
  deviceOpen = open;
  void refresh();
}

async function copyValue(button, value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    showError("Could not copy. Select the code and copy it instead.");
    return;
  }
  const text = button.textContent;
  button.textContent = "Copied";
  announce("Copied");
  setTimeout(() => {
    button.textContent = text;
  }, 2000);
}

function announce(text) {
  const live = root.querySelector("#announce");
  if (live.textContent !== text) live.textContent = text;
}

function paintDisplays(view) {
  const options = root.querySelector("#display-options");
  if (JSON.stringify(view.monitors) === options.dataset.monitors) return;
  options.dataset.monitors = JSON.stringify(view.monitors);
  options.replaceChildren(
    ...view.monitors.map((monitor, index) => {
      const button = document.createElement("button");
      button.type = "button";
      const screen = document.createElement("span");
      screen.className = "screen";
      screen.setAttribute("aria-hidden", "true");
      const shape = displayShape(monitor);
      screen.style.setProperty("--ratio", String(shape.width / shape.height));
      const name = document.createElement("span");
      name.textContent = monitor.name;
      button.append(screen, name);
      button.addEventListener("click", () => void run("select_monitor", { index }).catch(showError));
      return button;
    }),
  );
}

const noDevice = { available: false, status: "", code: "", fingerprint: null };
const text = (value) => value ?? "";

function paintDevice(view) {
  const device = view.device ?? noDevice;
  const status = root.querySelector("#device-status");
  if (status.textContent !== text(device.status)) status.textContent = text(device.status);
  deviceCode = text(device.code);
  const value = root.querySelector("#device-value");
  value.textContent = deviceCode;
  value.setAttribute("aria-label", `Code ${spokenCode(deviceCode)}`);
  root.querySelector("#device-code-row").hidden = !deviceCode;
  root.querySelector("#device-fingerprint").textContent = device.fingerprint ? `Check that your call shows this fingerprint: ${device.fingerprint}` : "";
  root.querySelector("#use-code-row").hidden = !device.available;
  root.querySelector("#forget-row").hidden = !device.available;
}

const headings = {
  waiting: "Share your screen in a Chalk call",
  pair: "Does your call show this?",
  confirm: "Type this in your call",
  display: "Which screen are you sharing?",
  permission: "Let Chalk Helper see your screen",
  connected: "Marks show on your screen",
  live: "Marks show on your screen",
  device: "Connect with a code",
};
const lamps = { waiting: "idle", device: "idle", pair: "wait", confirm: "wait", display: "ok", permission: "ok", connected: "ok", live: "ok" };
const paneFor = { connected: "live" };
const focusTargets = { pair: "#card-pair", confirm: "#card-confirm", display: "#display-options button", permission: "#permission-primary", device: "#device-account" };
const notConnected = new Set(["waiting", "device"]);
const withoutDetails = new Set(["confirm", "device"]);

function currentState(view) {
  const base = settingsState(view);
  const state = base === "waiting" && deviceOpen ? "device" : base;
  if (base !== "waiting") deviceOpen = false;
  return state;
}

function paintHeader(view, state) {
  root.querySelector(".settings").dataset.state = state;
  root.querySelector("#title").textContent = view.fixture ? "Development fixture" : headings[state];
  root.querySelector(".lamp").dataset.tone = lamps[state];
  root.querySelector("#space-label").textContent = notConnected.has(state) ? "Not connected" : spaceLabel(view);
  root.querySelector("#advanced").hidden = withoutDetails.has(state);
  paintPanes(paneFor[state] ?? state);
}

function paintPanes(pane) {
  for (const section of root.querySelectorAll(".settings > .pane")) section.hidden = section.id !== `card-${pane}`;
  for (const row of root.querySelectorAll("[data-for]")) row.classList.toggle("elsewhere", !row.dataset.for.split(" ").includes(pane));
}

function readApproval(view) {
  const approval = view.approval ?? {};
  pairFingerprint = approval.fingerprint ?? "";
  confirmCode = approval.confirmationCode ? groupedCode(approval.confirmationCode) : "";
}

function paintCodes(view) {
  readApproval(view);
  const pair = root.querySelector("#pair-code");
  pair.textContent = pairFingerprint;
  pair.setAttribute("aria-label", `Fingerprint ${spokenCode(pairFingerprint)}`);
  const confirm = root.querySelector("#confirm-code");
  if (confirm.dataset.code !== confirmCode) confirm.replaceChildren(...confirmGroups(confirmCode));
  confirm.dataset.code = confirmCode;
  confirm.setAttribute("aria-label", `Code ${spokenCode(confirmCode)}`);
}

const span = (properties) => Object.assign(document.createElement("span"), properties);

function confirmGroups(code) {
  return code.split("-").flatMap((group, index) => [...(index ? [span({ className: "sep", textContent: "-" })] : []), span({ textContent: group })]);
}

function paintControls(view) {
  root.querySelector("#launch-at-login").setAttribute("aria-checked", String(view.launchAtLogin));
  paintPermission(root, view.permission);
  root.querySelector("#update-row").hidden = !view.updateAvailable;
  if (view.updateStatus) root.querySelector("#status").textContent = view.updateStatus;
  root.querySelectorAll("[data-style]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.style === view.preferences.style));
  });
  paintLiveRows(view);
}

function paintLiveRows(view) {
  root.querySelector("#follow-row").hidden = !view.canFollowWindow;
  root.querySelector("#follow-window").textContent = view.permission?.phase === "later" ? "Turn on window follow" : "Turn on";
  root.querySelector("#live-draw").hidden = !view.liveDrawingAvailable;
  root.querySelector("#shortcut-row").hidden = !view.hotkey;
  root.querySelector("#live-text").textContent = view.captureStatus === "ready" ? "Only you see Chalk Helper." : "Chalk Helper is checking your screen.";
}

function onlyMonitorChoice(view) {
  return view.monitors.length === 1 && settingsState(view) === "connected";
}

function selectOnlyMonitor(view) {
  autoSelected &&= view.connected;
  if (autoSelected || !onlyMonitorChoice(view)) return;
  autoSelected = true;
  void run("select_monitor", { index: 0 }).catch(showError);
}

function announcement(state, heading) {
  if (state === "pair") return `${heading} Fingerprint ${spokenCode(pairFingerprint)}. Connect only if your call shows the same code.`;
  return state === "confirm" ? `${heading}. Code ${spokenCode(confirmCode)}.` : heading;
}

export function paintSettings(view) {
  const state = currentState(view);
  paintCodes(view);
  paintHeader(view, state);
  paintControls(view);
  paintDisplays(view);
  paintDevice(view);
  selectOnlyMonitor(view);
  if (state === shownState) return;
  shownState = state;
  announce(announcement(state, root.querySelector("#title").textContent));
  root.querySelector(focusTargets[state] ?? "#title")?.focus();
}
