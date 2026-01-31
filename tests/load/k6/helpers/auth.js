import http from 'k6/http';
import { BASE_URL, testTenant } from '../config.js';

export function getAuthToken() {
  const res = http.post(
    `${BASE_URL}/api/v1/auth/token`,
    JSON.stringify({ api_key: testTenant.apiKey }),
    {
      headers: {
        'Content-Type': 'application/json',
      },
    },
  );
  if (__ENV.DEBUG_ENV === 'true' && res.status !== 200) {
    console.log(`auth token failed: status=${res.status} body=${res.body}`);
  }
  return JSON.parse(res.body).access_token;
}

export function refreshToken(token) {
  const res = http.post(
    `${BASE_URL}/api/v1/auth/refresh`,
    JSON.stringify({ refresh_token: token }),
    {
      headers: { 'Content-Type': 'application/json' },
    },
  );
  return JSON.parse(res.body).access_token;
}
