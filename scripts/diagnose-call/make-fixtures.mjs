// node scripts/diagnose-call/make-fixtures.mjs: writes fixtures/cases.json, the rows and the verdict line of each scenario.
import { mkdir, writeFile } from "node:fs/promises";
import { diagnoseRows } from "./index.mjs";
import { normalizeRow } from "./rows.mjs";
import { EPISODE, scenarios } from "./scenarios.mjs";
import { verdictLine } from "./verdict.mjs";

const cases = Object.entries(scenarios).map(([name, build]) => {
  const rows = build();
  return {
    name,
    episode: EPISODE,
    rows,
    verdict: verdictLine(
      diagnoseRows(
        EPISODE,
        rows.map((row) => normalizeRow(row)),
      ).findings,
    ),
  };
});
await mkdir(new URL("./fixtures/", import.meta.url), { recursive: true });
await writeFile(new URL("./fixtures/cases.json", import.meta.url), `${JSON.stringify(cases)}\n`);
console.log(cases.map((entry) => `${entry.name}: ${entry.verdict}`).join("\n"));
