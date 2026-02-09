import ChalkMeetingKit
import SwiftUI

struct ContentView: View {
	@StateObject private var meeting = ChalkMeetingController()

	@State private var accessToken = ""
	@State private var rtcToken = ""
	@State private var apiUrl = ""
	@State private var wsUrl = ""
	@State private var roomId = ""
	@State private var participantId = ""
	@State private var displayName = ""

	var body: some View {
		NavigationStack {
			Form {
				Section("State") {
					Text("Connection: \(meeting.state.connection)")
					if let e = meeting.state.lastError {
						Text("Error: \(e)")
							.foregroundStyle(.red)
					}
				}

				Section("Join Payload") {
					TextField("apiUrl (https://... optional)", text: $apiUrl)
					TextField("wsUrl (wss://.../ws)", text: $wsUrl)
					TextField("accessToken (Chalk WS)", text: $accessToken)
					TextField("rtcToken (RealtimeKit)", text: $rtcToken)
					TextField("roomId", text: $roomId)
					TextField("participantId", text: $participantId)
					TextField("displayName", text: $displayName)
				}

				Section {
					Button("Join") {
						guard let url = URL(string: wsUrl) else { return }
						let api = URL(string: apiUrl)
						meeting.join(
							.init(
								apiUrl: api,
								wsUrl: url,
								accessToken: accessToken,
								rtcToken: rtcToken,
								roomId: roomId,
								participantId: participantId,
								displayName: displayName
							)
						)
					}
					.disabled(meeting.state.connection != "disconnected")

					Button("Leave") { meeting.leave() }
						.disabled(meeting.state.connection == "disconnected")
				}

				Section("Participants (\(meeting.state.participants.count))") {
					ForEach(meeting.state.participants) { p in
						Text("\(p.displayName) (\(p.id)) a=\(p.audioEnabled) v=\(p.videoEnabled)")
					}
				}
			}
			.navigationTitle("Chalk Native (iOS)")
		}
	}
}

#Preview {
	ContentView()
}
