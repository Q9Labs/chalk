import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const mobileRequire = createRequire(new URL("../../apps/mobile/package.json", import.meta.url));
const nativeRequire = createRequire(mobileRequire.resolve("react-native/package.json"));
const expoRequire = createRequire(mobileRequire.resolve("expo/package.json"));
const cliRequire = createRequire(expoRequire.resolve("@expo/cli/package.json"));
const openapiRequire = createRequire(require.resolve("openapi-typescript/package.json"));
const redoclyRequire = createRequire(openapiRequire.resolve("@redocly/openapi-core/package.json"));

test("React Native's replacement glob preserves codegen discovery and podspec matching", async () => {
  const glob = nativeRequire("glob");
  const directory = await mkdtemp(join(tmpdir(), "chalk-tooling-glob-"));
  try {
    await mkdir(join(directory, "nested"));
    for (const file of ["NativeCamera.ts", "NativeCamera.fb.tsx", "nested/NativeAudio.js", "nested/ignored.ts", ".hidden.ts"]) {
      await writeFile(join(directory, file), "");
    }
    const options = { cwd: directory, ignore: ["**/ignored.*"], nodir: true };
    const expected = ["NativeCamera.fb.tsx", "NativeCamera.ts", "nested/NativeAudio.js"];
    assert.deepEqual(glob.sync("**/*{,.fb}.{js,ts,tsx}", options).sort(), expected);
    const codegenRequire = createRequire(nativeRequire.resolve("@react-native/codegen/package.json"));
    assert.deepEqual(codegenRequire("glob").sync("**/*{,.fb}.{js,ts,tsx}", options).sort(), expected);
    await writeFile(join(directory, "Chalk.podspec"), "");
    assert.deepEqual(glob.sync("*.podspec", { cwd: directory }), ["Chalk.podspec"]);
    assert.deepEqual(glob.sync("missing*.ts", { cwd: directory }), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("React Native's Edge launcher replacement supports its CommonJS discovery API", () => {
  const middlewareRequire = createRequire(nativeRequire.resolve("@react-native/dev-middleware/package.json"));
  const { Launcher } = middlewareRequire("chromium-edge-launcher");
  assert.equal(typeof Launcher.getFirstInstallation, "function");
  assert.equal(typeof Launcher.getInstallations, "function");
});

test("Redocly matches remote schema headers through the new named minimatch export", async () => {
  const { readFileFromUrl } = redoclyRequire("./lib/utils.js");
  let actualHeaders;
  const result = await readFileFromUrl("https://schemas.example.test/api/openapi.json", {
    headers: [
      { matches: "schemas.example.test/**", name: "x-schema", value: "matched" },
      { matches: "https://other.example.test/**", name: "x-other", value: "excluded" },
    ],
    customFetch: async (_url, options) => {
      actualHeaders = options.headers;
      return new Response('{"openapi":"3.0.0"}', { headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(actualHeaders, { "x-schema": "matched" });
  assert.equal(result.body, '{"openapi":"3.0.0"}');
});

test("Expo's glob retains async and sync filesystem discovery", async () => {
  const { glob, globSync } = cliRequire("glob");
  const options = { cwd: new URL("../../apps/mobile", import.meta.url).pathname, nodir: true };
  assert.deepEqual(globSync("package.{json,yaml}", options), ["package.json"]);
  assert.deepEqual(await glob("package.{json,yaml}", options), ["package.json"]);
});

test("Istanbul's replacement test-exclude preserves instrumentation filters and discovery", async () => {
  const codegenRequire = createRequire(nativeRequire.resolve("@react-native/codegen/package.json"));
  const babelRequire = createRequire(codegenRequire.resolve("@babel/core/package.json"));
  const istanbulRequire = createRequire(babelRequire.resolve("babel-plugin-istanbul/package.json"));
  const TestExclude = istanbulRequire("test-exclude");
  const directory = await mkdtemp(join(tmpdir(), "chalk-tooling-coverage-"));
  try {
    await writeFile(join(directory, "source.js"), "export const value = 1;");
    await writeFile(join(directory, "source.test.js"), "");
    const filter = new TestExclude({ cwd: directory });
    assert.equal(filter.shouldInstrument(join(directory, "source.js")), true);
    assert.equal(filter.shouldInstrument(join(directory, "source.test.js")), false);
    assert.deepEqual(filter.globSync(), ["source.js"]);
    assert.deepEqual(await filter.glob(), ["source.js"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
