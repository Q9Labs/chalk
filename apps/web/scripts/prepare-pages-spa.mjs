import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { execSync } from "node:child_process";

const clientDir = resolve(process.cwd(), "dist", "client");
const shellPath = resolve(clientDir, "_shell.html");
const indexPath = resolve(clientDir, "index.html");
const fallback404Path = resolve(clientDir, "404.html");
const statusDirPath = resolve(clientDir, "status");
const statusIndexPath = resolve(statusDirPath, "index.html");
const serviceWorkerPath = resolve(clientDir, "sw.js");
const packageJsonPath = resolve(process.cwd(), "package.json");
const STATUS_TITLE = "Chalk Status";
const STATUS_DESCRIPTION = "Live system status, incidents, uptime, and maintenance updates for Chalk.";
const STATUS_CANONICAL = "https://chalkmeet.com/status";
const STATUS_IMAGE = "https://chalk-api.q9labs.ai/api/v1/status/card.png";

if (!existsSync(shellPath)) {
  throw new Error(`missing ${shellPath}; expected TanStack Start SPA build output to include _shell.html`);
}

// Cloudflare Pages: ensure deep-link loads SPA shell (even if rewrites are not applied).
cpSync(shellPath, indexPath);
cpSync(shellPath, fallback404Path);
mkdirSync(statusDirPath, { recursive: true });
cpSync(shellPath, statusIndexPath);
const statusHtml = readFileSync(statusIndexPath, "utf8");
writeFileSync(statusIndexPath, injectStatusMeta(statusHtml));

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const buildMeta = {
  commitHash: execSync("git rev-parse --short HEAD").toString().trim(),
  version: packageJson.version || "0.0.0",
};

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
const BUILD_META = ${JSON.stringify(buildMeta, null, 2)};
const CACHE_NAME = "chalk-web-${buildMeta.version}-${buildMeta.commitHash}";
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
  if (event.data?.type === "GET_BUILD_META") {
    event.ports?.[0]?.postMessage(BUILD_META);
    return;
  }

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

function injectStatusMeta(html) {
  let next = html;

  next = next.replace(/<title>.*?<\/title>/i, `<title>${STATUS_TITLE}</title>`);
  next = next.replace(
    /<link rel="canonical" href="[^"]*"\s*\/?>/i,
    `<link rel="canonical" href="${STATUS_CANONICAL}" />`,
  );

  const statusMeta = [
    `<meta name="description" content="${STATUS_DESCRIPTION}" />`,
    `<meta property="og:title" content="${STATUS_TITLE}" />`,
    `<meta property="og:description" content="${STATUS_DESCRIPTION}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${STATUS_CANONICAL}" />`,
    `<meta property="og:image" content="${STATUS_IMAGE}" />`,
    `<meta property="og:image:alt" content="Chalk status page preview" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${STATUS_TITLE}" />`,
    `<meta name="twitter:description" content="${STATUS_DESCRIPTION}" />`,
    `<meta name="twitter:image" content="${STATUS_IMAGE}" />`,
  ].join("\n");

  return next.replace("</head>", `${statusMeta}\n</head>`);
}
