// Runs headed Chrome on a single-monitor Windows desktop. Uses only its local CDP port.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const directory = await mkdtemp(join(tmpdir(), "chalk-helper-probe-"));
const children = new Set();
const page = await readFile(new URL("index.html", import.meta.url));
const server = createServer((_, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(page);
}).listen(0, "127.0.0.1");
await once(server, "listening");
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
const chrome = process.env.CHALK_PROBE_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const proof = {};

function launch(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function until(getValue, seconds) {
  for (let attempt = 0; attempt < seconds * 5; attempt++) {
    const result = await getValue();
    if (result) return result;
    await delay(200);
  }
  throw Error("Timed out waiting for the capture probe.");
}

async function sample(session, protectedMarker, minimizeId) {
  const markerScript = fileURLToPath(new URL("windows.ps1", import.meta.url));
  const marker = launch("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", markerScript, ...(!protectedMarker ? ["-Unprotected"] : [])]);
  try {
    const lines = createInterface({ input: marker.stdout });
    const [out] = await once(lines, "line", { signal: AbortSignal.timeout(20_000) });
    const target = JSON.parse(out);
    if (target.affinity !== (protectedMarker ? 17 : 0)) throw Error("Unexpected affinity.");
    await session("Browser.setWindowBounds", { windowId: minimizeId, bounds: { windowState: "normal" } });
    await session("Page.navigate", { url: pageUrl });
    const coordinates = await until(async () => {
      const evaluated = await session("Runtime.evaluate", {
        returnByValue: true,
        expression: "document.querySelector('#start') && (() => {const r = document.querySelector('#start').getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y+r.height/2 };})()",
      });
      return evaluated.result.value;
    }, 5);
    await session("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...coordinates });
    await session("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...coordinates });
    const result = await until(async () => {
      const evaluated = await session("Runtime.evaluate", {
        returnByValue: true,
        expression: "document.querySelector('#result').textContent",
      });
      return evaluated.result.value && JSON.parse(evaluated.result.value);
    }, 30);
    if (result.error || result.surface !== "monitor" || !result.samples?.length) throw Error(JSON.stringify(result));
    return { ...result, target };
  } finally {
    marker.kill();
  }
}

try {
  launch(chrome, [
    `--user-data-dir=${directory}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--auto-select-desktop-capture-source=Entire screen", "--no-first-run", "--no-default-browser-check",
    "--window-position=550,100", "--window-size=650,500", "about:blank",
  ]);
  const port = await until(async () => (await readFile(join(directory, "DevToolsActivePort"), "utf8").catch(() => "")).split("\n")[0], 20);
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
  const target = targets.find(item => item.type === "page");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, "open", { signal: AbortSignal.timeout(10_000) });
  try {
    let nextId = 1;
    const session = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        socket.removeEventListener("message", receive);
        reject(Error(`Chrome did not respond to ${method}.`));
      }, 5000);
      function receive(event) {
        const response = JSON.parse(event.data);
        if (response.id !== id) return;
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
        if (response.error) reject(Error(response.error.message));
        else resolve(response.result);
      }
      socket.addEventListener("message", receive);
      socket.send(JSON.stringify({ id, method, params }));
    });
    const { windowId } = await session("Browser.getWindowForTarget", { targetId: target.id });
    proof.baseline = await sample(session, false, windowId);
    proof.excluded = await sample(session, true, windowId);
    const { width, height, target: { center }, samples } = proof.baseline;
    if (samples.some(frame => frame.markerPixels < 1000 || !frame.markerCenter)) throw Error("No positive marker control.");
    const errors = samples.map(({ markerCenter: [x, y] }) => Math.hypot(x - center[0], (y - center[1]) * height / width)).sort((a, b) => a - b);
    proof.markerAlignmentP95 = errors[Math.ceil(0.95 * errors.length) - 1];
    if (proof.markerAlignmentP95 >= 0.005) throw Error("Capture marker alignment missed 0.5% of frame width.");
    if (proof.excluded.samples.some(frame => frame.markerPixels !== 0)) throw Error("The marker leaked in the excluded capture.");
  } finally {
    socket.close();
  }
} catch (error) {
  proof.error = error.message;
  process.exitCode = 1;
} finally {
  await writeFile("windows-capture-result.json", JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof));
  for (const child of children) child.kill();
  server.close();
  await delay(500);
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {});
}
