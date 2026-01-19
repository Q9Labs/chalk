import http from 'k6/http';
import { BASE_URL, testTenant } from '../config.js';

export function getAuthToken() {
  const res = http.post(`${BASE_URL}/api/v1/auth/token`, JSON.stringify({
    tenant_id: testTenant.id,
  }), {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': testTenant.apiKey,
    },
  });
  return JSON.parse(res.body).access_token;
}

export function refreshToken(token) {
  const res = http.post(`${BASE_URL}/api/v1/auth/refresh`, null, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return JSON.parse(res.body).access_token;
}
