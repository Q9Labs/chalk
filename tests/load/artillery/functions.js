const http = require("http");
const https = require("https");

const API_BASE_URL = process.env.API_BASE_URL;
const TENANT_API_KEY = process.env.TENANT_API_KEY;
const ROOM_ID = process.env.ROOM_ID;

let cachedTenantToken = null;
let cachedRoomId = null;

function requestJson(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        method,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = data ? JSON.parse(data) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          } catch (err) {
            reject(err);
          }
        });
      },
    );

    req.on("error", reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function getTenantToken() {
  if (cachedTenantToken) return cachedTenantToken;
  if (!API_BASE_URL || !TENANT_API_KEY) {
    throw new Error("API_BASE_URL and TENANT_API_KEY are required");
  }
  const res = await requestJson("POST", `${API_BASE_URL}/api/v1/auth/token`, {
    api_key: TENANT_API_KEY,
  });
  cachedTenantToken = res.access_token;
  return cachedTenantToken;
}

async function getRoomId(tenantToken) {
  if (ROOM_ID) return ROOM_ID;
  if (cachedRoomId) return cachedRoomId;
  const room = await requestJson("POST", `${API_BASE_URL}/api/v1/rooms`, { name: `artillery-room-${Date.now()}` }, { Authorization: `Bearer ${tenantToken}` });
  cachedRoomId = room.id;
  return cachedRoomId;
}

async function setupParticipant(context, _events, done) {
  try {
    const tenantToken = await getTenantToken();
    const roomId = await getRoomId(tenantToken);
    const participant = await requestJson(
      "POST",
      `${API_BASE_URL}/api/v1/rooms/${roomId}/participants`,
      {
        external_user_id: `artillery-${Date.now()}-${Math.random()}`,
        display_name: `Artillery User`,
        role: "participant",
      },
      { Authorization: `Bearer ${tenantToken}` },
    );
    context.vars.token = participant.access_token;
    context.vars.roomId = roomId;
    return done();
  } catch (err) {
    return done(err);
  }
}

module.exports = {
  setupParticipant,
};
