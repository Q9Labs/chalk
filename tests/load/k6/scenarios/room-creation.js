import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { BASE_URL } from '../config.js';
import { getAuthToken } from '../helpers/auth.js';

const roomsCreated = new Counter('rooms_created');
const roomCreateTime = new Trend('room_create_time');

export const options = {
  scenarios: {
    room_storm: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 200,
      stages: [
        { duration: '30s', target: 50 },   // Ramp to 50 req/s
        { duration: '2m', target: 100 },   // Ramp to 100 req/s
        { duration: '5m', target: 100 },   // Hold at 100 req/s
        { duration: '30s', target: 0 },    // Ramp down
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
