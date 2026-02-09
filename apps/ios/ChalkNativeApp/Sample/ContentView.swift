import ChalkMeetingKit
import SwiftUI

struct ContentView: View {
    @StateObject private var meeting = ChalkMeetingController()
    
    @State private var displayName = "Guest"
    @State private var showConfig = false
    @State private var bootstrapError: String? = nil
    private let bootstrap = ChalkBootstrap()

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
                if let error = (bootstrapError ?? meeting.state.lastError) {
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
                    Section("Env (apps/native/.env)") {
                        Text("Values come from `apps/native/.env` copied into the app bundle as `chalk.env`.")
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
        bootstrapError = nil
        Task {
            do {
                let env = try ChalkEnv.load()
                let roomName = "\(env.roomPrefix)-\(UUID().uuidString.prefix(8))"
                let joined = try await bootstrap.bootstrapJoin(
                    apiUrl: env.apiUrl,
                    wsUrl: env.wsUrl,
                    apiKey: env.apiKey,
                    roomName: String(roomName),
                    displayName: displayName
                )
                meeting.join(
                    .init(
                        apiUrl: env.apiUrl,
                        wsUrl: env.wsUrl,
                        accessToken: joined.accessToken,
                        rtcToken: joined.rtcToken,
                        roomId: joined.roomId,
                        participantId: joined.participantId,
                        displayName: displayName
                    )
                )
            } catch {
                bootstrapError = error.localizedDescription
                showConfig = true
            }
        }
    }
}

#Preview {
    ContentView()
}
