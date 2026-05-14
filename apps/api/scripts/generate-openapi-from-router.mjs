#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const apiDir = path.resolve(__dirname, "..");
const routerPath = path.join(apiDir, "internal/interfaces/http/router.go");
const openapiPath = path.join(apiDir, "openapi.yaml");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const GROUP_ASSIGNMENT_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([A-Za-z0-9_.]+)\.Group\("([^"]*)"\)/;
const ROUTE_RE =
	/^\s*([A-Za-z0-9_.]+)\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\("([^"]*)"/;

function toOpenAPIPath(ginPath) {
	return ginPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function normalizePath(value) {
	if (!value || value === "/") {
		return "/";
	}
	const withLeading = value.startsWith("/") ? value : `/${value}`;
	const squashed = withLeading.replace(/\/+/g, "/");
	if (squashed.length > 1 && squashed.endsWith("/")) {
		return squashed.slice(0, -1);
	}
	return squashed;
}

function joinPath(base, part) {
	return normalizePath(`${base || ""}/${part || ""}`);
}

function buildOperationId(method, pathValue) {
	const normalized = `${method.toLowerCase()}_${pathValue}`
		.replace(/[{}]/g, "")
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.replace(/_+/g, "_");
	return normalized || `${method.toLowerCase()}_root`;
}

function inferTag(pathValue) {
	const parts = pathValue.split("/").filter(Boolean);
	if (parts.length === 0) {
		return "system";
	}
	if (parts[0] === "api" && parts[1] === "v1") {
		return parts[2] || "api";
	}
	if (parts[0] === "ws") {
		return "websocket";
	}
	return parts[0];
}

function pathParameters(pathValue) {
	const params = [...pathValue.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
	return params.map((name) => ({
		name,
		in: "path",
		required: true,
		schema: {
			type: "string",
		},
	}));
}

function createStubOperation(method, openapiPathValue) {
	return {
		summary: `TODO: document ${method.toUpperCase()} ${openapiPathValue}`,
		description:
			"Auto-generated from router.go because this operation is not documented yet. Replace with explicit request/response schema.",
		"x-generated-stub": true,
		operationId: buildOperationId(method, openapiPathValue),
		tags: [inferTag(openapiPathValue)],
		parameters: pathParameters(openapiPathValue),
		responses: {
			"200": {
				description: "OK",
				content: {
					"application/json": {
						schema: {
							type: "object",
							additionalProperties: true,
						},
					},
				},
			},
		},
	};
}

function isLikelyGeneratedStub(operation) {
	if (!operation || typeof operation !== "object") {
		return false;
	}
	if (operation["x-generated-stub"] === true) {
		return true;
	}
	const summary = typeof operation.summary === "string" ? operation.summary : "";
	return summary.startsWith("TODO: document ");
}

function normalizeStubOperation(existingOperation, method, openapiPathValue) {
	const fallback = createStubOperation(method, openapiPathValue);
	const merged = {
		...fallback,
		...existingOperation,
		"x-generated-stub": true,
	};
	if (!merged.description) {
		merged.description = fallback.description;
	}
	return merged;
}

function extractRoutes(routerSource) {
	const lines = routerSource.split(/\r?\n/);
	const groupPrefixes = new Map([["r.engine", ""]]);
	const routes = [];

	lines.forEach((line, index) => {
		const groupMatch = line.match(GROUP_ASSIGNMENT_RE);
		if (groupMatch) {
			const [, childVar, parentVar, groupPath] = groupMatch;
			const parentPrefix = groupPrefixes.get(parentVar) ?? "";
			groupPrefixes.set(childVar, joinPath(parentPrefix, groupPath));
			return;
		}

		const routeMatch = line.match(ROUTE_RE);
		if (!routeMatch) {
			return;
		}

		const [, groupVar, method, rawPath] = routeMatch;
		const basePrefix = groupPrefixes.get(groupVar) ?? "";
		const fullGinPath = joinPath(basePrefix, rawPath);
		const openapiPathValue = toOpenAPIPath(fullGinPath);

		routes.push({
			method: method.toLowerCase(),
			path: openapiPathValue,
			line: index + 1,
		});
	});

	const deduped = new Map();
	for (const route of routes) {
		deduped.set(`${route.method} ${route.path}`, route);
	}
	return [...deduped.values()].sort((a, b) => {
		if (a.path !== b.path) {
			return a.path.localeCompare(b.path);
		}
		return a.method.localeCompare(b.method);
	});
}

function syncPaths(spec, routes) {
	const existingPaths = spec.paths ?? {};
	const nextPaths = {};
	const added = [];
	const kept = [];
	const removed = [];

	const methodsByPath = new Map();
	for (const route of routes) {
		const methods = methodsByPath.get(route.path) ?? new Set();
		methods.add(route.method);
		methodsByPath.set(route.path, methods);
	}

	for (const [pathValue, methods] of [...methodsByPath.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		const existingPathItem = existingPaths[pathValue] ?? {};
		const nextPathItem = {};

		for (const [key, value] of Object.entries(existingPathItem)) {
			if (!HTTP_METHODS.has(key.toLowerCase())) {
				nextPathItem[key] = value;
			}
		}

		for (const method of [...methods].sort()) {
			if (existingPathItem[method]) {
				const existingOperation = existingPathItem[method];
				nextPathItem[method] = isLikelyGeneratedStub(existingOperation)
					? normalizeStubOperation(existingOperation, method, pathValue)
					: existingOperation;
				kept.push(`${method.toUpperCase()} ${pathValue}`);
			} else {
				nextPathItem[method] = createStubOperation(method, pathValue);
				added.push(`${method.toUpperCase()} ${pathValue}`);
			}
		}

		nextPaths[pathValue] = nextPathItem;
	}

	for (const [pathValue, pathItem] of Object.entries(existingPaths)) {
		for (const method of Object.keys(pathItem)) {
			if (!HTTP_METHODS.has(method.toLowerCase())) {
				continue;
			}
			const routeKey = `${method.toLowerCase()} ${pathValue}`;
			if (!routes.find((route) => `${route.method} ${route.path}` === routeKey)) {
				removed.push(`${method.toUpperCase()} ${pathValue}`);
			}
		}
	}

	return {
		nextPaths,
		added,
		kept,
		removed,
	};
}

function main() {
	const checkOnly = process.argv.includes("--check");
	const routerSource = fs.readFileSync(routerPath, "utf8");
	const openapiSource = fs.readFileSync(openapiPath, "utf8");
	const spec = YAML.parse(openapiSource, { maxAliasCount: -1 });
	const routes = extractRoutes(routerSource);
	const { nextPaths, added, kept, removed } = syncPaths(spec, routes);
	spec.paths = nextPaths;

	const nextSource = YAML.stringify(spec, {
		lineWidth: 0,
	});

	if (checkOnly) {
		if (nextSource !== openapiSource) {
			console.error("openapi.yaml is out of sync with router.go");
			console.error(`routes: ${routes.length}, kept: ${kept.length}, added: ${added.length}, removed: ${removed.length}`);
			process.exit(1);
		}
		console.log(`openapi.yaml is in sync (routes: ${routes.length}, operations: ${kept.length})`);
		return;
	}

	fs.writeFileSync(openapiPath, nextSource);
	console.log(`Synced openapi.yaml with router.go`);
	console.log(`routes discovered: ${routes.length}`);
	console.log(`operations kept: ${kept.length}`);
	console.log(`operations added as stubs: ${added.length}`);
	console.log(`operations removed as stale: ${removed.length}`);
	if (added.length > 0) {
		console.log("added stubs:");
		for (const op of added) {
			console.log(`- ${op}`);
		}
	}
	if (removed.length > 0) {
		console.log("removed stale operations:");
		for (const op of removed) {
			console.log(`- ${op}`);
		}
	}
}

main();
