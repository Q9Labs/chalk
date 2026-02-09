import Foundation

public struct ChalkJoinPayload: Codable {
	public let apiUrl: URL?
	public let wsUrl: URL
	public let accessToken: String
	public let rtcToken: String
	public let roomId: String
	public let participantId: String
	public let displayName: String

	public init(
		apiUrl: URL? = nil,
		wsUrl: URL,
		accessToken: String,
		rtcToken: String,
		roomId: String,
		participantId: String,
		displayName: String
	) {
		self.apiUrl = apiUrl
		self.wsUrl = wsUrl
		self.accessToken = accessToken
		self.rtcToken = rtcToken
		self.roomId = roomId
		self.participantId = participantId
		self.displayName = displayName
	}
}
