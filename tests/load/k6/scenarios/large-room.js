import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import ws from "k6/ws";
import { BASE_URL, WS_URL } from "../config.js";
import { getAuthToken } from "../helpers/auth.js";
import { chatMessage, MessageType, pong } from "../helpers/websocket.js";

const broadcastLatency = new Trend("broadcast_latency");
const participantsJoined = new Counter("participants_joined");
const messagesReceived = new Counter("messages_received");
const isShort = __ENV.K6_SHORT === "true";
const activeUsers = Number(__ENV.K6_ACTIVE_USERS || 3000);
const fullTarget = Math.max(100, activeUsers);
const midTarget = Math.max(50, Math.round(fullTarget * 0.7));
const lowTarget = Math.max(20, Math.round(fullTarget * 0.4));
const stages = isShort
	? [
			{ duration: "30s", target: 20 },
			{ duration: "1m", target: 40 },
			{ duration: "1m", target: 40 },
			{ duration: "30s", target: 0 },
		]
	: [
			{ duration: "2m", target: lowTarget }, // Ramp to 40%
			{ duration: "3m", target: midTarget }, // Ramp to 70%
			{ duration: "5m", target: fullTarget }, // Scale to full load
			{ duration: "10m", target: fullTarget }, // Hold and observe
			{ duration: "2m", target: 0 }, // Ramp down
		];
const minParticipants = isShort ? 20 : Math.max(100, Math.round(fullTarget * 0.6));
const socketDuration = isShort ? 120000 : 600000;

export const options = {
	scenarios: {
		large_room: {
			executor: "ramping-vus",
			startVUs: 0,
			stages,
		},
	},
	thresholds: {
		broadcast_latency: ["p(95)<500", "p(99)<1000"],
		participants_joined: [`count>${minParticipants}`],
	},
};

const sharedRoomId = null;

export function setup() {
	const token = getAuthToken();

	const roomRes = http.post(
		`${BASE_URL}/api/v1/rooms`,
		JSON.stringify({
			name: `large-room-test-${Date.now()}`,
		}),
		{
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
		},
	);

	const room = JSON.parse(roomRes.body);
	return { token, roomId: room.id };
}

export default function (data) {
	// Add participant
	const addRes = http.post(
		`${BASE_URL}/api/v1/rooms/${data.roomId}/participants`,
		JSON.stringify({
			external_user_id: `large-room-user-${__VU}`,
			display_name: `User ${__VU}`,
			role: "participant",
		}),
		{
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${data.token}`,
			},
		},
	);

	if (addRes.status !== 201) {
		console.log(`Join failed: ${addRes.status}`);
		return;
	}

	const participant = JSON.parse(addRes.body);
	participantsJoined.add(1);

	const wsHeaders = {
		"Sec-WebSocket-Protocol": `chalk, token.${participant.access_token}`,
	};

	ws.connect(`${WS_URL}`, { headers: wsHeaders }, (socket) => {
		const sentMessages = new Map(); // content -> send time

		socket.on("message", (msg) => {
			const message = JSON.parse(msg);
			messagesReceived.add(1);

			if (message.type === MessageType.PING) {
				socket.send(pong());
			}

			// Measure broadcast latency for chat messages
			if (message.type === MessageType.CHAT_MESSAGE) {
				const payload = message.payload;
				const sentTime = sentMessages.get(payload.content);
				if (sentTime) {
					broadcastLatency.add(Date.now() - sentTime);
					sentMessages.delete(payload.content);
				}
			}
		});

		// Send periodic chat messages using k6 socket.setInterval
		socket.setInterval(() => {
			const content = `Test message ${__VU}-${Date.now()}`;
			sentMessages.set(content, Date.now());
			socket.send(chatMessage(content));
		}, 7000); // 7 second interval

		// Stay connected for the test duration using socket.setTimeout
		socket.setTimeout(() => {
			socket.close();
			// connection finished
		}, socketDuration);
	});
}
