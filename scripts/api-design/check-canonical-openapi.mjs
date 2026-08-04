import { readFile } from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderCanonicalOpenAPI } from "./generate-canonical-openapi.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = path.join(repositoryRoot, "contract/generated/openapi.json");
const generatedPath = path.join(repositoryRoot, "apps/api/docs/generated-canonical-openapi.js");
const appPath = path.join(repositoryRoot, "apps/api/docs/app.js");
const source = JSON.parse(await readFile(sourcePath, "utf8"));
const generated = await readFile(generatedPath, "utf8");
if (generated !== (await renderCanonicalOpenAPI(source))) throw new Error("apps/api/docs/generated-canonical-openapi.js is stale");

const sandbox = { globalThis: {} };
vm.runInNewContext(generated, sandbox, { filename: generatedPath });
if (JSON.stringify(sandbox.globalThis.CHALK_API_DESIGN_OPENAPI) !== JSON.stringify(source)) {
  throw new Error("Canonical API design output does not equal contract/generated/openapi.json");
}

const app = await readFile(appPath, "utf8");
if (!app.includes("globalThis.CHALK_API_DESIGN_OPENAPI")) throw new Error("apps/api/docs/app.js does not consume the canonical OpenAPI contract");
if (!app.includes("return JSON.parse(JSON.stringify(CANONICAL_OPENAPI))")) throw new Error("OpenAPI export does not return the canonical contract");
const adapterEnd = app.indexOf("/* ---------- normalize ---------- */");
if (adapterEnd < 0) throw new Error("Canonical API design adapter boundary is missing");
const adapterContext = { globalThis: { CHALK_API_DESIGN_OPENAPI: source }, document: {}, console };
vm.runInNewContext(`${app.slice(0, adapterEnd)}\nglobalThis.__seed = SEED;`, adapterContext, { filename: appPath });
const seed = adapterContext.globalThis.__seed;
const seedOperations = seed.categories.flatMap((category) => category.e.map((operation) => `${operation.m} ${operation.p}`));
const contractOperations = Object.entries(source.paths || {}).flatMap(([pathname, pathItem]) =>
  Object.keys(pathItem)
    .filter((method) => /^(get|post|put|patch|delete|head|options|trace)$/i.test(method))
    .map((method) => `${method.toUpperCase()} ${pathname}`),
);
if (JSON.stringify(seedOperations.toSorted()) !== JSON.stringify(contractOperations.toSorted())) throw new Error("API design seed routes diverge from the canonical OpenAPI paths");
if (JSON.stringify(seed.components.map((component) => component.n)) !== JSON.stringify(Object.keys(source.components?.schemas || {}))) {
  throw new Error("API design seed schemas diverge from the canonical OpenAPI components");
}

console.log(`Canonical API design parity passed: ${Object.keys(source.paths).length} paths, ${Object.keys(source.components?.schemas || {}).length} schemas.`);
