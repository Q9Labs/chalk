// @ts-check

// Deterministic layout for generated Elixir without requiring `mix format` to run codegen.

const maxLineWidth = 98;

export class ElixirAtom {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
  }
}

/**
 * @param {string} name
 * @param {any} value
 * @returns {string[]}
 */
export function renderAttribute(name, value) {
  const head = `  @${name} `;
  return [`${head}${renderElixirValue(value, 2, head.length)}`];
}

export function renderElixirValue(value, indent = 0, column = Number.POSITIVE_INFINITY) {
  const compact = renderCompactElixirValue(value);
  if (column + compact.length <= maxLineWidth || typeof value !== "object" || value === null || value instanceof ElixirAtom) {
    return compact;
  }
  const inner = " ".repeat(indent + 2);
  const closing = " ".repeat(indent);
  if (Array.isArray(value)) {
    const items = value.map((item) => `${inner}${renderElixirValue(item, indent + 2, indent + 2)}`);
    return `[\n${items.join(",\n")}\n${closing}]`;
  }
  const entries = mapEntries(value).map(([key, child], index, pairs) => {
    const head = `${inner}${renderCompactElixirValue(key)} => `;
    const rendered = renderElixirValue(child, indent + 2, head.length);
    const commaWidth = index === pairs.length - 1 ? 0 : 1;
    if (typeof child === "string" && head.length + rendered.length + commaWidth > maxLineWidth) {
      return `${head.trimEnd()}\n${inner}  ${rendered}`;
    }
    return `${head}${rendered}`;
  });
  return `%{\n${entries.join(",\n")}\n${closing}}`;
}

/**
 * @param {any} value
 * @returns {string}
 */
function renderCompactElixirValue(value) {
  if (value === null) {
    return "nil";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    const rendered = String(value);
    if (Number.isInteger(value) && Math.abs(value) >= 10_000) {
      const sign = rendered.startsWith("-") ? "-" : "";
      const digits = sign ? rendered.slice(1) : rendered;
      return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/gu, "_");
    }
    return rendered;
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(renderCompactElixirValue).join(", ")}]`;
  }
  if (value instanceof ElixirAtom) {
    return `:${value.name}`;
  }
  return `%{${mapEntries(value)
    .map(([key, child]) => `${renderCompactElixirValue(key)} => ${renderCompactElixirValue(child)}`)
    .join(", ")}}`;
}

/**
 * @param {Map<any, any> | Record<string, any>} value
 */
function mapEntries(value) {
  return value instanceof Map ? [...value] : Object.entries(value);
}

/**
 * Wraps lines longer than the maximum width after top-level-safe break points: a comma
 * or a trailing `and`/`or`, outside strings. Each break continues the expression, so
 * the code means the same. Sigil lines are left alone.
 * @param {string} source
 */
export function wrapElixirSource(source) {
  return source.split("\n").map(wrapLine).join("\n");
}

/** @param {string} line */
function wrapLine(line) {
  if (line.length <= maxLineWidth || line.includes("~r/") || line.trimStart().startsWith("#")) {
    return line;
  }
  const indent = line.length - line.trimStart().length;
  const continuation = " ".repeat(indent + 4);
  const lines = [];
  let current = "";
  for (const piece of splitAtBreakPoints(line)) {
    if (current !== "" && current.length + piece.length > maxLineWidth) {
      lines.push(current.trimEnd());
      current = continuation;
    }
    current += piece;
  }
  lines.push(current.trimEnd());
  return lines.join("\n");
}

/** @param {string} line */
function splitAtBreakPoints(line) {
  const pieces = [];
  let start = 0;
  let inString = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (inString) {
      if (character === "\\") index += 1;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "," && line[index + 1] === " ") {
      pieces.push(line.slice(start, index + 2));
      start = index + 2;
      index += 1;
    } else if (character === " " && (line.startsWith(" and ", index) || line.startsWith(" or ", index))) {
      const end = index + (line.startsWith(" and ", index) ? 5 : 4);
      pieces.push(line.slice(start, end));
      start = end;
      index = end - 1;
    }
  }
  pieces.push(line.slice(start));
  return pieces;
}
