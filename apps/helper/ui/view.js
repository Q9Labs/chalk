import { paintFixture, paintLive } from "./fixture-paint.js";

const { invoke } = window.__TAURI__.core;
const label = window.__TAURI_INTERNALS__.metadata.currentWindow.label;
const root = document.querySelector("#view");
const run = (kind, fields = {}) => invoke("act", { action: { kind, ...fields } });
const listen = (selector, event, handle) => root.querySelector(selector).addEventListener(event, handle);

function control(action, selector) {
  listen(selector, "click", () => void run(action).catch(showError));
}

function styleButtons() {
  return `<button type="button" data-style="island">Island</button>
    <button type="button" data-style="pill">Pill</button>`;
}

function bindStyleButtons() {
  root.querySelectorAll("[data-style]").forEach(button => {
    button.addEventListener("click", () => void run("change_style", { style: button.dataset.style }).catch(showError));
  });
}

function showError(error) {
  const status = root.querySelector("#status");
  if (status) status.textContent = error instanceof Error ? error.message : String(error);
}

const isOverlay = label.startsWith("ink-");
if (isOverlay) {
  root.innerHTML = '<canvas aria-label="Draw on the shared surface"></canvas>';
  const canvas = root.querySelector("canvas");
  let stroke = Promise.resolve();
  let lastMove = 0;
  const point = event => ({ x: event.clientX * devicePixelRatio, y: event.clientY * devicePixelRatio });
  const send = (kind, fields) => {
    stroke = stroke.then(() => run(kind, fields)).catch(showError);
  };
  canvas.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    send("begin_stroke", point(event));
  });
  canvas.addEventListener("pointermove", event => {
    if (canvas.hasPointerCapture(event.pointerId) && performance.now() - lastMove > 15) {
      lastMove = performance.now();
      send("add_point", point(event));
    }
  });
  canvas.addEventListener("pointerup", event => {
    if (!canvas.hasPointerCapture(event.pointerId)) return;
    send("add_point", point(event));
    send("finish_stroke");
  });
  canvas.addEventListener("pointercancel", () => send("cancel_stroke"));
  window.addEventListener("keydown", event => {
    if (event.key === "Escape") send("cancel_draw");
  });
} else if (label === "hud") {
  root.innerHTML = `<div class="hud" data-look="island" data-edge="top">
    <button class="grip" type="button" aria-label="Drag control" tabindex="-1"></button>
    <span class="sharing"><span class="pulse"></span><span class="word">Sharing screen</span></span>
    <button class="pencil" type="button" aria-label="Draw" title="Draw">✎</button>
    <button class="overflow" type="button" aria-label="Control options">•••</button>
    <span role="status" class="sr-only"></span>
  </div>`;
  control("toggle_draw", ".pencil");
  listen(".overflow", "click", () => void run("show_hud_menu").catch(showError));
  const grip = root.querySelector(".grip");
  let lastMove = 0;
  let drag = Promise.resolve();
  const send = kind => { drag = drag.then(() => run(kind)).catch(showError); };
  grip.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0) return;
    grip.setPointerCapture(event.pointerId);
    send("begin_drag");
  });
  grip.addEventListener("pointermove", event => {
    if (grip.hasPointerCapture(event.pointerId) && performance.now() - lastMove > 24) {
      lastMove = performance.now();
      send("drag");
    }
  });
  const end = () => send("end_drag");
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
} else if (label === "draw-bar") {
  const colors = ["white", "blue", "yellow", "red"];
  root.innerHTML = `<div class="drawbar"><span>Draw</span>
    ${colors.map(color => `<button class="color ${color}" type="button" data-color="${color}" aria-label="${color} ink"></button>`).join("")}
    <button type="button" class="done">Done</button><span role="status" class="sr-only"></span></div>`;
  root.querySelectorAll("[data-color]").forEach(button => {
    button.addEventListener("click", () => void run("change_color", { color: button.dataset.color }).catch(showError));
  });
  control("cancel_draw", ".done");
} else {
  root.innerHTML = `<section class="settings">
    <h1>Chalk Helper</h1>
    <p id="connection">Not connected</p>
    <p id="connection-help">Start sharing in Chalk to connect.</p>
    <div class="approval" hidden>
      <p>Compare this code with the code in Chalk.</p>
      <p id="fingerprint"></p>
      <p id="confirmation-code"></p>
      <button type="button" id="deny">Deny</button>
      <button type="button" id="allow">Allow</button>
    </div>
    <button type="button" id="follow-window" hidden>Follow captured window</button>
    <button type="button" id="live-draw" hidden>Draw one mark</button>
    <div id="displays" hidden><p>Choose the display you’re sharing.</p><div id="display-options"></div></div>
    <div id="device-code" hidden>
      <label>Account ID from your Chalk call <input id="device-account" maxlength="36" autocomplete="off" spellcheck="false"></label>
      <button type="button" id="new-device-code">Get a device code</button>
      <button type="button" id="forget-device">Remove local credential</button>
      <p id="device-status" role="status"></p>
      <p id="device-value"></p>
      <p id="device-fingerprint"></p>
    </div>
    <div class="setting"><span>Sharer control</span><div class="segment">${styleButtons()}</div></div>
    <div class="setting" id="shortcut" hidden><span>Draw shortcut</span><kbd>${navigator.platform.startsWith("Mac") ? "⌘ ⇧ 9" : "Ctrl Shift 9"}</kbd></div>
    <button type="button" id="update">Check for updates</button>
    <p role="status" id="status"></p>
  </section>`;
  bindStyleButtons();
  control("check_for_update", "#update");
  control("toggle_live_draw", "#live-draw");
  control("follow_window", "#follow-window");
  listen("#new-device-code", "click", () => void run("start_device_code", {
    tenant_id: root.querySelector("#device-account").value
  }).catch(showError));
  control("forget_device", "#forget-device");
  for (const [id, allowed] of [["#allow", true], ["#deny", false]]) {
    listen(id, "click", () => void run("decide_pairing", {
      fingerprint: root.querySelector("#fingerprint").textContent,
      allowed
    }).catch(showError));
  }
}

