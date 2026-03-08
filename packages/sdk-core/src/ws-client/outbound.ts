import { camelToSnake, camelToSnakeExcept } from "../transforms.ts";
import type { WSOutboundMessage } from "./messages.ts";

const transformPayload = (message: WSOutboundMessage) => {
	if (message.payload === undefined) {
		return undefined;
	}

	if (message.type === "transcript") {
		return message.payload;
	}

	if (message.type === "whiteboard.update") {
		return camelToSnakeExcept(message.payload, ["elements"]);
	}

	if (message.type === "annotation.update") {
		return camelToSnakeExcept(message.payload, ["items"]);
	}

	return camelToSnake(message.payload);
};

export const serializeOutgoingMessage = (message: WSOutboundMessage): string => {
	const payload = transformPayload(message);
	return JSON.stringify(
		payload === undefined
			? { type: message.type }
			: { type: message.type, payload },
	);
};
