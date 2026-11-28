import { paintFixture, paintLive } from "./fixture-paint.js";
import { mountSettings, paintSettings } from "./settings.js";

const { invoke } = window.__TAURI__.core;
const label = window.__TAURI_INTERNALS__.metadata.currentWindow.label;
const root = document.querySelector("#view");
const run = (kind, fields = {}) => invoke("act", { action: { kind, ...fields } });
const listen = (selector, event, handle) => root.querySelector(selector).addEventListener(event, handle);

function control(action, selector) {
  listen(selector, "click", () => void run(action).catch(showError));
}

function showError(error) {
  const status = root.querySelector("#status");
  if (status) status.textContent = error instanceof Error ? error.message : String(error);
}

window.addEventListener("keydown", () => (document.documentElement.dataset.keys = ""), { once: true });

const isOverlay = label.startsWith("ink-");
if (isOverlay) {
  root.innerHTML = '<canvas aria-label="Draw on the shared surface"></canvas>';
  const canvas = root.querySelector("canvas");
  let stroke = Promise.resolve();
  let lastMove = 0;
  const point = (event) => ({ x: event.clientX * devicePixelRatio, y: event.clientY * devicePixelRatio });
  const send = (kind, fields) => {
    stroke = stroke.then(() => run(kind, fields)).catch(showError);
  };
  canvas.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    send("begin_stroke", point(event));
  });
  canvas.addEventListener("pointermove", (event) => {
    if (canvas.hasPointerCapture(event.pointerId) && performance.now() - lastMove > 15) {
      lastMove = performance.now();
      send("add_point", point(event));
    }
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!canvas.hasPointerCapture(event.pointerId)) return;
    send("add_point", point(event));
    send("finish_stroke");
  });
  canvas.addEventListener("pointercancel", () => send("cancel_stroke"));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") send("cancel_draw");
  });
} else if (label === "hud") {
  root.innerHTML = `<div class="hud" role="toolbar" aria-label="Chalk Helper controls" data-look="island" data-edge="top">
    <button class="grip" type="button" aria-label="Drag control" tabindex="-1" aria-hidden="true"></button>
    <span class="sharing"><span class="pulse" aria-hidden="true"></span><span class="word">Sharing screen</span></span>
    <button class="pencil" type="button" aria-label="Draw" aria-pressed="false" title="Draw">✎</button>
    <button class="overflow" type="button" aria-label="More options" aria-haspopup="menu">•••</button>
    <span role="status" class="sr-only"></span>
  </div>`;
  control("toggle_draw", ".pencil");
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && root.querySelector(".pencil").getAttribute("aria-pressed") === "true") void run("toggle_draw").catch(showError);
  });
  listen(".overflow", "click", () => void run("show_hud_menu").catch(showError));
  const grip = root.querySelector(".grip");
  let lastMove = 0;
  let drag = Promise.resolve();
  const send = (kind) => {
    drag = drag.then(() => run(kind)).catch(showError);
  };
  grip.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    grip.setPointerCapture(event.pointerId);
    send("begin_drag");
  });
  grip.addEventListener("pointermove", (event) => {
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
  root.innerHTML = `<div class="drawbar" role="toolbar" aria-label="Draw on your screen"><span id="drawbar-title">Draw</span>
    ${colors.map((color) => `<button class="color ${color}" type="button" data-color="${color}" aria-label="${color} ink" aria-pressed="false"></button>`).join("")}
    <button type="button" class="done">Done</button><span role="status" class="sr-only"></span></div>`;
  root.querySelectorAll("[data-color]").forEach((button) => {
    button.addEventListener("click", () => void run("change_color", { color: button.dataset.color }).catch(showError));
  });
  control("cancel_draw", ".done");
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") void run("cancel_draw").catch(showError);
  });
} else {
  mountSettings({ root, run, showError, refresh, listen, control });
}

let renderedProbe;
function paintLiveView(view) {
  const canvas = root.querySelector("canvas");
  paintLive(canvas, view.overlay);
  acknowledgeProbe(canvas, view.overlay);
}

function acknowledgeProbe(canvas, overlay) {
  if (overlay?.kind !== "probe") {
    renderedProbe = undefined;
    return;
  }
  const probe = overlay.spec;
  if (probe.nonce === renderedProbe) return;
  renderedProbe = probe.nonce;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (renderedProbe !== probe.nonce) return;
      const ctx = canvas.getContext("2d");
      if (
        probe.points.every(({ x, y, rgb }) => {
          const pixel = ctx.getImageData(Math.round(x * canvas.width), Math.round(y * canvas.height), 1, 1).data;
          return rgb.every((component, channel) => pixel[channel] === component) && pixel[3] === 255;
        })
      )
        void run("probe_painted", { nonce: probe.nonce }).catch(showError);
    }),
  );
}

function paintHud(view) {
  const hud = root.querySelector(".hud");
  hud.dataset.look = view.preferences.style;
  hud.dataset.edge = view.preferences.dock.edge;
  hud.querySelector(".word").textContent = view.paused ? "Marks paused" : "Sharing screen";
  hud.querySelector(".pencil").setAttribute("aria-pressed", String(view.drawing));
  hud.querySelector(".pencil").disabled = view.paused;
}

function paintFixtureWindow(view) {
  if (isOverlay && view.segment) paintFixture(root.querySelector("canvas"), view);
}
const paintWindow = { "ink-live": paintLiveView, hud: paintHud, settings: paintSettings }[label] ?? paintFixtureWindow;

async function paintView() {
  try {
    paintWindow(await invoke("view"));
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
