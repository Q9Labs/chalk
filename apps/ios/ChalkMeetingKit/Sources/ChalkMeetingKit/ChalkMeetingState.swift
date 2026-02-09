import Foundation

public struct ChalkMeetingState: Equatable {
	public var connection = "disconnected"
	public var participants: [ChalkParticipant] = []
	public var lastError: String?

	public init() {}
}

public struct ChalkParticipant: Codable, Equatable, Identifiable {
	public let id: String
	public var displayName: String
	public var audioEnabled: Bool
	public var videoEnabled: Bool
	public var role: String?

	public init(
		id: String,
		displayName: String,
		audioEnabled: Bool = false,
		videoEnabled: Bool = false,
		role: String? = nil
	) {
		self.id = id
		self.displayName = displayName
		self.audioEnabled = audioEnabled
		self.videoEnabled = videoEnabled
		self.role = role
	}
}

