import assert from "node:assert/strict";
import test from "node:test";
import { govulncheckFindings, newFindings, osvFindings } from "./new-vulnerabilities.mjs";

const osvReport = (version) => ({
  results: [{ source: { path: "/repo/apps/api/go.mod" }, packages: [{ package: { name: "golang.org/x/text", version, ecosystem: "Go" }, vulnerabilities: [{ id: "GO-2021-0113" }] }] }],
});

// The shape of `govulncheck -format json`: pretty-printed objects, one after another.
const govulncheckStream = (version, frame) =>
  [{ config: { scanner_name: "govulncheck", scan_level: "symbol" } }, { finding: { osv: "GO-2021-0113", trace: [{ module: "golang.org/x/text", version }] } }, { finding: { osv: "GO-2021-0113", trace: [{ module: "golang.org/x/text", version, package: "golang.org/x/text/language", ...frame }] } }]
    .map((object) => JSON.stringify(object, null, 2))
    .join("\n");

test("a pull request fails only for the package versions it changes", () => {
  assert.deepEqual(newFindings(osvFindings(osvReport("0.3.5")), osvFindings(osvReport("0.3.5"))), []);
  assert.deepEqual(newFindings(osvFindings(osvReport("0.3.6")), osvFindings(osvReport("0.3.5"))), ["GO-2021-0113 Go golang.org/x/text@0.3.6"]);
  assert.deepEqual(newFindings(osvFindings(osvReport("0.3.5")), osvFindings({ results: [] })), ["GO-2021-0113 Go golang.org/x/text@0.3.5"]);
});

test("govulncheck counts only findings in called functions, as its text mode does", () => {
  assert.deepEqual([...govulncheckFindings(govulncheckStream("v0.3.5", {}))], []);
  const called = govulncheckFindings(govulncheckStream("v0.3.5", { function: "ParseAcceptLanguage" }));
  assert.deepEqual([...called], ["GO-2021-0113 golang.org/x/text@v0.3.5"]);
  assert.deepEqual(newFindings(called, called), []);
  assert.deepEqual(newFindings(called, govulncheckFindings(govulncheckStream("v0.3.5", {}))), ["GO-2021-0113 golang.org/x/text@v0.3.5"]);
});
