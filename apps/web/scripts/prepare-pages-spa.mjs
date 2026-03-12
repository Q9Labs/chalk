import { cpSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const clientDir = resolve(process.cwd(), "dist", "client");
const shellPath = resolve(clientDir, "_shell.html");
const indexPath = resolve(clientDir, "index.html");
const fallback404Path = resolve(clientDir, "404.html");
const serviceWorkerPath = resolve(clientDir, "sw.js");

if (!existsSync(shellPath)) {
  throw new Error(`missing ${shellPath}; expected TanStack Start SPA build output to include _shell.html`);
}

// Cloudflare Pages: ensure deep-link loads SPA shell (even if rewrites are not applied).
cpSync(shellPath, indexPath);
cpSync(shellPath, fallback404Path);

function collectClientFiles(dir) {
  return readdirSync(dir, {
    withFileTypes: true,
  }).flatMap((entry) => {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      return collectClientFiles(fullPath);
    }

    const relativePath = relative(clientDir, fullPath).split(sep).join("/");
    if (relativePath === "sw.js" || relativePath.endsWith(".map")) {
      return [];
    }

    return [`/${relativePath}`];
  });
}

const precacheUrls = Array.from(
  new Set(["/", "/index.html", "/404.html", ...collectClientFiles(clientDir)]),
).sort();

const swSource = `
const CACHE_NAME = "chalk-web-${Date.now()}";
const APP_SHELL_URL = "/index.html";
const PRECACHE_URLS = ${JSON.stringify(precacheUrls, null, 2)};
const ASSET_EXT_RE = /\\.[a-z0-9]+$/i;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

async function readFromCache(request) {
  const cache = await caches.open(CACHE_NAME);
  return cache.match(request);
}

async function writeToCache(request, response) {
  if (!response || !response.ok) {
    return response;
  }

  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
  return response;
}

async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      await writeToCache(APP_SHELL_URL, response.clone());
      return response;
    }
  } catch {
    // Fall back to the cached shell below.
  }

  return (await readFromCache(APP_SHELL_URL)) ?? Response.error();
}

async function handleAsset(request) {
  const cached = await readFromCache(request);
  if (cached) {
    void fetch(request)
      .then((response) => writeToCache(request, response))
      .catch(() => {});
    return cached;
  }

  try {
    const response = await fetch(request);
    return await writeToCache(request, response);
  } catch {
    return (await readFromCache(request)) ?? Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate" || (!ASSET_EXT_RE.test(url.pathname) && !url.pathname.startsWith("/api/"))) {
    event.respondWith(handleNavigation(request));
    return;
  }

  event.respondWith(handleAsset(request));
});
`.trimStart();

writeFileSync(serviceWorkerPath, swSource);
