import ChalkMeetingKit
import SwiftUI

struct ContentView: View {
    @StateObject private var meeting = ChalkMeetingController()
    
    // Config (Hardcoded for demo, normally from Deep Link or API)
    @State private var displayName = "Guest"
    // TODO: Fetch these from backend in real flow
    @State private var wsUrl = ""
    @State private var accessToken = ""
    @State private var rtcToken = ""
    @State private var roomId = ""
    @State private var participantId = UUID().uuidString
    @State private var showConfig = true

    var body: some View {
        ZStack {
            Color.chalkBackground.ignoresSafeArea()
            
            switch meeting.state.connection {
            case "connected":
                MeetingView(meeting: meeting, onLeave: {
                    meeting.leave()
                })
                .transition(.opacity)
                
            default:
                LobbyView(
                    meeting: meeting,
                    displayName: $displayName,
                    onJoin: joinMeeting,
                    onOpenConfig: { showConfig = true }
                )
                .transition(.opacity)
                
                // Overlay for connecting state
                if meeting.state.connection == "connecting" {
                    Color.black.opacity(0.6).ignoresSafeArea()
                    ProgressView("Joining...")
                        .foregroundStyle(.white)
                }
                
                // Error Toast
                if let error = meeting.state.lastError {
                    VStack {
                        Spacer()
                        Text("Error: \(error)")
                            .font(.caption)
                            .foregroundStyle(.white)
                            .padding()
                            .background(Color.red)
                            .cornerRadius(8)
                            .padding(.bottom, 40)
                    }
                    .transition(.move(edge: .bottom))
                }
            }
        }
        .animation(.default, value: meeting.state.connection)
        .sheet(isPresented: $showConfig) {
            NavigationStack {
                Form {
                    Section("Join Config (debug)") {
                        TextField("wsUrl (wss://.../ws)", text: $wsUrl)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField("accessToken (Chalk WS)", text: $accessToken)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField("rtcToken (RealtimeKit)", text: $rtcToken)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField("roomId", text: $roomId)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField("participantId", text: $participantId)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                }
                .navigationTitle("Config")
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Close") { showConfig = false }
                    }
                }
            }
        }
    }
    
    func joinMeeting() {
        // In a real app, we'd hit the HTTP API here to get tokens first.
        // For this UI demo, we assume tokens are pre-filled or handled by the controller's mock.
        guard !wsUrl.isEmpty, !accessToken.isEmpty, !rtcToken.isEmpty, !roomId.isEmpty else {
            showConfig = true
            return
        }
        guard let url = URL(string: wsUrl) else { return }
        meeting.join(
            .init(
                apiUrl: nil, // Not used in this simplified join
                wsUrl: url,
                accessToken: accessToken,
                rtcToken: rtcToken,
                roomId: roomId,
                participantId: participantId,
                displayName: displayName
            )
        )
        showConfig = false
    }
}

#Preview {
    ContentView()
}
