import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { BASE_URL, ACTIVE_USERS, SHORT_RUN } from '../config.js';
import { getAuthToken } from '../helpers/auth.js';

const roomsCreated = new Counter('rooms_created');
const roomCreateTime = new Trend('room_create_time');

export const options = {
  scenarios: {
    room_storm: {
      executor: 'ramping-arrival-rate',
      startRate: Math.max(5, Math.round(ACTIVE_USERS / 300)),
      timeUnit: '1s',
      preAllocatedVUs: Math.max(50, Math.round(ACTIVE_USERS / 20)),
      maxVUs: Math.max(100, Math.round(ACTIVE_USERS / 10)),
      stages: [
        { duration: SHORT_RUN ? '20s' : '30s', target: Math.max(10, Math.round(ACTIVE_USERS / 60)) },
        { duration: SHORT_RUN ? '40s' : '2m', target: Math.max(20, Math.round(ACTIVE_USERS / 30)) },
        { duration: SHORT_RUN ? '1m' : '5m', target: Math.max(20, Math.round(ACTIVE_USERS / 30)) },
        { duration: SHORT_RUN ? '20s' : '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    room_create_time: ['p(95)<1000'],
    rooms_created: ['count>1000'],
  },
};

export function setup() {
  return { token: getAuthToken() };
}

export default function(data) {
  const start = Date.now();

  const res = http.post(`${BASE_URL}/api/v1/rooms`, JSON.stringify({
    name: `stress-room-${__VU}-${__ITER}-${Date.now()}`,
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${data.token}`,
    },
  });

  roomCreateTime.add(Date.now() - start);

  if (check(res, { 'room created': (r) => r.status === 201 })) {
    roomsCreated.add(1);
  } else {
    // Log failures for tenant limit hits
    console.log(`Room creation failed: ${res.status} - ${res.body}`);
  }
}
