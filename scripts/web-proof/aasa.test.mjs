import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const association = JSON.parse(readFileSync(new URL("apps/web/public/.well-known/apple-app-site-association", root), "utf8"));
const paths = association.applinks.details[0].paths;

// Apple's paths use shell-style * and ?, not regular expressions; first match wins.
function opensApp(pathname) {
  for (const rule of paths) {
    const excluded = rule.startsWith("NOT ");
    const pattern = excluded ? rule.slice(4) : rule;
    const expression = [...pattern].map((character) => (character === "*" ? ".*" : character === "?" ? "." : character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
    if (new RegExp(`^${expression}$`, "u").test(pathname)) return !excluded;
  }
  return false;
}

test("associates short codes without widening existing Space links", () => {
  assert.equal(opensApp("/abc-defg-hij"), true);
  assert.equal(opensApp("/apple-tiger-lamp-river"), true);
  assert.equal(opensApp("/zzz-zzzz-zzz"), true);
  assert.equal(opensApp("/space/example"), true);
  for (const path of ["/abcd-efg-hij", "/abc-defg-hi", "/abc-defg-hijk", "/abc-defg-hij/", "/abc-defg-hij/extra", "/space"]) {
    assert.equal(opensApp(path), false, path);
  }
});

function generatedRoutes() {
  const tree = readFileSync(new URL("apps/web/src/routeTree.gen.ts", root), "utf8");
  const fullPaths = tree.split("export interface FileRoutesByFullPath {")[1]?.split("\n}")[0];
  assert.ok(fullPaths, "expected the generated route inventory");
  return [...fullPaths.matchAll(/'([^']+)':/g)].map((match) => match[1]);
}

function docRoutes() {
  const docs = readFileSync(new URL("apps/web/src/docs/manifest.ts", root), "utf8");
  return [...docs.matchAll(/href: "([^"]+)"/g)].map((match) => match[1]);
}

function publicFileRoutes() {
  return readdirSync(new URL("apps/web/public/", root), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `/${entry.parentPath.split("/apps/web/public/")[1] ?? ""}/${entry.name}`.replace(/\/+/g, "/"))
    .flatMap((path) => [path, path.replace(/\/index\.html$/, "/")]);
}

// These are the two deliberately associated call routes, not browser pages.
const isCallRoute = (route) => route === "/$code" || route.startsWith("/space/");

test("keeps all existing web routes, docs and public files in the browser", () => {
  const routes = generatedRoutes();
  assert.ok(routes.includes("/privacy"));
  const browserRoutes = [...routes, ...docRoutes(), ...publicFileRoutes()].filter((route) => !isCallRoute(route));
  for (const route of browserRoutes) {
    assert.equal(opensApp(route), false, route);
  }
});

test("excludes web paths that the loose four-word wildcard would otherwise claim", () => {
  for (const path of [
    "/.well-known/apple-app-site-association",
    "/brand/chalk/chalk-icon-maskable-192.png",
    "/brand/chalk/chalk-icon-maskable-512.png",
    "/brand/chalk/nightly/chalk-icon-maskable-192.png",
    "/brand/chalk/nightly/chalk-icon-maskable-512.png",
    "/images/social/chalk-og-nightly-20261024.png",
    "/docs/a-b-c-d",
    "/dashboard/call/a-b-c-d",
  ]) {
    assert.match(path, /^\/.+-.*-.*-.+$/u);
    assert.equal(opensApp(path), false, path);
  }
});
