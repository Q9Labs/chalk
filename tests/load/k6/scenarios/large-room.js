import http from "k6/http";
import ws from "k6/ws";
import { Counter, Trend } from "k6/metrics";
import { BASE_URL, WS_URL, ACTIVE_USERS, SHORT_RUN } from "../config.js";
import { getAuthToken } from "../helpers/auth.js";
import { chatMessage, MessageType, pong } from "../helpers/websocket.js";

const broadcastLatency = new Trend("broadcast_latency");
const participantsJoined = new Counter("participants_joined");
const messagesReceived = new Counter("messages_received");

const isShort = SHORT_RUN;
const activeUsers = ACTIVE_USERS;
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
			{ duration: "2m", target: lowTarget },
			{ duration: "3m", target: midTarget },
			{ duration: "5m", target: fullTarget },
			{ duration: "10m", target: fullTarget },
			{ duration: "2m", target: 0 },
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
		http_req_failed: ["rate<0.01"],
		broadcast_latency: ["p(95)<500", "p(99)<1000"],
		participants_joined: [`count>${minParticipants}`],
	},
};

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

	if (roomRes.status !== 201) {
		if (__ENV.DEBUG_ENV === "true") {
			console.log(`Room create failed: ${roomRes.status} - ${roomRes.body}`);
		}
		return { token, roomId: null };
	}

	const room = JSON.parse(roomRes.body);
	return { token, roomId: room.id };
}

export default function (data) {
	if (!data.roomId) return;

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
		if (__ENV.DEBUG_ENV === "true") {
			console.log(`Join failed: ${addRes.status} - ${addRes.body}`);
		}
		return;
	}

	const participant = JSON.parse(addRes.body);
	const wsToken =
		participant.access_token ||
		participant.accessToken ||
		participant.auth_token ||
		participant.authToken;
	const myParticipantId =
		participant.participant?.id ||
		participant.participant_id ||
		participant.participantId ||
		null;

	if (!wsToken) {
		if (__ENV.DEBUG_ENV === "true") {
			console.log(`Missing websocket token in response: ${addRes.body}`);
		}
		return;
	}

	participantsJoined.add(1);

	ws.connect(`${WS_URL}?token=${wsToken}`, {}, (socket) => {
		const pending = new Map();

		socket.on("message", (msg) => {
			messagesReceived.add(1);

			if (msg.includes('"type":"ping"')) {
				socket.send(pong());
				return;
			}

			if (!msg.includes('"type":"chat.message"')) return;

			try {
				const message = JSON.parse(msg);
				if (message.type !== MessageType.CHAT_MESSAGE) return;
				const payload = message.payload;
				if (!payload || payload.participant_id !== myParticipantId) return;
				const sentAt = pending.get(payload.content);
				if (!sentAt) return;
				broadcastLatency.add(Date.now() - sentAt);
				pending.delete(payload.content);
			} catch {
				return;
			}
		});

		socket.setInterval(() => {
			const content = `Test message ${__VU}-${Date.now()}`;
			pending.set(content, Date.now());
			socket.send(chatMessage(content));
		}, 7000);

		socket.setTimeout(() => {
			socket.close();
		}, socketDuration);
	});
}
