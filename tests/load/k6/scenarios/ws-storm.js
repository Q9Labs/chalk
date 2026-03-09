import { check } from "k6";
import http from "k6/http";
import { Counter, Rate } from "k6/metrics";
import ws from "k6/ws";
import { BASE_URL, WS_URL, ACTIVE_USERS, SHORT_RUN, EXPECT_RATE_LIMIT } from "../config.js";
import { getAuthToken } from "../helpers/auth.js";
import { chatMessage, MessageType, pong, reaction } from "../helpers/websocket.js";

const messagesAttempted = new Counter("messages_attempted");
const messagesRateLimited = new Counter("messages_rate_limited");
const rateLimitRate = new Rate("rate_limit_rate");

const isShort = SHORT_RUN;
const stormVUs = Number(__ENV.WS_STORM_VUS || ACTIVE_USERS);
const stormDuration = isShort ? "1m" : "5m";
const stormDurationMs = isShort ? 60000 : 300000;
const minMessagesAttempted = isShort ? Math.max(500, stormVUs * 10) : Math.max(5000, stormVUs * 50);

const thresholds = {
  messages_attempted: [`count>${minMessagesAttempted}`],
};

if (EXPECT_RATE_LIMIT) {
  thresholds.rate_limit_rate = ["rate>0.4"];
}

export const options = {
  scenarios: {
    message_storm: {
      executor: "constant-vus",
      vus: stormVUs,
      duration: stormDuration,
    },
  },
  thresholds,
};

export function setup() {
  const token = getAuthToken();

  const roomRes = http.post(
    `${BASE_URL}/api/v1/rooms`,
    JSON.stringify({
      name: `ws-storm-${Date.now()}`,
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
  const addRes = http.post(
    `${BASE_URL}/api/v1/rooms/${data.roomId}/participants`,
    JSON.stringify({
      external_user_id: `storm-user-${__VU}`,
      display_name: `Storm User ${__VU}`,
      role: "participant",
    }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${data.token}`,
      },
    },
  );

  if (addRes.status !== 201) {
    if (__ENV.DEBUG_ENV === "true") {
      console.log(`Add participant failed: ${addRes.status} - ${addRes.body}`);
    }
    return;
  }

  const participant = JSON.parse(addRes.body);
  const wsToken = participant.access_token || participant.accessToken || participant.auth_token || participant.authToken;
  if (!wsToken) {
    if (__ENV.DEBUG_ENV === "true") {
      console.log(`Missing websocket token in response: ${addRes.body}`);
    }
    return;
  }

  const wsRes = ws.connect(`${WS_URL}?token=${wsToken}`, {}, (socket) => {
    let isOpen = false;

    socket.on("open", () => {
      isOpen = true;
    });

    socket.on("message", (msg) => {
      const message = JSON.parse(msg);

      if (message.type === MessageType.PING) {
        socket.send(pong());
      }

      if (message.type === MessageType.ERROR) {
        messagesRateLimited.add(1);
        rateLimitRate.add(true);
      }
    });

    socket.setInterval(() => {
      if (!isOpen) return;

      messagesAttempted.add(1);
      rateLimitRate.add(false);

      if (Math.random() > 0.5) {
        socket.send(chatMessage(`Storm message ${Date.now()}`));
      } else {
        socket.send(reaction("👍"));
      }
    }, 50);

    socket.setTimeout(() => {
      socket.close();
    }, stormDurationMs);
  });

  check(wsRes, { "ws connected": (r) => r && r.status === 101 });
}
