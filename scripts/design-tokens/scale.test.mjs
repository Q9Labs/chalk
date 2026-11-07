import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const scale = JSON.parse(readFileSync(new URL("./scale.json", import.meta.url), "utf8"));
const css = readFileSync(new URL("../../packages/ui/src/styles/index.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../../sdks/typescript/react-native/src/theme/tokens.ts", import.meta.url), "utf8");

const cssNames = { space: "space", type: "type", corner: "corner" };
const tsNames = { space: "space", type: "fontSizes", corner: "corners" };

function cssSteps(prefix) {
  const found = [...css.matchAll(new RegExp(`^\\s*--${prefix}-([a-z0-9-]+): (\\d+)px;$`, "gmu"))];
  return Object.fromEntries(found.map((match) => [match[1], Number(match[2])]));
}

function tsSteps(name) {
  const body = new RegExp(`export const ${name} = \\{([^}]*)\\} as const;`, "u").exec(tokens)?.[1] ?? "";
  const found = [...body.matchAll(/^\s*"?([a-z0-9-]+)"?: (\d+),$/gmu)];
  return Object.fromEntries(found.map((match) => [match[1], Number(match[2])]));
}

for (const kind of Object.keys(cssNames)) {
  test(`${kind} steps match in scale.json, the web CSS and the React Native tokens`, () => {
    assert.deepEqual(cssSteps(cssNames[kind]), scale[kind].steps);
    assert.deepEqual(tsSteps(tsNames[kind]), scale[kind].steps);
  });

  test(`${kind} snaps land on a step and never shadow one`, () => {
    const names = Object.keys(scale[kind].steps);
    const pixels = new Set(Object.values(scale[kind].steps));
    for (const [from, to] of Object.entries(scale[kind].snaps)) {
      assert.ok(names.includes(to), `${kind} snap ${from} -> ${to} is not a step`);
      assert.ok(!pixels.has(Number(from)), `${kind} ${from} is a step, so it cannot snap`);
    }
  });
}
