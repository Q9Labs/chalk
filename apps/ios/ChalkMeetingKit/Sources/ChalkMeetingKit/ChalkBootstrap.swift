import Foundation

public struct ChalkBootstrapJoin {
	public let accessToken: String
	public let refreshToken: String
	public let rtcToken: String
	public let roomId: String
	public let participantId: String
	public let displayName: String
}

public enum ChalkBootstrapError: Error, LocalizedError {
	case invalidURL
	case http(Int, String)
	case decode(String)

	public var errorDescription: String? {
		switch self {
		case .invalidURL: return "Invalid URL"
		case .http(let code, let msg): return "HTTP \(code): \(msg)"
		case .decode(let msg): return "Decode failed: \(msg)"
		}
	}
}

public final class ChalkBootstrap {
	public init() {}

	private struct TokenReq: Encodable { let api_key: String }
	private struct TokenRes: Decodable {
		let access_token: String
		let refresh_token: String
		let expires_in: Int
		let token_type: String
	}

	private struct AddParticipantReq: Encodable {
		let display_name: String
		let role: String?
	}
	private struct AddParticipantRes: Decodable {
		struct Participant: Decodable { let id: String; let display_name: String }
		struct Room: Decodable { let id: String; let name: String? }
		let participant: Participant
		let room: Room
		let access_token: String
		let refresh_token: String
		let auth_token: String
	}

	private func exchangeApiKey(apiUrl: URL, apiKey: String) async throws -> TokenRes {
		var req = URLRequest(url: apiUrl.appendingPathComponent("/api/v1/auth/token"))
		req.httpMethod = "POST"
		req.setValue("application/json", forHTTPHeaderField: "Content-Type")
		req.httpBody = try JSONEncoder().encode(TokenReq(api_key: apiKey))

		let (data, resp) = try await URLSession.shared.data(for: req)
		let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
		guard (200..<300).contains(code) else {
			throw ChalkBootstrapError.http(code, String(data: data, encoding: .utf8) ?? "")
		}
		do {
			return try JSONDecoder().decode(TokenRes.self, from: data)
		} catch {
			throw ChalkBootstrapError.decode(error.localizedDescription)
		}
	}

	private func addParticipant(apiUrl: URL, tenantAccessToken: String, roomNameOrId: String, displayName: String) async throws -> AddParticipantRes {
		let path = "/api/v1/rooms/\(roomNameOrId)/participants"
		guard let url = URL(string: path, relativeTo: apiUrl) else { throw ChalkBootstrapError.invalidURL }
		var req = URLRequest(url: url)
		req.httpMethod = "POST"
		req.setValue("application/json", forHTTPHeaderField: "Content-Type")
		req.setValue("Bearer \(tenantAccessToken)", forHTTPHeaderField: "Authorization")
		req.httpBody = try JSONEncoder().encode(AddParticipantReq(display_name: displayName, role: nil))

		let (data, resp) = try await URLSession.shared.data(for: req)
		let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
		guard (200..<300).contains(code) else {
			throw ChalkBootstrapError.http(code, String(data: data, encoding: .utf8) ?? "")
		}
		do {
			return try JSONDecoder().decode(AddParticipantRes.self, from: data)
		} catch {
			throw ChalkBootstrapError.decode(error.localizedDescription)
		}
	}

	public func bootstrapJoin(apiUrl: URL, wsUrl: URL, apiKey: String, roomName: String, displayName: String) async throws -> ChalkBootstrapJoin {
		let tenant = try await exchangeApiKey(apiUrl: apiUrl, apiKey: apiKey)
		let joined = try await addParticipant(apiUrl: apiUrl, tenantAccessToken: tenant.access_token, roomNameOrId: roomName, displayName: displayName)

		return ChalkBootstrapJoin(
			accessToken: joined.access_token,
			refreshToken: joined.refresh_token,
			rtcToken: joined.auth_token,
			roomId: joined.room.id,
			participantId: joined.participant.id,
			displayName: displayName
		)
	}
}
