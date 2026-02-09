import SwiftUI
import ChalkMeetingKit

struct ParticipantTile: View {
    let participant: ChalkParticipant
    
    var body: some View {
        ZStack {
            Rectangle()
                .fill(Color.chalkSurface)
            
            // Placeholder for video stream
            if participant.videoEnabled {
                // VideoView(track: participant.videoTrack)
                Color.gray.opacity(0.3)
            } else {
                Text(initials(for: participant.displayName))
                    .font(.system(size: 32, weight: .bold))
                    .foregroundStyle(Color.gray)
            }
            
            // Name Tag
            VStack {
                Spacer()
                HStack {
                    Text(participant.displayName)
                        .font(.caption)
                        .bold()
                        .padding(6)
                        .background(Color.black.opacity(0.6))
                        .cornerRadius(4)
                    
                    if !participant.audioEnabled {
                        Image(systemName: "mic.slash.fill")
                            .font(.caption)
                            .foregroundStyle(.red)
                            .padding(6)
                            .background(Color.black.opacity(0.6))
                            .clipShape(Circle())
                    }
                    Spacer()
                }
                .padding(8)
            }
        }
        .cornerRadius(12)
        // Active Speaker Border (Simulation)
        // .overlay(
        //     RoundedRectangle(cornerRadius: 12)
        //         .stroke(Color.chalkPrimary, lineWidth: participant.isSpeaking ? 3 : 0)
        // )
    }
    
    func initials(for name: String) -> String {
        let components = name.components(separatedBy: " ")
        if let first = components.first?.first {
            if let last = components.last?.first, components.count > 1 {
                return "\(first)\(last)"
            }
            return "\(first)"
        }
        return "?"
    }
}
