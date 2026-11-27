// @ts-check

import { renderElixirValue } from "./elixir-layout.mjs";

/**
 * @param {string} value
 */
export function snakeCase(value) {
  return value.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

/** @param {Record<string, any>[]} commands */
export function renderElixirCommandPayloads(commands) {
  return commands.flatMap((command) => {
    const fields = Object.entries(command.payload).map(([name, field]) => [snakeCase(name), field]);
    const pattern = fields.map(([name]) => `${JSON.stringify(name)} => ${name}`).join(", ");
    const keys = fields.map(([name]) => name);
    const checks = fields.map(([name, field]) => renderElixirFieldCheck(field, name)).join(" and ");
    return [`  defp valid_command_payload?(${JSON.stringify(command.name)}, %{${pattern}} = payload) do`, `    exact_keys?(payload, ${renderElixirValue(keys)}) and ${checks}`, "  end", ""];
  });
}

/** @param {Record<string, any>[]} operations */
export function renderElixirOperationPayloads(operations) {
  return operations.flatMap((operation) => {
    const fields = Object.entries(operation.payload).map(([name, field]) => [snakeCase(name), field]);
    const pattern = fields.map(([name]) => `${JSON.stringify(name)} => ${name}`).join(", ");
    const checks = fields.length === 0 ? "true" : fields.map(([name, field]) => renderElixirFieldCheck(field, name)).join(" and ");
    return [`  defp valid_operation_payload?(${JSON.stringify(operation.name)}, %{${pattern}} = payload) do`, `    exact_keys?(payload, ${renderElixirValue(fields.map(([name]) => name))}) and ${checks}`, "  end", ""];
  });
}

/** @param {Record<string, any>[]} events */
export function renderElixirEventPayloads(events) {
  return events.flatMap((event) => {
    const fields = Object.entries(event.payload).map(([name, field]) => [snakeCase(name), field]);
    const required = fields.filter(([, field]) => !field.optional);
    const optional = fields.filter(([, field]) => field.optional);
    const pattern = required.map(([name]) => `${JSON.stringify(name)} => ${name}`).join(", ");
    const requiredKeys = required.map(([name]) => name);
    const optionalKeys = optional.map(([name]) => name);
    const keysExpression = optionalKeys.length === 0 ? renderElixirValue(requiredKeys) : `${renderElixirValue(requiredKeys)} ++ Enum.filter(${renderElixirValue(optionalKeys)}, &Map.has_key?(payload, &1))`;
    const requiredChecks = required.map(([name, field]) => renderElixirFieldCheck(field, name));
    const optionalChecks = optional.map(([name, field]) => `(not Map.has_key?(payload, ${JSON.stringify(name)}) or ${renderElixirFieldCheck(field, `payload[${JSON.stringify(name)}]`)})`);
    const checks = [...requiredChecks, ...optionalChecks].join(" and ");
    return [`  defp valid_event_payload?(${JSON.stringify(event.name)}, %{${pattern}} = payload) do`, `    exact_keys?(payload, ${keysExpression}) and ${checks}`, "  end", ""];
  });
}

/** @param {Record<string, any>} field @param {string} variable */
function renderElixirFieldCheck(field, variable) {
  if (field === "uuid") return `valid_uuid?(${variable})`;
  if (Array.isArray(field)) return `${variable} in ${renderElixirValue(field)}`;
  if (field.kind === "boolean") return `is_boolean(${variable})`;
  if (field.kind === "integer") return field.minimum > 0 ? `valid_positive_integer?(${variable})` : `valid_non_negative_integer?(${variable})`;
  if (field.kind === "array") {
    const values = field.of === "role" ? `Enum.all?(${variable}, &bounded_string?(&1, 1, 64))` : `Enum.all?(${variable}, &(&1 in @capabilities))`;
    return `is_list(${variable}) and length(${variable}) <= ${field.maxItems} and ${values}`;
  }
  if (field.format === "uuid") return `valid_uuid?(${variable})`;
  if (field.enum) return `${variable} in ${renderElixirValue(field.enum)}`;
  const minimum = field.minBytes ?? 0;
  const trimmed = field.trimmedNonEmpty ? ` and ${variable} != "" and ${variable} == String.trim(${variable})` : "";
  const check = `bounded_string?(${variable}, ${minimum}, ${field.maxBytes})${trimmed}`;
  return field.nullable ? `(is_nil(${variable}) or ${check})` : check;
}
