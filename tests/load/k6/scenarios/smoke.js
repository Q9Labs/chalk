import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL } from '../config.js';
import { getAuthToken } from '../helpers/auth.js';

export const options = {
  vus: 10,
  duration: '1m',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
    checks: ['rate>0.99'],
  },
};

export default function() {
  // Health check
  const health = http.get(`${BASE_URL}/health`);
  check(health, {
    'health status 200': (r) => r.status === 200,
    'health latency < 100ms': (r) => r.timings.duration < 100,
  });

  // Auth token
  const token = getAuthToken();
  check(token, { 'got auth token': (t) => t && t.length > 0 });

  // Create room
  const roomRes = http.post(`${BASE_URL}/api/v1/rooms`, JSON.stringify({
    name: `smoke-test-${Date.now()}`,
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  });
  check(roomRes, {
    'room created': (r) => r.status === 201,
    'room has id': (r) => JSON.parse(r.body).id,
  });

  sleep(1);
}
