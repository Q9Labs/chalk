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
  assert.equal(opensApp("/zzz-zzzz-zzz"), true);
  assert.equal(opensApp("/space/example"), true);
  for (const path of ["/abcd-efg-hij", "/abc-defg-hi", "/abc-defg-hijk", "/abc-defg-hij/", "/abc-defg-hij/extra", "/space"]) {
    assert.equal(opensApp(path), false, path);
  }
});

test("keeps all existing web routes, docs and public files in the browser", () => {
  const tree = readFileSync(new URL("apps/web/src/routeTree.gen.ts", root), "utf8");
  const fullPaths = tree.split("export interface FileRoutesByFullPath {")[1]?.split("\n}")[0];
  assert.ok(fullPaths, "expected the generated route inventory");
  const routes = [...fullPaths.matchAll(/'([^']+)':/g)].map((match) => match[1]);
  assert.ok(routes.includes("/privacy"));
  const docs = readFileSync(new URL("apps/web/src/docs/manifest.ts", root), "utf8");
  routes.push(...[...docs.matchAll(/href: "([^"]+)"/g)].map((match) => match[1]));
  for (const entry of readdirSync(new URL("apps/web/public/", root), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = `/${entry.parentPath.split("/apps/web/public/")[1] ?? ""}/${entry.name}`.replace(/\/+/g, "/");
    routes.push(path, path.replace(/\/index\.html$/, "/"));
  }
  for (const route of routes) {
    // These are the two deliberately associated call routes, not browser pages.
    if (route === "/$code" || route.startsWith("/space/")) continue;
    assert.equal(opensApp(route), false, route);
  }
});
