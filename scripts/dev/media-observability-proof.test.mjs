import { describe, expect, it } from "vitest";

import { createMediaObservabilityProof, proveMediaObservability } from "./media-observability-proof.mjs";

const journeyID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const traceID = "0123456789abcdef0123456789abcdef";

describe("media observability proof", () => {
  it("proves the captured journey in the Grafana PostgreSQL datasource, Tempo, and Loki", async () => {
    const calls = [];
    const fetcher = createFetcher({ calls, ledger: ledgerResponse(journeyID, traceID), tempo: journeyID, loki: journeyID });
    const proof = createMediaObservabilityProof({ fetcher, timeoutMs: 100, pollIntervalMs: 1 });

    const result = await proof({ runtime: { runtimeID: "runtime-local" }, journeyIDs: [journeyID] });

    expect(result).toMatchObject({
      status: "succeeded",
      runtimeID: "runtime-local",
      journeyID,
      ledger: { eventCount: 1, traceIDs: [traceID], datasource: { uid: "chalk-journey-ledger", type: "grafana-postgresql-datasource", database: "chalk_dev" } },
      tempo: { traceID, matched: true },
      loki: { query: "journey_id", matched: true },
    });
    expect(calls.some(({ init }) => String(init?.headers?.authorization ?? "").startsWith("Bearer"))).toBe(false);
    expect(calls.every(({ url }) => ["127.0.0.1"].includes(url.hostname))).toBe(true);
    expect(calls.find(({ url }) => url.pathname === "/api/ds/query")?.init.body).toContain(`${journeyID}'::uuid`);
  });

  it("bounded-waits for ledger ingestion before querying Tempo and Loki", async () => {
    let clock = 0;
    let ledgerQueries = 0;
    const fetcher = createFetcher({
      ledger: () => {
        ledgerQueries += 1;
        return ledgerQueries === 1 ? ledgerResponse() : ledgerResponse(journeyID, traceID);
      },
      tempo: journeyID,
      loki: journeyID,
    });
    const proof = createMediaObservabilityProof({
      fetcher,
      timeoutMs: 100,
      pollIntervalMs: 10,
      now: () => clock,
      sleep: async () => {
        clock += 10;
      },
    });

    const result = await proof({ runtime: { runtimeID: "runtime-local" }, journeyIDs: [journeyID] });

    expect(result.journeyID).toBe(journeyID);
    expect(ledgerQueries).toBe(2);
    expect(result.attempts).toBe(2);
  });

  it("rejects non-local observability resources before making a request", () => {
    expect(() => createMediaObservabilityProof({ grafanaURL: "https://grafana.example.test" })).toThrow("Grafana URL must point to localhost");
  });

  it("rejects a datasource pointed at a different local database", async () => {
    const proof = createMediaObservabilityProof({ fetcher: createFetcher({ database: "chalk_observability", ledger: ledgerResponse(journeyID, traceID), tempo: journeyID, loki: journeyID }), timeoutMs: 10, pollIntervalMs: 1 });
    await expect(proof({ journeyIDs: [journeyID] })).rejects.toMatchObject({ code: "observability_proof_timeout" });
  });

  it("requires a valid captured journey ID", async () => {
    await expect(
      proveMediaObservability({
        journeyIDs: ["not-a-journey-id"],
        fetcher: async () => {
          throw new Error("should not fetch");
        },
      }),
    ).rejects.toMatchObject({ code: "observability_missing_journey_id" });
  });
});

function createFetcher({ calls = [], database = "chalk_dev", ledger = ledgerResponse(), tempo = "", loki = "", datasourceType = "grafana-postgresql-datasource" } = {}) {
  return async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname.startsWith("/api/datasources/uid/")) return response({ uid: "chalk-journey-ledger", type: datasourceType, jsonData: { database }, url: "host.docker.internal:5432" });
    if (url.pathname === "/api/ds/query") return response(typeof ledger === "function" ? ledger() : ledger);
    if (url.pathname.startsWith("/api/traces/")) return responseText(tempo);
    if (url.pathname === "/api/search") return responseText(tempo);
    if (url.pathname === "/loki/api/v1/query_range") return responseText(loki);
    return response({}, 404);
  };
}

function ledgerResponse(id, trace) {
  if (!id) return { results: { A: { frames: [] } } };
  return {
    results: {
      A: {
        frames: [
          {
            schema: { fields: [{ name: "journey_id" }, { name: "name" }, { name: "trace_id" }] },
            data: { values: [[id], ["journey.started"], [trace]] },
          },
        ],
      },
    },
  };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function responseText(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body || "{}"), text: async () => body };
}
