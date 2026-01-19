import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { BASE_URL, WS_URL } from '../config.js';
import { getAuthToken } from '../helpers/auth.js';
import { pong, MessageType } from '../helpers/websocket.js';

const participantJoins = new Counter('participant_joins');
const joinLatency = new Trend('join_latency');
const wsConnectLatency = new Trend('ws_connect_latency');

export const options = {
  scenarios: {
    churn: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 50 },    // Ramp to 50 concurrent
        { duration: '5m', target: 100 },   // Ramp to 100 concurrent
        { duration: '10m', target: 100 },  // Hold
        { duration: '1m', target: 0 },     // Ramp down
      ],
    },
  },
  thresholds: {
    join_latency: ['p(95)<2000'],
    ws_connect_latency: ['p(95)<1000'],
    participant_joins: ['count>500'],
  },
};

export function setup() {
  const token = getAuthToken();

  // Create a room for the test
  const roomRes = http.post(`${BASE_URL}/api/v1/rooms`, JSON.stringify({
    name: `churn-test-${Date.now()}`,
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  });

  const room = JSON.parse(roomRes.body);
  return { token, roomId: room.id };
}

export default function(data) {
  const joinStart = Date.now();

  // Add participant to room
  const addRes = http.post(
    `${BASE_URL}/api/v1/rooms/${data.roomId}/participants`,
    JSON.stringify({
      external_user_id: `user-${__VU}-${__ITER}`,
      display_name: `Stress User ${__VU}`,
      role: 'participant',
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${data.token}`,
      },
    }
  );

  if (!check(addRes, { 'participant added': (r) => r.status === 201 })) {
    console.log(`Add participant failed: ${addRes.status} - ${addRes.body}`);
    return;
  }

  const participant = JSON.parse(addRes.body);
  joinLatency.add(Date.now() - joinStart);
  participantJoins.add(1);

  // Connect WebSocket
  const wsStart = Date.now();
  const wsRes = ws.connect(
    `${WS_URL}?token=${participant.token}`,
    { tags: { scenario: 'churn' } },
    function(socket) {
      socket.on('open', () => {
        wsConnectLatency.add(Date.now() - wsStart);
      });

      socket.on('message', (msg) => {
        const message = JSON.parse(msg);
        if (message.type === MessageType.PING) {
          socket.send(pong());
        }
      });

      socket.on('error', (e) => {
        console.log(`WebSocket error: ${e}`);
      });

      // Stay connected for 30-60 seconds
      sleep(30 + Math.random() * 30);
      socket.close();
    }
  );

  check(wsRes, { 'ws connected': (r) => r && r.status === 101 });
}

export function teardown(data) {
  // End the room
  http.post(`${BASE_URL}/api/v1/rooms/${data.roomId}/end`, null, {
    headers: { 'Authorization': `Bearer ${data.token}` },
  });
}
