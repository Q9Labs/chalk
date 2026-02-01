export const BASE_URL =
	__ENV.BASE_URL || "https://api-stress.chalk.example.com";
export const WS_URL = __ENV.WS_URL || "wss://api-stress.chalk.example.com/ws";

export const defaultThresholds = {
	http_req_failed: ["rate<0.01"],
	http_req_duration: ["p(95)<2000"],
	ws_connecting: ["p(95)<1000"],
};

export const testTenant = {
	id: __ENV.TENANT_ID || "stress-test-tenant-uuid",
	apiKey: __ENV.API_KEY || "ck_test_stress_key",
};
