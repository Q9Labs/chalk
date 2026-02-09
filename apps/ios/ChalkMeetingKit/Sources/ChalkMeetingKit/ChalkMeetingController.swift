import Foundation

#if canImport(RealtimeKit)
import RealtimeKit

@MainActor
public final class ChalkMeetingController: ObservableObject {
	@Published public private(set) var state = ChalkMeetingState()

	private let ws = ChalkWsClient()
	private var rtk: RealtimeKitClient?
	private let log = ChalkFileLogger.shared

	public init() {}

	public func join(_ payload: ChalkJoinPayload) {
		state.connection = "connecting"
		state.lastError = nil
		log.log(.info, "join.start", meta: ["ws": payload.wsUrl.absoluteString])

		ws.connect(
			wsUrl: payload.wsUrl,
			accessToken: payload.accessToken,
			onState: { [weak self] s in
				self?.state.connection = s
				self?.log.log(.debug, "ws.state", meta: ["state": s])
			},
			onError: { [weak self] e in
				self?.state.connection = "failed"
				self?.state.lastError = e
				self?.log.log(.error, "ws.error", meta: ["err": e])
			},
			onEvent: { [weak self] e in self?.handleWsEvent(e) }
		)

		initRtk(rtcToken: payload.rtcToken)
	}

	public func leave() {
		log.log(.info, "leave.start")
		state.connection = "leaving"
		ws.close()
		rtk?.leaveRoom(onSuccess: {}, onFailure: { _ in })
		rtk = nil
		state = .init()
		log.log(.info, "leave.done")
	}

	private func initRtk(rtcToken: String) {
		let meetingInfo = RtkMeetingInfo(authToken: rtcToken, enableAudio: true, enableVideo: true)

		let client = RealtimeKitiOSClientBuilder().build()
		rtk = client
		client.doInit(meetingInfo: meetingInfo, onSuccess: { [weak self] in
			client.joinRoom(onSuccess: {}, onFailure: { [weak self] err in
				self?.state.connection = "failed"
				self?.state.lastError = err.message
				self?.log.log(.error, "rtk.join_failed", meta: ["err": err.message])
			})
		}, onFailure: { [weak self] err in
			self?.state.connection = "failed"
			self?.state.lastError = err.message
			self?.log.log(.error, "rtk.init_failed", meta: ["err": err.message])
		})
	}

	private func handleWsEvent(_ event: ChalkWsEvent) {
		switch event {
		case .roomSnapshot(let participants):
			state.participants = participants
			log.log(.debug, "ws.room_snapshot", meta: ["participants": "\(participants.count)"])
		case .participantJoined(let p):
			if !state.participants.contains(where: { $0.id == p.id }) {
				state.participants.append(p)
			}
			log.log(.debug, "ws.participant_joined", meta: ["participantId": p.id])
		case .participantLeft(let id):
			state.participants.removeAll { $0.id == id }
			log.log(.debug, "ws.participant_left", meta: ["participantId": id])
		case .participantUpdated(let id, let name, let audio, let video):
			guard let idx = state.participants.firstIndex(where: { $0.id == id }) else { return }
			var p = state.participants[idx]
			if let name { p.displayName = name }
			if let audio { p.audioEnabled = audio }
			if let video { p.videoEnabled = video }
			state.participants[idx] = p
			log.log(.debug, "ws.participant_updated", meta: ["participantId": id])
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
