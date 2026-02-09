import Foundation

public enum ChalkWsEvent: Equatable {
	case roomSnapshot(participants: [ChalkParticipant])
	case participantJoined(ChalkParticipant)
	case participantLeft(id: String)
	case participantUpdated(id: String, displayName: String?, audioEnabled: Bool?, videoEnabled: Bool?)
}

final class ChalkWsClient {
	private var task: URLSessionWebSocketTask?
	private let json = JSONDecoder()
	private let log = ChalkFileLogger.shared

	func connect(
		wsUrl: URL,
		accessToken: String,
		onState: @escaping (String) -> Void,
		onError: @escaping (String) -> Void,
		onEvent: @escaping (ChalkWsEvent) -> Void
	) {
		var req = URLRequest(url: wsUrl)
		req.setValue("chalk, token.\(accessToken)", forHTTPHeaderField: "Sec-WebSocket-Protocol")

		let t = URLSession(configuration: .default).webSocketTask(with: req)
		task = t
		onState("ws_connecting")
		t.resume()
		onState("ws_connected")
		receiveLoop(onError: onError, onEvent: onEvent)
	}

	func close() {
		task?.cancel(with: .goingAway, reason: nil)
		task = nil
	}

	private func receiveLoop(onError: @escaping (String) -> Void, onEvent: @escaping (ChalkWsEvent) -> Void) {
		task?.receive { [weak self] result in
			guard let self else { return }
			switch result {
			case .failure(let err):
				self.log.log(.error, "ws.receive_failed", meta: ["err": err.localizedDescription])
				onError(err.localizedDescription)
			case .success(let msg):
				switch msg {
				case .string(let text):
					self.handle(text: text, onError: onError, onEvent: onEvent)
				default:
					break
				}
				self.receiveLoop(onError: onError, onEvent: onEvent)
			}
		}
	}

	private struct Envelope: Codable {
		let type: String
		let payload: AnyCodable?
	}

	private func handle(text: String, onError: @escaping (String) -> Void, onEvent: @escaping (ChalkWsEvent) -> Void) {
		guard let data = text.data(using: .utf8) else { return }
		do {
			let env = try JSONDecoder().decode(Envelope.self, from: data)
			switch env.type {
			case "room.snapshot", "room.sync":
				if let p = env.payload?.value as? [String: Any],
				   let raw = p["participants"] as? [[String: Any]] {
					let participants = raw.compactMap(ChalkWsClient.parseParticipant)
					onEvent(.roomSnapshot(participants: participants))
				}
			case "participant.joined":
				if let p = env.payload?.value as? [String: Any] {
					let obj = (p["participant"] as? [String: Any]) ?? p
					if let participant = ChalkWsClient.parseParticipant(obj) {
						onEvent(.participantJoined(participant))
					}
				}
			case "participant.left":
				if let p = env.payload?.value as? [String: Any],
				   let id = p["participantId"] as? String {
					onEvent(.participantLeft(id: id))
				}
			case "participant.updated":
				if let p = env.payload?.value as? [String: Any],
				   let id = p["participantId"] as? String,
				   let changes = p["changes"] as? [String: Any] {
					onEvent(
						.participantUpdated(
							id: id,
							displayName: changes["displayName"] as? String,
							audioEnabled: changes["audioEnabled"] as? Bool,
							videoEnabled: changes["videoEnabled"] as? Bool
						)
					)
				}
			default:
				break
			}
		} catch {
			log.log(.error, "ws.decode_failed", meta: ["err": error.localizedDescription])
			onError(error.localizedDescription)
		}
	}

	private static func parseParticipant(_ obj: [String: Any]) -> ChalkParticipant? {
		guard let id = obj["id"] as? String,
		      let displayName = obj["displayName"] as? String
		else { return nil }

		return ChalkParticipant(
			id: id,
			displayName: displayName,
			audioEnabled: (obj["audioEnabled"] as? Bool) ?? false,
			videoEnabled: (obj["videoEnabled"] as? Bool) ?? false,
			role: obj["role"] as? String
		)
	}
}

// Small Codable escape hatch for WS payloads. Keeps MeetingKit decoupled from backend schema churn.
public struct AnyCodable: Codable {
	public let value: Any

	public init(_ value: Any) { self.value = value }

	public init(from decoder: Decoder) throws {
		let c = try decoder.singleValueContainer()
		if let v = try? c.decode([String: AnyCodable].self) { value = v.mapValues(\.value); return }
		if let v = try? c.decode([AnyCodable].self) { value = v.map(\.value); return }
		if let v = try? c.decode(String.self) { value = v; return }
		if let v = try? c.decode(Bool.self) { value = v; return }
		if let v = try? c.decode(Double.self) { value = v; return }
		if c.decodeNil() { value = NSNull(); return }
		throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON")
	}

	public func encode(to encoder: Encoder) throws {
		var c = encoder.singleValueContainer()
		switch value {
		case let v as [String: Any]:
			try c.encode(v.mapValues(AnyCodable.init))
		case let v as [Any]:
			try c.encode(v.map(AnyCodable.init))
		case let v as String:
			try c.encode(v)
		case let v as Bool:
			try c.encode(v)
		case let v as Double:
			try c.encode(v)
		case let v as Int:
			try c.encode(v)
		case is NSNull:
			try c.encodeNil()
		default:
			throw EncodingError.invalidValue(value, .init(codingPath: c.codingPath, debugDescription: "Unsupported JSON"))
		}
	}
}
