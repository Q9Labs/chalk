import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isMain } from "./script-entry.mjs";
import { checkReference, readTracker, repoRoot } from "./tracker-data.mjs";
import { renderHtml, renderMarkdown } from "./tracker-render.mjs";

const staticFiles = new Set(["/tracker.yaml", "/theory.md", "/design.md"]);

const htmlPage = async (root) => ({ body: renderHtml(await readTracker(root)), type: "text/html; charset=utf-8" });
const markdownPage = async (root) => ({ body: renderMarkdown(await readTracker(root)), type: "text/plain; charset=utf-8" });
const dynamicPages = new Map([
  ["/tracker-human.html", htmlPage],
  ["/tracker-human.md", markdownPage],
]);
const staticPage = async (root, pathname) => {
  const file = pathname.slice(1);
  await checkReference(root, file);
  return { body: await readFile(path.join(root, file), "utf8"), type: "text/plain; charset=utf-8" };
};

const page = async (root, pathname) => {
  const route = pathname === "/" ? "/tracker-human.html" : pathname;
  const readDynamicPage = dynamicPages.get(route);
  if (readDynamicPage) return readDynamicPage(root);
  if (staticFiles.has(route)) return staticPage(root, route);
};

const reply = (response, status, body, headers = {}) => {
  response.writeHead(status, headers);
  response.end(body);
};

const handleRequest = async (root, request, response) => {
  try {
    if (request.method !== "GET") {
      reply(response, 405, "Read-only tracker. Edit tracker.yaml locally.", { allow: "GET" });
      return;
    }
    const { pathname } = new URL(request.url, "http://127.0.0.1");
    const result = await page(root, pathname);
    if (!result) {
      reply(response, 404, "Not found");
      return;
    }
    reply(response, 200, result.body, {
      "content-type": result.type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
  } catch (error) {
    console.error(error);
    reply(response, 500, "Tracker could not be read. See the terminal for details.", { "content-type": "text/plain; charset=utf-8" });
  }
};

export const createTrackerServer = (root = repoRoot) => createServer((request, response) => handleRequest(root, request, response));

if (isMain(import.meta)) {
  const port = Number(process.env.TRACKER_PORT ?? 4176);
  const server = createTrackerServer();
  server.listen(port, "127.0.0.1", () => console.log(`Read-only tracker: http://127.0.0.1:${port}/tracker-human.html`));
}
