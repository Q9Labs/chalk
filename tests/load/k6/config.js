export const BASE_URL = __ENV.BASE_URL || 'https://api-stress.chalk.example.com';
export const WS_URL = __ENV.WS_URL || 'wss://api-stress.chalk.example.com/ws';
const parseNumberEnv = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseBooleanEnv = (value, fallback = false) => {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === 'true';
};

export const ACTIVE_USERS = parseNumberEnv(__ENV.K6_ACTIVE_USERS || __ENV.ACTIVE_USERS, 3000);
export const ROOM_SIZE = parseNumberEnv(__ENV.K6_ROOM_SIZE, 150);
export const SHORT_RUN = parseBooleanEnv(__ENV.K6_SHORT, false);

export const defaultThresholds = {
  http_req_failed: ['rate<0.01'],
  http_req_duration: ['p(95)<2000'],
  ws_connecting: ['p(95)<1000'],
};

export const testTenant = {
  id: __ENV.TENANT_ID || 'stress-test-tenant-uuid',
  apiKey: __ENV.API_KEY || 'ck_test_stress_key',
};

if (__ENV.DEBUG_ENV === 'true') {
  console.log(
    `DEBUG_ENV BASE_URL=${BASE_URL} WS_URL=${WS_URL} TENANT_ID=${testTenant.id} API_KEY=${testTenant.apiKey} ACTIVE_USERS=${ACTIVE_USERS} ROOM_SIZE=${ROOM_SIZE} SHORT=${SHORT_RUN}`,
  );
}
