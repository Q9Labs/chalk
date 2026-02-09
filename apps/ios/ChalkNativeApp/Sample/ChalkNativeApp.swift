import SwiftUI
import ChalkMeetingKit

@main
struct ChalkNativeApp: App {
	init() {
		ChalkFileLogger.shared.configure()
		ChalkFileLogger.shared.log(.info, "app.start")
	}

	var body: some Scene {
		WindowGroup { ContentView() }
	}
}
