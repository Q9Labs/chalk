import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOperatorConfig } from "../src/config.mjs";

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryCredentialFile(contents, mode) {
  const directory = await mkdtemp(join(tmpdir(), "chalk-episode-diagnostics-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "operator.json");
  await writeFile(path, JSON.stringify(contents), { mode });
  await chmod(path, mode);
  return path;
}

describe("operator configuration", () => {
  it("reads the diagnostics-only private JSON credential file", async () => {
    const path = await temporaryCredentialFile({ token: "fixture-operator", environment: "localhost", apiOrigin: "http://127.0.0.1:8181" }, 0o600);
    const config = await resolveOperatorConfig({ credentialFile: path });
    expect(config.environment).toBe("localhost");
    expect(config.baseUrl).toBe("http://127.0.0.1:8181");
    expect(config.credential).toBe("fixture-operator");
  });

  it("prefers the diagnostics-specific environment token", async () => {
    const config = await resolveOperatorConfig({ environment: "staging", baseUrl: "https://diagnostics.invalid", env: { CHALK_EPISODE_DIAGNOSTICS_OPERATOR_TOKEN: "fixture-operator" } });
    expect(config.credential).toBe("fixture-operator");
    expect(config.environment).toBe("staging");
  });

  it("does not accept a broad-readable credential file", async () => {
    const path = await temporaryCredentialFile({ token: "fixture-operator" }, 0o644);
    await expect(resolveOperatorConfig({ credentialFile: path })).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("refuses to send a localhost operator credential to a remote origin", async () => {
    await expect(resolveOperatorConfig({ baseUrl: "https://example.com", environment: "localhost", credential: "fixture-operator" })).rejects.toMatchObject({ code: "invalid_config" });
  });
});
