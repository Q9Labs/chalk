import { check } from "k6";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import ws from "k6/ws";
import { BASE_URL, WS_URL } from "../config.js";
import { getAuthToken } from "../helpers/auth.js";
import { MessageType, pong } from "../helpers/websocket.js";

const participantJoins = new Counter("participant_joins");
const joinLatency = new Trend("join_latency");
const wsConnectLatency = new Trend("ws_connect_latency");
const isShort = __ENV.K6_SHORT === "true";
const activeUsers = Number(__ENV.K6_ACTIVE_USERS || 3000);
const fullTarget = Math.max(100, activeUsers);
const halfTarget = Math.max(50, Math.round(fullTarget * 0.5));
const stages = isShort
  ? [
      { duration: "30s", target: 10 },
      { duration: "1m", target: 20 },
      { duration: "1m", target: 20 },
      { duration: "30s", target: 0 },
    ]
  : [
      { duration: "2m", target: halfTarget }, // Ramp to 50% of active users
      { duration: "5m", target: fullTarget }, // Ramp to full load
      { duration: "10m", target: fullTarget }, // Hold
      { duration: "2m", target: 0 }, // Ramp down
    ];
const minParticipantJoins = isShort ? 50 : Math.max(500, Math.round(fullTarget * 0.5));
const sessionDurationMs = isShort ? 20000 : 60000;

export const options = {
  scenarios: {
    churn: {
      executor: "ramping-vus",
      startVUs: 0,
      stages,
    },
  },
  thresholds: {
    join_latency: ["p(95)<2000"],
    ws_connect_latency: ["p(95)<1000"],
    participant_joins: [`count>${minParticipantJoins}`],
  },
};

export function setup() {
  const token = getAuthToken();

  // Create a room for the test
  const roomRes = http.post(
    `${BASE_URL}/api/v1/rooms`,
    JSON.stringify({
      name: `churn-test-${Date.now()}`,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    },
  );

  const room = JSON.parse(roomRes.body);
  return { token, roomId: room.id };
}

export default function (data) {
  const joinStart = Date.now();

  // Add participant to room
  const addRes = http.post(
    `${BASE_URL}/api/v1/rooms/${data.roomId}/participants`,
    JSON.stringify({
      external_user_id: `user-${__VU}-${__ITER}`,
      display_name: `Stress User ${__VU}`,
      role: "participant",
    }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${data.token}`,
      },
    },
  );

  if (!check(addRes, { "participant added": (r) => r.status === 201 })) {
    console.log(`Add participant failed: ${addRes.status} - ${addRes.body}`);
    return;
  }

  const participant = JSON.parse(addRes.body);
  joinLatency.add(Date.now() - joinStart);
  participantJoins.add(1);

  // Connect WebSocket
  const wsStart = Date.now();
  const wsHeaders = {
    "Sec-WebSocket-Protocol": `chalk, token.${participant.access_token}`,
  };
  const wsRes = ws.connect(`${WS_URL}`, { tags: { scenario: "churn" }, headers: wsHeaders }, (socket) => {
    socket.on("open", () => {
      wsConnectLatency.add(Date.now() - wsStart);
    });

    socket.on("message", (msg) => {
      const message = JSON.parse(msg);
      if (message.type === MessageType.PING) {
        socket.send(pong());
      }
    });

    socket.on("error", (e) => {
      console.log(`WebSocket error: ${e}`);
    });

    socket.setTimeout(() => {
      socket.close();
    }, sessionDurationMs);
  });

  check(wsRes, { "ws connected": (r) => r && r.status === 101 });
}

export function teardown(data) {
  // End the room
  http.post(`${BASE_URL}/api/v1/rooms/${data.roomId}/end`, null, {
    headers: { Authorization: `Bearer ${data.token}` },
  });
}
