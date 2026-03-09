import { check, sleep } from "k6";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import { BASE_URL } from "../config.js";
import { getAuthToken } from "../helpers/auth.js";

const roomsCreated = new Counter("rooms_created");
const roomCreateTime = new Trend("room_create_time");
const roomsEnded = new Counter("rooms_ended");
const roomEndTime = new Trend("room_end_time");

const isShort = __ENV.K6_SHORT === "true";
const activeUsers = Number(__ENV.K6_ACTIVE_USERS || 3000);
const rateMultiplier = Number(__ENV.ROOM_CREATE_RATE_MULT || 1);
const startRate = Math.max(1, Math.round(activeUsers * 0.01 * rateMultiplier));
const rampRate = Math.max(1, Math.round(activeUsers * 0.05 * rateMultiplier));
const peakRate = Math.max(rampRate, Math.round(activeUsers * 0.1 * rateMultiplier));
const preAllocatedVUs = Math.max(50, Math.round(activeUsers * 0.1 * rateMultiplier));
const maxVUs = Math.max(preAllocatedVUs * 2, Math.round(activeUsers * 0.2 * rateMultiplier));
const minRoomsCreated = isShort ? 100 : 500;
const stages = isShort
  ? [
      { duration: "15s", target: rampRate },
      { duration: "30s", target: peakRate },
      { duration: "1m", target: peakRate },
      { duration: "15s", target: 0 },
    ]
  : [
      { duration: "30s", target: rampRate }, // Ramp up
      { duration: "2m", target: peakRate }, // Ramp to peak
      { duration: "5m", target: peakRate }, // Hold at peak
      { duration: "30s", target: 0 }, // Ramp down
    ];

let loggedErrors = 0;

export const options = {
  scenarios: {
    room_storm: {
      executor: "ramping-arrival-rate",
      startRate,
      timeUnit: "1s",
      preAllocatedVUs,
      maxVUs,
      stages,
    },
  },
  setupTimeout: "5m",
  thresholds: {
    http_req_failed: ["rate<0.1"],
    room_create_time: ["p(95)<1000"],
    rooms_created: [`count>${minRoomsCreated}`],
  },
};

export function setup() {
  const token = getAuthToken();
  if (__ENV.ROOM_CREATE_CLEANUP === "true") {
    const headers = { Authorization: `Bearer ${token}` };

    // Cleanup any active rooms to avoid tenant limit failures
    for (let i = 0; i < 50; i += 1) {
      const listRes = http.get(`${BASE_URL}/api/v1/rooms?limit=100&offset=0`, {
        headers,
      });
      if (listRes.status !== 200) {
        break;
      }

      const listBody = listRes.json();
      const rooms = listBody && listBody.rooms ? listBody.rooms : [];
      if (rooms.length === 0) {
        break;
      }

      for (const room of rooms) {
        if (room && room.id) {
          http.post(`${BASE_URL}/api/v1/rooms/${room.id}/end`, null, {
            headers,
          });
        }
      }
    }
  }

  return { token };
}

export default function (data) {
  const start = Date.now();

  const res = http.post(
    `${BASE_URL}/api/v1/rooms`,
    JSON.stringify({
      name: `stress-room-${__VU}-${__ITER}-${Date.now()}`,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${data.token}`,
      },
    },
  );

  roomCreateTime.add(Date.now() - start);

  if (check(res, { "room created": (r) => r.status === 201 })) {
    roomsCreated.add(1);
    const body = res.json();
    if (body && body.id) {
      const endStart = Date.now();
      const endRes = http.post(`${BASE_URL}/api/v1/rooms/${body.id}/end`, null, {
        headers: {
          Authorization: `Bearer ${data.token}`,
        },
      });
      roomEndTime.add(Date.now() - endStart);
      if (check(endRes, { "room ended": (r) => r.status === 200 })) {
        roomsEnded.add(1);
      } else if (loggedErrors < 5) {
        loggedErrors += 1;
        console.log(`Room end failed: ${endRes.status} - ${endRes.body}`);
      }
    }
  } else {
    if (loggedErrors < 5) {
      loggedErrors += 1;
      console.log(`Room creation failed: ${res.status} - ${res.body}`);
    }
  }
}
