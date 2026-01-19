import ws from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { BASE_URL, WS_URL } from '../config.js';
import { getAuthToken } from '../helpers/auth.js';
import { chatMessage, reaction, pong, MessageType } from '../helpers/websocket.js';

const messagesAttempted = new Counter('messages_attempted');
const messagesRateLimited = new Counter('messages_rate_limited');
const rateLimitRate = new Rate('rate_limit_rate');

export const options = {
  scenarios: {
    message_storm: {
      executor: 'constant-vus',
      vus: 50,
      duration: '5m',
    },
  },
  thresholds: {
    rate_limit_rate: ['rate>0.4'], // Expect >40% rate limited (we're sending 2x limit)
    messages_attempted: ['count>5000'],
  },
};

export function setup() {
  const token = getAuthToken();

  const roomRes = http.post(`${BASE_URL}/api/v1/rooms`, JSON.stringify({
    name: `ws-storm-${Date.now()}`,
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
  const addRes = http.post(
    `${BASE_URL}/api/v1/rooms/${data.roomId}/participants`,
    JSON.stringify({
      external_user_id: `storm-user-${__VU}`,
      display_name: `Storm User ${__VU}`,
      role: 'participant',
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${data.token}`,
      },
    }
  );

  const participant = JSON.parse(addRes.body);

  ws.connect(
    `${WS_URL}?token=${participant.token}`,
    {},
    function(socket) {
      socket.on('message', (msg) => {
        const message = JSON.parse(msg);

        if (message.type === MessageType.PING) {
          socket.send(pong());
        }

        // Track rate limit errors
        if (message.type === MessageType.ERROR) {
          const payload = message.payload;
          if (payload.code === 'RATE_LIMITED') {
            messagesRateLimited.add(1);
            rateLimitRate.add(true);
          }
        }
      });

      // Send 20 messages per second (2x rate limit of 10/10s)
      socket.setInterval(function() {
        messagesAttempted.add(1);
        rateLimitRate.add(false);

        // Alternate between chat and reactions
        if (Math.random() > 0.5) {
          socket.send(chatMessage(`Storm message ${Date.now()}`));
        } else {
          socket.send(reaction('👍'));
        }
      }, 50); // 20 messages/second

      // Close after 1 minute
      socket.setTimeout(function() {
        socket.close();
      }, 60000);
    }
  );
}
