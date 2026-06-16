const httpMethods = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);

export function findOpenApiStubs(contract) {
  const stubs = [];

  for (const [apiPath, pathItem] of Object.entries(contract.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!httpMethods.has(method)) continue;
      if (isGeneratedStub(operation)) stubs.push(`${method.toUpperCase()} ${apiPath}`);
    }
  }

  return stubs;
}

function isGeneratedStub(operation) {
  return operation?.["x-generated-stub"] === true || String(operation?.summary ?? "").startsWith("TODO: document ");
}
