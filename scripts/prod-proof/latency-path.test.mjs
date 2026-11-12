import assert from "node:assert/strict";
import test from "node:test";
import { DIAGNOSTICS_SCHEMA, diagnosticsMarkdown, problemOf } from "../../features/scorecard/diagnostics.mjs";
import { icePairOf, iceSummary } from "./latency-ice.mjs";
import { ICE_PATHS, chromiumArgsFor, installIcePath, joinExpected } from "./latency-path.mjs";
import { diagnosticsOf } from "./latency-stages.mjs";

// The servers the relay mints: STUN, TURN over UDP, TCP and TLS, each on more than one port.
const servers = [
  { urls: ["stun:stun.example.test:3478", "stun:stun.example.test:53"] },
  {
    urls: ["turn:turn.example.test:3478?transport=udp", "turn:turn.example.test:53?transport=udp", "turn:turn.example.test:3478?transport=tcp", "turn:turn.example.test:80?transport=tcp", "turns:turn.example.test:5349?transport=tcp", "turns:turn.example.test:443?transport=tcp"],
    username: "u",
    credential: "c",
  },
];

// configurationFor runs the init script against a stand-in RTCPeerConnection and returns what the browser would have been given.
function configurationFor(path, configuration = { iceServers: servers, bundlePolicy: "max-bundle" }) {
  const seen = [];
  globalThis.window = {
    RTCPeerConnection: class {
      constructor(received) {
        seen.push(received);
      }
    },
  };
  installIcePath(path);
  new globalThis.window.RTCPeerConnection(configuration);
  delete globalThis.window;
  return seen[0];
}

const urlsOf = (configuration) => configuration.iceServers.flatMap((server) => server.urls);

test("relay-udp keeps only TURN over UDP and forces relay candidates", () => {
  const configuration = configurationFor("relay-udp");
  assert.deepEqual(urlsOf(configuration), ["turn:turn.example.test:3478?transport=udp", "turn:turn.example.test:53?transport=udp"]);
  assert.equal(configuration.iceTransportPolicy, "relay");
  assert.equal(configuration.bundlePolicy, "max-bundle");
  assert.equal(configuration.iceServers[0].username, "u");
});

test("relay-tcp keeps only TURN over TCP", () => {
  assert.deepEqual(urlsOf(configurationFor("relay-tcp")), ["turn:turn.example.test:3478?transport=tcp", "turn:turn.example.test:80?transport=tcp"]);
});

test("relay-tls keeps TURN over TLS on 443 only when the relay offers it", () => {
  assert.deepEqual(urlsOf(configurationFor("relay-tls")), ["turns:turn.example.test:443?transport=tcp"]);
  const noPort443 = [{ urls: ["turns:turn.example.test:5349?transport=tcp"], username: "u", credential: "c" }];
  assert.deepEqual(urlsOf(configurationFor("relay-tls", { iceServers: noPort443 })), ["turns:turn.example.test:5349?transport=tcp"]);
});

test("blocked-no-relay leaves no ICE server and blocked-relay-tls keeps only TLS", () => {
  assert.deepEqual(configurationFor("blocked-no-relay").iceServers, []);
  assert.equal(configurationFor("blocked-no-relay").iceTransportPolicy, undefined);
  const tls = configurationFor("blocked-relay-tls");
  assert.deepEqual(urlsOf(tls), ["turns:turn.example.test:443?transport=tcp"]);
  assert.equal(tls.iceTransportPolicy, "relay");
});

test("direct leaves the configuration alone and the page without a wrapper", () => {
  const configuration = { iceServers: servers };
  assert.equal(configurationFor("direct", configuration), configuration);
});

test("only the blocked paths change the browser's launch arguments, and only the blocked-no-relay path cannot join", () => {
  for (const path of ICE_PATHS) assert.equal(chromiumArgsFor(path).length, path.startsWith("blocked-") ? 1 : 0, path);
  assert.deepEqual(
    ICE_PATHS.filter((path) => !joinExpected(path)),
    ["blocked-no-relay"],
  );
});

test("the relay protocol of the selected pair reaches the ICE summary and the sidecar validates it", () => {
  const events = [
    { t: 10, k: "ice_connected", peer: 1 },
    { t: 20, k: "ice_pair", peer: 1, d: JSON.stringify({ peer: 1, local: "relay", remote: "host", relayProtocol: "tls", requestsSent: 3, responsesReceived: 3, readAfterMs: 5 }) },
  ];
  const reading = icePairOf(events, 0);
  assert.equal(reading.relay_protocol, "tls");
  const other = icePairOf(
    [
      { t: 10, k: "ice_connected", peer: 1 },
      { t: 20, k: "ice_pair", d: JSON.stringify({ peer: 1, local: "relay", remote: "host", relayProtocol: "carrier-pigeon" }) },
    ],
    0,
  );
  assert.equal(other.relay_protocol, null);
  const ice = iceSummary([reading, reading, other]);
  assert.deepEqual(ice.relay_protocols, { tls: 2 });

  const path = { mode: "relay-tls", joined: true, audio_loss_pct: 0.2, video_loss_pct: 0.3, audio_jitter_ms: 6, video_jitter_ms: 62 };
  const summary = diagnosticsOf([{ trace: { rtt: { sfu_ms: 40, sync_ms: 40 }, stages: {}, ice: reading, path } }]);
  assert.deepEqual({ mode: summary.path.mode, cycles: summary.path.cycles, joined: summary.path.joined }, { mode: "relay-tls", cycles: 1, joined: 1 });
  const file = { schema: DIAGNOSTICS_SCHEMA, plane: "chalk_sfu", cycles: [{ cycle: 1, timestamp: "2026-11-12T00:00:00Z", rtt: { sfu_ms: 40, sync_ms: 40 }, ice: reading, path }], summary };
  assert.equal(problemOf(file), undefined);
  assert.match(diagnosticsMarkdown(summary), /Relay protocol: tls 1/);
  assert.match(diagnosticsMarkdown(summary), /Network path `relay-tls`\*\*: 1 of 1 cycles joined/);
});

test("the sidecar names an unknown path, an unknown relay protocol and a join count above the cycle count", () => {
  const base = { schema: DIAGNOSTICS_SCHEMA, plane: "chalk_sfu", cycles: [], summary: {} };
  assert.match(problemOf({ ...base, cycles: [{ cycle: 1, timestamp: "t", path: { mode: "tunnel", joined: true } }] }), /known path/);
  assert.match(problemOf({ ...base, cycles: [{ cycle: 1, timestamp: "t", ice: { relay_protocol: "quic" } }] }), /relay protocol/);
  assert.match(problemOf({ ...base, summary: { path: { mode: "direct", cycles: 1, joined: 2 } } }), /counts/);
});