let renderedProbe;
async function paintView() {
  try {
    const view = await invoke("view");
    if (label === "ink-live") {
      const canvas = root.querySelector("canvas");
      paintLive(canvas, view.overlay);
      const probe = view.overlay?.kind === "probe" ? view.overlay.spec : undefined;
      if (probe?.nonce !== renderedProbe) {
        renderedProbe = probe?.nonce;
        if (probe) requestAnimationFrame(() => requestAnimationFrame(() => {
          if (renderedProbe !== probe.nonce) return;
          const ctx = canvas.getContext("2d");
          if (probe.points.every(({ x, y, rgb }) => {
            const pixel = ctx.getImageData(Math.round(x * canvas.width), Math.round(y * canvas.height), 1, 1).data;
            return rgb.every((component, channel) => pixel[channel] === component) && pixel[3] === 255;
          })) void run("probe_painted", { nonce: probe.nonce }).catch(showError);
        }));
      }
    } else if (isOverlay && view.segment) {
      paintFixture(root.querySelector("canvas"), view);
    } else if (label === "hud") {
      const hud = root.querySelector(".hud");
      hud.dataset.look = view.preferences.style;
      hud.dataset.edge = view.preferences.dock.edge;
      hud.querySelector(".word").textContent = view.paused ? "Marks paused" : "Sharing screen";
      hud.querySelector(".pencil").setAttribute("aria-pressed", String(view.drawing));
      hud.querySelector(".pencil").disabled = view.paused;
    } else if (label === "settings") {
      root.querySelector("#shortcut").hidden = !view.hotkey;
      root.querySelector("#connection").textContent = view.fixture ? "Development fixture" : view.connected ? "Connected" : "Not connected";
      root.querySelector("#connection-help").textContent = view.connected
        ? "Use the preview in Chalk while this capture is unverified."
        : "Start sharing in Chalk to connect.";
      root.querySelector("#follow-window").hidden = !view.canFollowWindow;
      root.querySelector("#live-draw").hidden = !view.liveDrawingAvailable;
      const displays = root.querySelector("#displays");
      const options = root.querySelector("#display-options");
      displays.hidden = view.monitors.length === 0;
      if (JSON.stringify(view.monitors) !== options.dataset.monitors) {
        options.dataset.monitors = JSON.stringify(view.monitors);
        options.replaceChildren(...view.monitors.map((monitor, index) => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = monitor;
          button.addEventListener("click", () => void run("select_monitor", { index }).catch(showError));
          return button;
        }));
      }
      root.querySelector(".approval").hidden = !view.approval;
      root.querySelector("#fingerprint").textContent = view.approval?.fingerprint ?? "";
      root.querySelector("#confirmation-code").textContent = view.approval ? `Confirmation code: ${view.approval.confirmationCode}` : "";
      root.querySelector("#device-code").hidden = !view.device?.available;
      const deviceStatus = root.querySelector("#device-status");
      if (deviceStatus.textContent !== (view.device?.status ?? "")) deviceStatus.textContent = view.device?.status ?? "";
      root.querySelector("#device-value").textContent = view.device?.code ?? "";
      root.querySelector("#device-fingerprint").textContent = view.device?.fingerprint ? `Fingerprint: ${view.device.fingerprint}` : "";
      if (view.updateStatus) root.querySelector("#status").textContent = view.updateStatus;
      root.querySelectorAll("[data-style]").forEach(button => {
        button.setAttribute("aria-pressed", String(button.dataset.style === view.preferences.style));
      });
    }
  } catch (error) {
    showError(error);
  }
}

let refreshTimer;
let refreshing = false;
let refreshAgain = false;
async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  clearTimeout(refreshTimer);
  refreshing = true;
  do {
    refreshAgain = false;
    await paintView();
  } while (refreshAgain);
  refreshing = false;
  refreshTimer = setTimeout(refresh, isOverlay ? 35 : 200);
}

if (label === "ink-live") {
  void window.__TAURI__.event.listen("chalk-overlay-changed", () => void refresh()).catch(showError);
}
void refresh();
