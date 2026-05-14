import ReplayKit
import RealtimeKitScreenShare

final class SampleHandler: RTKScreenshareHandler {
  override init() {
    super.init(
      appGroupIdentifier: "group.ai.q9labs.chalk.mobile",
      bundleIdentifier: "ai.q9labs.chalk.mobile"
    )
  }
}
