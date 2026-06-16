import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { findOpenApiStubs } from "./lib/openapi-stubs.mjs";

const contract = parse(readFileSync("apps/api/openapi.yaml", "utf8"));
const stubs = findOpenApiStubs(contract);

if (stubs.length > 0) {
  console.error("OpenAPI generated stubs remain:");
  for (const stub of stubs) console.error(`- ${stub}`);
  process.exit(1);
}

console.log("OpenAPI contains no generated stubs.");
