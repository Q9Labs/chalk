import ChalkMeetingKit
import SwiftUI
import UIKit

private struct ActivityView: UIViewControllerRepresentable {
    let activityItems: [Any]
    
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
    }
    
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

struct ContentView: View {
    @StateObject private var meeting = ChalkMeetingController()
    
    @State private var displayName = "Guest"
    @State private var showConfig = false
    @State private var showShareLogs = false
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

                    Section("Logs") {
                        Button("Share logs") { showShareLogs = true }
                        Button("Clear logs", role: .destructive) { ChalkFileLogger.shared.clear() }

                        let files = ChalkFileLogger.shared.files()
                        if files.isEmpty {
                            Text("No logs yet.")
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(files, id: \.path) { url in
                                Text(url.lastPathComponent)
                                    .font(.caption)
                            }
                        }
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
        .sheet(isPresented: $showShareLogs) {
            ActivityView(activityItems: ChalkFileLogger.shared.files().map { $0 as Any })
        }
    }
    
    func joinMeeting() {
        bootstrapError = nil
        ChalkFileLogger.shared.log(.info, "bootstrap.join_start")
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
                ChalkFileLogger.shared.log(.error, "bootstrap.join_failed", meta: ["err": error.localizedDescription])
                showConfig = true
            }
        }
    }
}

#Preview {
    ContentView()
}
