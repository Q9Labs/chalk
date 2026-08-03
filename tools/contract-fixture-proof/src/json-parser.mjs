// @ts-check

/** @typedef {{ column: number; line: number }} SourceLocation */

export class JsonSourceDiagnostic extends Error {
  /**
   * @param {string} message
   * @param {string} path
   * @param {SourceLocation} location
   */
  constructor(message, path, location) {
    super(message);
    this.name = "JsonSourceDiagnostic";
    this.location = location;
    this.path = path;
  }
}

export class LocationPreservingJsonParser {
  /**
   * @param {string} source
   */
  constructor(source) {
    this.index = 0;
    this.lineStarts = [0];
    this.locations = new Map();
    this.source = source;
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === "\n") {
        this.lineStarts.push(index + 1);
      }
    }
  }

  /**
   * @param {string} path
   */
  location(path) {
    let low = 0;
    let high = this.lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.lineStarts[middle] ?? 0) <= this.index) {
        low = middle;
      } else {
        high = middle;
      }
    }
    const location = { column: this.index - (this.lineStarts[low] ?? 0) + 1, line: low + 1 };
    this.locations.set(path, location);
    return location;
  }

  /**
   * @param {string} message
   * @param {string} path
   */
  /**
   * @param {string} message
   * @param {string} path
   * @returns {never}
   */
  fail(message, path) {
    throw new JsonSourceDiagnostic(message, path, this.location(path));
  }

  /**
   * @param {string} message
   * @param {string} path
   * @param {SourceLocation} location
   * @returns {never}
   */
  failAt(message, path, location) {
    throw new JsonSourceDiagnostic(message, path, location);
  }

  whitespace() {
    while (/\s/u.test(this.source[this.index] ?? "")) {
      this.index += 1;
    }
  }

  /**
   * @param {string} expected
   * @param {string} path
   */
  expect(expected, path) {
    if (this.source.slice(this.index, this.index + expected.length) !== expected) {
      this.fail(`expected "${expected}"`, path);
    }
    this.index += expected.length;
  }

  /**
   * @param {string} path
   */
  string(path) {
    const start = this.index;
    this.expect('"', path);
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        try {
          return JSON.parse(this.source.slice(start, this.index));
        } catch {
          this.fail("invalid JSON string", path);
        }
      }
      if (character === "\\") {
        this.index += this.source[this.index + 1] === "u" ? 6 : 2;
        continue;
      }
      if (!character || character < " ") {
        this.fail("invalid JSON string", path);
      }
      this.index += 1;
    }
    this.fail("unterminated JSON string", path);
  }

  /**
   * @param {string} path
   */
  number(path) {
    const match = this.source.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) {
      this.fail("invalid JSON number", path);
    }
    const number = match[0];
    this.index += number.length;
    return Number(number);
  }

  /**
   * @param {string} path
   */
  array(path) {
    /** @type {unknown[]} */
    const values = [];
    this.expect("[", path);
    this.whitespace();
    while (this.source[this.index] !== "]") {
      values.push(this.value(`${path}[${values.length}]`));
      this.whitespace();
      if (this.source[this.index] === "]") {
        break;
      }
      this.expect(",", path);
      this.whitespace();
      if (this.source[this.index] === "]") {
        this.fail("trailing comma", path);
      }
    }
    this.expect("]", path);
    return values;
  }

  /**
   * @param {string} path
   */
  object(path) {
    /** @type {Record<string, unknown>} */
    const object = {};
    /** @type {Map<string, SourceLocation>} */
    const keys = new Map();
    this.expect("{", path);
    this.whitespace();
    while (this.source[this.index] !== "}") {
      const keyLocation = this.location(path);
      const key = this.string(path);
      const first = keys.get(key);
      if (first) {
        this.failAt(`duplicate key "${key}" (first declared at ${first.line}:${first.column})`, path, keyLocation);
      }
      keys.set(key, keyLocation);
      this.whitespace();
      this.expect(":", path);
      this.whitespace();
      object[key] = this.value(`${path}.${key}`);
      this.whitespace();
      if (this.source[this.index] === "}") {
        break;
      }
      this.expect(",", path);
      this.whitespace();
      if (this.source[this.index] === "}") {
        this.fail("trailing comma", path);
      }
    }
    this.expect("}", path);
    return object;
  }

  /**
   * @param {string} path
   */
  value(path) {
    this.whitespace();
    this.location(path);
    const character = this.source[this.index];
    if (character === "{") {
      return this.object(path);
    }
    if (character === "[") {
      return this.array(path);
    }
    if (character === '"') {
      return this.string(path);
    }
    if (character === "-" || /\d/u.test(character ?? "")) {
      return this.number(path);
    }
    if (this.source.startsWith("true", this.index)) {
      this.index += 4;
      return true;
    }
    if (this.source.startsWith("false", this.index)) {
      this.index += 5;
      return false;
    }
    if (this.source.startsWith("null", this.index)) {
      this.index += 4;
      return null;
    }
    this.fail("expected a JSON value", path);
  }

  parse() {
    const value = this.value("contract");
    this.whitespace();
    if (this.index !== this.source.length) {
      this.fail("unexpected trailing content", "contract");
    }
    return { locations: this.locations, value };
  }
}
