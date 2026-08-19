import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { execSync } from "node:child_process";

import { DOCS_PAGES } from "../src/docs/manifest.ts";
import { SITE_ORIGIN, SOCIAL_IMAGE_URL } from "../src/lib/site-head.ts";

const clientDir = resolve(process.cwd(), "dist", "client");
const shellPath = resolve(clientDir, "_shell.html");
const indexPath = resolve(clientDir, "index.html");
const fallback404Path = resolve(clientDir, "404.html");
const spaceDirPath = resolve(clientDir, "space");
const spaceIndexPath = resolve(spaceDirPath, "index.html");
const statusDirPath = resolve(clientDir, "status");
const statusIndexPath = resolve(statusDirPath, "index.html");
const privacyIndexPath = resolve(clientDir, "privacy", "index.html");
const termsIndexPath = resolve(clientDir, "terms", "index.html");
const serviceWorkerPath = resolve(clientDir, "sw.js");
const packageJsonPath = resolve(process.cwd(), "package.json");

function resolveCommitHash() {
  const commitHash = process.env.CHALK_COMMIT_SHA?.trim() || process.env.GITHUB_SHA?.trim() || execSync("git rev-parse HEAD").toString().trim();
  if (!/^[0-9a-f]{40}$/.test(commitHash)) {
    throw new Error(`CHALK_COMMIT_SHA must be a full 40-character lowercase commit SHA; received ${commitHash || "unknown"}`);
  }
  return commitHash;
}

if (!existsSync(shellPath)) {
  throw new Error(`missing ${shellPath}; expected TanStack Start SPA build output to include _shell.html`);
}

for (const publicPagePath of [indexPath, statusIndexPath, privacyIndexPath, termsIndexPath]) {
  if (!existsSync(publicPagePath)) {
    throw new Error(`missing ${publicPagePath}; expected TanStack Start to prerender every public web page`);
  }
}

// Cloudflare Pages: ensure unknown paths and Space deep links load the SPA shell
// even if a redirect rule is bypassed.
cpSync(shellPath, fallback404Path);
mkdirSync(spaceDirPath, { recursive: true });
cpSync(shellPath, spaceIndexPath);

const shellHtml = readFileSync(shellPath, "utf8");

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function buildDocsHtml(page) {
  const title = `${page.title} | Chalk Docs`;
  const canonicalUrl = `${SITE_ORIGIN}${page.href}`;
  const titleTag = `<title>${escapeHtml(title)}</title>`;
  const descriptionTag = `<meta name="description" content="${escapeHtml(page.description)}">`;
  const socialTags = [
    `<link rel="canonical" href="${canonicalUrl}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Chalk">',
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(page.description)}">`,
    `<meta property="og:url" content="${canonicalUrl}">`,
    `<meta property="og:image" content="${SOCIAL_IMAGE_URL}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(page.description)}">`,
    `<meta name="twitter:image" content="${SOCIAL_IMAGE_URL}">`,
  ].join("\n    ");

  const withTitle = shellHtml.replace(/<title>[^<]*<\/title>/i, titleTag);
  const withDescription = withTitle.replace(/<meta\s+name=["']description["'][^>]*>/i, descriptionTag);
  return withDescription.replace("</head>", `    ${socialTags}\n  </head>`);
}

for (const page of DOCS_PAGES) {
  if (page.href !== "/docs" && !page.href.startsWith("/docs/")) {
    throw new Error(`invalid docs path ${page.href}; expected /docs or a child path`);
  }

  const docsPageDir = resolve(clientDir, ...page.href.slice(1).split("/"));
  mkdirSync(docsPageDir, { recursive: true });
  writeFileSync(resolve(docsPageDir, "index.html"), buildDocsHtml(page));
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const buildMeta = {
  commitHash: resolveCommitHash(),
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

const precacheUrls = Array.from(new Set(["/", "/index.html", "/404.html", ...collectClientFiles(clientDir)])).sort();

const swSource = `
const BUILD_META = ${JSON.stringify(buildMeta, null, 2)};
const CACHE_NAME = "chalk-web-${buildMeta.version}-${buildMeta.commitHash}";
const APP_SHELL_URL = "/_shell.html";
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
      await writeToCache(request, response.clone());
      return response;
    }
  } catch {
    // Fall back to the cached shell below.
  }

  return (await readFromCache(request)) ?? (await readFromCache(APP_SHELL_URL)) ?? Response.error();
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

  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    return;
  }

  if (request.mode === "navigate" || !ASSET_EXT_RE.test(url.pathname)) {
    event.respondWith(handleNavigation(request));
    return;
  }

  event.respondWith(handleAsset(request));
});
`.trimStart();

writeFileSync(serviceWorkerPath, swSource);
