export function parameterSchema(parameters = [], location) {
  const matching = parameters.filter((parameter) => parameter.in === location);
  if (matching.length === 0) {
    return undefined;
  }

  const required = matching
    .filter((parameter) => parameter.required)
    .map((parameter) => parameter.name)
    .sort();
  const properties = Object.fromEntries(
    matching
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((parameter) => [
        parameter.name,
        {
          ...(parameter.schema ?? {}),
          "x-chalk-url-parameter": true,
        },
      ]),
  );

  return {
    type: "object",
    required,
    properties,
    additionalProperties: false,
  };
}

export function operationResponseSchema(document, operation, operationName) {
  const responseBody = successResponseSchema(operation.responses);
  if (!responseBody || isComponentAlias(responseBody, `${operationName}Response`, document)) {
    return undefined;
  }
  return responseBody;
}

function successResponseSchema(responses = {}) {
  const statuses = Object.keys(responses).sort();
  const status = statuses.find((value) => /^2\d\d$/.test(value)) ?? statuses.find((value) => /^3\d\d$/.test(value));

  if (!status) {
    return undefined;
  }

  return responses[status]?.content?.["application/json"]?.schema ?? responses[status]?.content?.["text/plain"]?.schema;
}

// A response that is only a $ref to a component of the same name is already emitted with the components.
function isComponentAlias(schema, name, document) {
  const target = typeof schema.$ref === "string" ? schema.$ref.split("/").at(-1) : undefined;
  return target === name && Boolean(document.components?.schemas?.[target]);
}
