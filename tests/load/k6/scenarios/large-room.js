import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Trend, Gauge } from 'k6/metrics';
import { BASE_URL, WS_URL, ROOM_SIZE, SHORT_RUN } from '../config.js';
import { getAuthToken } from '../helpers/auth.js';
import { chatMessage, pong, MessageType } from '../helpers/websocket.js';

const broadcastLatency = new Trend('broadcast_latency');
const participantCount = new Gauge('participant_count');
const messagesReceived = new Counter('messages_received');

export const options = {
  scenarios: {
    large_room: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: SHORT_RUN ? '30s' : '2m', target: Math.max(25, Math.round(ROOM_SIZE * 0.33)) },
        { duration: SHORT_RUN ? '1m' : '3m', target: Math.max(50, Math.round(ROOM_SIZE * 0.66)) },
        { duration: SHORT_RUN ? '1m' : '5m', target: Math.max(75, ROOM_SIZE) },
        { duration: SHORT_RUN ? '2m' : '10m', target: Math.max(75, ROOM_SIZE) },
        { duration: SHORT_RUN ? '30s' : '2m', target: 0 },
      ],
    },
  },
  thresholds: {
    broadcast_latency: ['p(95)<500', 'p(99)<1000'],
    participant_count: ['value>100'],
  },
};

let sharedRoomId = null;

export function setup() {
  const token = getAuthToken();

  const roomRes = http.post(`${BASE_URL}/api/v1/rooms`, JSON.stringify({
    name: `large-room-test-${Date.now()}`,
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
  // Add participant
  const addRes = http.post(
    `${BASE_URL}/api/v1/rooms/${data.roomId}/participants`,
    JSON.stringify({
      external_user_id: `large-room-user-${__VU}`,
      display_name: `User ${__VU}`,
      role: 'participant',
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${data.token}`,
      },
    }
  );

  if (addRes.status !== 201) {
    console.log(`Join failed: ${addRes.status}`);
    return;
  }

  const participant = JSON.parse(addRes.body);
  participantCount.add(1);

  ws.connect(
    `${WS_URL}?token=${participant.token}`,
    {},
    function(socket) {
      const sentMessages = new Map(); // Track message send times

      socket.on('message', (msg) => {
        const message = JSON.parse(msg);
        messagesReceived.add(1);

        if (message.type === MessageType.PING) {
          socket.send(pong());
        }

        // Measure broadcast latency for chat messages
        if (message.type === MessageType.CHAT_MESSAGE) {
          const payload = message.payload;
          const sentTime = sentMessages.get(payload.id);
          if (sentTime) {
            broadcastLatency.add(Date.now() - sentTime);
            sentMessages.delete(payload.id);
          }
        }
      });

      // Send periodic chat messages using k6 socket.setInterval
      socket.setInterval(function() {
        const msgId = `${__VU}-${Date.now()}`;
        sentMessages.set(msgId, Date.now());
        socket.send(chatMessage(`Test message from VU ${__VU}`));
      }, 7000); // 7 second interval

      // Stay connected for the test duration using socket.setTimeout
      socket.setTimeout(function() {
        socket.close();
        participantCount.add(-1);
      }, 600000); // 10 minutes
    }
  );
}
