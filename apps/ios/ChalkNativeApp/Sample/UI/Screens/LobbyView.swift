import SwiftUI
import ChalkMeetingKit

struct LobbyView: View {
    @ObservedObject var meeting: ChalkMeetingController
    @Binding var displayName: String
    let onJoin: () -> Void
    let onOpenConfig: () -> Void

    @State private var isMicOn = true
    @State private var isCamOn = true

    var body: some View {
        VStack(spacing: 24) {
            // Header
            HStack {
                Text("chalk")
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.white)
                Spacer()
            }
            .padding(.top, 16)

            Spacer()

            // Preview Card
            ZStack {
                RoundedRectangle(cornerRadius: 24)
                    .fill(Color.chalkSurface)

                if !isCamOn {
                    Image(systemName: "video.slash.fill")
                        .font(.system(size: 48))
                        .foregroundStyle(Color.gray)
                }
            }
            // Important: without constraining the container, overlay VStacks with Spacer()
            // can expand to full height and intercept taps intended for the join button.
            .frame(height: 300)
            .overlay(alignment: .bottomLeading) {
                Text(displayName.isEmpty ? "Guest" : displayName)
                    .font(.headline)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color.black.opacity(0.6))
                    .clipShape(Capsule())
                    .padding()
            }
            .overlay(alignment: .bottom) {
                HStack(spacing: 16) {
                    Button(action: { isMicOn.toggle() }) {
                        Image(systemName: isMicOn ? "mic.fill" : "mic.slash.fill")
                            .padding()
                            .background(isMicOn ? Color.chalkSurface : Color.red)
                            .clipShape(Circle())
                    }

                    Button(action: { isCamOn.toggle() }) {
                        Image(systemName: isCamOn ? "video.fill" : "video.slash.fill")
                            .padding()
                            .background(isCamOn ? Color.chalkSurface : Color.red)
                            .clipShape(Circle())
                    }

                    Button(action: onOpenConfig) {
                        Image(systemName: "ellipsis")
                            .padding()
                            .background(Color.chalkSurface)
                            .clipShape(Circle())
                    }
                    .accessibilityLabel("Config")
                }
                .padding(.bottom, 20)
            }
            .padding(.horizontal)

            VStack(alignment: .leading, spacing: 8) {
                Text("Ready to join?")
                    .font(.title2)
                    .bold()
                Text("You'll be in a waiting room before entering the call.")
                    .font(.subheadline)
                    .foregroundStyle(Color.gray)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal)

            // Inputs
            VStack(spacing: 16) {
                TextField("Your Name", text: $displayName)
                    .padding()
                    .background(Color.chalkSurface)
                    .cornerRadius(12)
                    .textInputAutocapitalization(.words)
                
                Button(action: onJoin) {
                    Text("Ask to join")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(displayName.isEmpty ? Color.gray.opacity(0.3) : Color.chalkPrimary)
                        .foregroundStyle(.white)
                        .cornerRadius(12)
                }
                .disabled(displayName.isEmpty)
            }
            .padding(.horizontal)

            Spacer()
        }
        .background(Color.chalkBackground.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }
}

#Preview {
    LobbyView(
        meeting: ChalkMeetingController(),
        displayName: .constant("Hasan"),
        onJoin: {},
        onOpenConfig: {}
    )
}
