import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isMain } from "./script-entry.mjs";
import { checkReference, readTracker, repoRoot } from "./tracker-data.mjs";
import { renderHtml, renderMarkdown } from "./tracker-render.mjs";

export const createTrackerServer = (root = repoRoot) =>
  createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET" });
        response.end("Read-only tracker. Edit tracker.yaml locally.");
        return;
      }
      let body;
      let type = "text/plain; charset=utf-8";
      if (url.pathname === "/" || url.pathname === "/tracker-human.html") {
        body = renderHtml(await readTracker(root));
        type = "text/html; charset=utf-8";
      } else if (url.pathname === "/tracker-human.md") {
        body = renderMarkdown(await readTracker(root));
      } else if (["/tracker.yaml", "/theory.md", "/design.md"].includes(url.pathname)) {
        await checkReference(root, url.pathname.slice(1));
        body = await readFile(path.join(root, url.pathname.slice(1)), "utf8");
      } else {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      response.writeHead(200, {
        "content-type": type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(body);
    } catch (error) {
      console.error(error);
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("Tracker could not be read. See the terminal for details.");
    }
  });

if (isMain(import.meta)) {
  const port = Number(process.env.TRACKER_PORT ?? 4176);
  const server = createTrackerServer();
  server.listen(port, "127.0.0.1", () => console.log(`Read-only tracker: http://127.0.0.1:${port}/tracker-human.html`));
}
