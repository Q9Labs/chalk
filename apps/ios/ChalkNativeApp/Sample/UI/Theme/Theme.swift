import SwiftUI

extension Color {
    static let chalkPrimary = Color(red: 0.11, green: 0.71, blue: 0.65) // #1bb6a6
    static let chalkBackground = Color(red: 0.02, green: 0.02, blue: 0.02) // #050505
    static let chalkSurface = Color(red: 0.10, green: 0.10, blue: 0.10) // #1a1a1a
    static let chalkDestructive = Color.red // Placeholder for precise oklch
    static let chalkMuted = Color.gray.opacity(0.3)
}

struct ChalkTheme {
    static let cornerRadius: CGFloat = 14
    static let padding: CGFloat = 16
    static let spacing: CGFloat = 12
}
