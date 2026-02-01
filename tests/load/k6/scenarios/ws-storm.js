import { check } from "k6";
import http from "k6/http";
import { Counter, Rate } from "k6/metrics";
import ws from "k6/ws";
import { BASE_URL, WS_URL } from "../config.js";
import { getAuthToken } from "../helpers/auth.js";
import {
	chatMessage,
	MessageType,
	pong,
	reaction,
} from "../helpers/websocket.js";

const messagesAttempted = new Counter("messages_attempted");
const messagesErrored = new Counter("messages_errored");
const messageErrorRate = new Rate("message_error_rate");
const isShort = __ENV.K6_SHORT === "true";
const activeUsers = Number(__ENV.K6_ACTIVE_USERS || 3000);
const stormVUs = isShort ? 20 : Number(__ENV.WS_STORM_VUS || activeUsers);
const stormDuration = isShort ? "1m" : "5m";
const minMessagesAttempted = isShort ? 500 : Math.max(5000, stormVUs * 50);

export const options = {
	scenarios: {
		message_storm: {
			executor: "constant-vus",
			vus: stormVUs,
			duration: stormDuration,
		},
	},
	thresholds: {
		message_error_rate: ["rate<0.05"], // Keep WS errors under 5%
		messages_attempted: [`count>${minMessagesAttempted}`],
	},
};

export function setup() {
	const token = getAuthToken();

	const roomRes = http.post(
		`${BASE_URL}/api/v1/rooms`,
		JSON.stringify({
			name: `ws-storm-${Date.now()}`,
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
	const addRes = http.post(
		`${BASE_URL}/api/v1/rooms/${data.roomId}/participants`,
		JSON.stringify({
			external_user_id: `storm-user-${__VU}`,
			display_name: `Storm User ${__VU}`,
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
		console.log(`Add participant failed: ${addRes.status} - ${addRes.body}`);
		return;
	}

	const participant = JSON.parse(addRes.body);
	const wsHeaders = {
		"Sec-WebSocket-Protocol": `chalk, token.${participant.access_token}`,
	};

	const wsRes = ws.connect(`${WS_URL}`, { headers: wsHeaders }, (socket) => {
		socket.on("message", (msg) => {
			const message = JSON.parse(msg);

			if (message.type === MessageType.PING) {
				socket.send(pong());
			}

			// Track rate limit errors
			if (message.type === MessageType.ERROR) {
				messagesErrored.add(1);
				messageErrorRate.add(true);
			}
		});

		// Send 20 messages per second (2x rate limit of 10/10s)
		socket.setInterval(() => {
			messagesAttempted.add(1);
			messageErrorRate.add(false);

			// Alternate between chat and reactions
			if (Math.random() > 0.5) {
				socket.send(chatMessage(`Storm message ${Date.now()}`));
			} else {
				socket.send(reaction("👍"));
			}
		}, 50); // 20 messages/second

		// Close after 1 minute
		socket.setTimeout(() => {
			socket.close();
		}, 60000);
	});

	check(wsRes, { "ws connected": (r) => r && r.status === 101 });
}
