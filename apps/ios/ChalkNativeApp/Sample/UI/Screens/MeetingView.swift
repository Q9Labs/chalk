import SwiftUI
import ChalkMeetingKit
import UIKit
import WebKit

struct MeetingView: View {
    @ObservedObject var meeting: ChalkMeetingController
    let onLeave: () -> Void
    
    @State private var activePanel: Panel? = nil
    
    enum Panel: Identifiable {
        case chat, participants, whiteboard
        var id: Self { self }
    }
    
    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                // Header
                HStack {
                    Text("Physics 101") // Room Name
                        .font(.headline)
                    Spacer()
                    HStack(spacing: 8) {
                        Image(systemName: "circle.fill")
                            .foregroundStyle(.red)
                            .font(.caption2)
                        Text("REC")
                            .font(.caption2)
                            .bold()
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.chalkSurface)
                    .cornerRadius(4)
                }
                .padding()
                .background(Color.chalkBackground)
                
                // Video Grid Area
                ScrollView {
                    let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: gridColumns)
                    LazyVGrid(columns: columns, spacing: 8) {
                        ForEach(meeting.state.participants) { participant in
                            ParticipantTile(participant: participant)
                                .aspectRatio(contentMode: .fit) // Square tiles
                                .frame(minHeight: 120) // Minimum height
                        }
                    }
                    .padding(8)
                }
                .frame(maxHeight: .infinity)
                // Layout 3: Shrink if panel is open (simplified simulation)
                // In a real app, we'd animate the frame height.
                
                // Control Bar
                HStack(spacing: 20) {
                    ControlButton(icon: "mic.fill", action: {})
                    ControlButton(icon: "video.fill", action: {})
                    
                    Spacer()
                    
                    ControlButton(icon: "hand.raised.fill", action: {})
                    ControlButton(icon: "message.fill", action: { togglePanel(.chat) })
                    ControlButton(icon: "person.2.fill", action: { togglePanel(.participants) })
                    
                    Spacer()
                    
                    Button(action: onLeave) {
                        Image(systemName: "phone.down.fill")
                            .padding()
                            .background(Color.red)
                            .foregroundStyle(.white)
                            .clipShape(Circle())
                    }
                }
                .padding()
                .background(Color.chalkSurface)
            }
            .background(Color.chalkBackground)
            // Custom Bottom Sheet / Panel Overlay
            .overlay(
                Group {
                    if let panel = activePanel {
                        VStack {
                            Spacer()
                            PanelView(panel: panel, onClose: { activePanel = nil })
                                .frame(height: geometry.size.height * 0.6) // 60% height
                                .transition(.move(edge: .bottom))
                        }
                    }
                }
            )
        }
    }
    
    var gridColumns: Int {
        if meeting.state.participants.count <= 2 { return 1 }
        return 2
    }
    
    func togglePanel(_ panel: Panel) {
        withAnimation {
            if activePanel == panel {
                activePanel = nil
            } else {
                activePanel = panel
            }
        }
    }
}

struct ControlButton: View {
    let icon: String
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 20))
                .padding()
                .background(Color.chalkSurface.opacity(0.8)) // Slightly lighter than bg
                .clipShape(Circle())
                .foregroundStyle(.white)
        }
    }
}

struct PanelView: View {
    let panel: MeetingView.Panel
    let onClose: () -> Void
    
    var body: some View {
        VStack {
            // Drag Handle / Header
            HStack {
                Text(title)
                    .font(.headline)
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.gray)
                }
            }
            .padding()
            
            Divider()
            
            // Content
            Group {
                switch panel {
                case .chat:
                    Text("Chat Placeholder")
                case .participants:
                    Text("Participants List")
                case .whiteboard:
                    WhiteboardWebView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color.chalkSurface)
        .cornerRadius(24, corners: [.topLeft, .topRight])
        .shadow(radius: 10)
    }
    
    var title: String {
        switch panel {
        case .chat: return "Chat"
        case .participants: return "Participants"
        case .whiteboard: return "Whiteboard"
        }
    }
}

// Helper for corner radius
extension View {
    func cornerRadius(_ radius: CGFloat, corners: UIRectCorner) -> some View {
        clipShape(RoundedCorner(radius: radius, corners: corners))
    }
}

struct RoundedCorner: Shape {
    var radius: CGFloat = .infinity
    var corners: UIRectCorner = .allCorners

    func path(in rect: CGRect) -> Path {
        let path = UIBezierPath(roundedRect: rect, byRoundingCorners: corners, cornerRadii: CGSize(width: radius, height: radius))
        return Path(path.cgPath)
    }
}

#Preview {
    MeetingView(
        meeting: ChalkMeetingController(),
        onLeave: {}
    )
}
