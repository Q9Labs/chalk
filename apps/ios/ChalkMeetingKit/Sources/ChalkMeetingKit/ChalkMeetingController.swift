import Foundation

#if canImport(RealtimeKit)
import RealtimeKit

@MainActor
public final class ChalkMeetingController: ObservableObject {
	@Published public private(set) var state = ChalkMeetingState()

	private let ws = ChalkWsClient()
	private var rtk: RealtimeKitClient?

	public init() {}

	public func join(_ payload: ChalkJoinPayload) {
		state.connection = "connecting"
		state.lastError = nil

		ws.connect(
			wsUrl: payload.wsUrl,
			accessToken: payload.accessToken,
			onState: { [weak self] s in self?.state.connection = s },
			onError: { [weak self] e in
				self?.state.connection = "failed"
				self?.state.lastError = e
			},
			onEvent: { [weak self] e in self?.handleWsEvent(e) }
		)

		initRtk(rtcToken: payload.rtcToken)
	}

	public func leave() {
		state.connection = "leaving"
		ws.close()
		rtk?.leaveRoom(onSuccess: {}, onFailure: { _ in })
		rtk = nil
		state = .init()
	}

	private func initRtk(rtcToken: String) {
		let meetingInfo = RtkMeetingInfo(authToken: rtcToken, enableAudio: true, enableVideo: true)

		let client = RealtimeKitiOSClientBuilder().build()
		rtk = client
		client.doInit(meetingInfo: meetingInfo, onSuccess: {}, onFailure: { [weak self] err in
			self?.state.connection = "failed"
			self?.state.lastError = err.message
		})
		client.joinRoom(onSuccess: {}, onFailure: { [weak self] err in
			self?.state.connection = "failed"
			self?.state.lastError = err.message
		})
	}

	private func handleWsEvent(_ event: ChalkWsEvent) {
		switch event {
		case .roomSnapshot(let participants):
			state.participants = participants
		case .participantJoined(let p):
			if !state.participants.contains(where: { $0.id == p.id }) {
				state.participants.append(p)
			}
		case .participantLeft(let id):
			state.participants.removeAll { $0.id == id }
		case .participantUpdated(let id, let name, let audio, let video):
			guard let idx = state.participants.firstIndex(where: { $0.id == id }) else { return }
			var p = state.participants[idx]
			if let name { p.displayName = name }
			if let audio { p.audioEnabled = audio }
			if let video { p.videoEnabled = video }
			state.participants[idx] = p
		}
	}
}
#else
@MainActor
public final class ChalkMeetingController: ObservableObject {
	@Published public private(set) var state = ChalkMeetingState()

	private let ws = ChalkWsClient()

	public init() {}

	public func join(_ payload: ChalkJoinPayload) {
		state.connection = "failed"
		state.lastError = "RealtimeKit not available (build this target for iOS in Xcode)"

		ws.connect(
			wsUrl: payload.wsUrl,
			accessToken: payload.accessToken,
			onState: { _ in },
			onError: { _ in },
			onEvent: { _ in }
		)
	}

	public func leave() {
		ws.close()
		state = .init()
	}
}
#endif
