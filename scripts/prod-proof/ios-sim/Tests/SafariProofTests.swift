import XCTest

/// Drives the iPhone Safari that `run.sh` already pointed at a Chalk page: it taps Allow on the camera and
/// microphone prompts and saves a screenshot every few seconds for the whole window.
final class SafariProofTests: XCTestCase {
    private let environment = ProcessInfo.processInfo.environment

    func testAllowMediaPromptsAndCapture() throws {
        let seconds = Double(environment["PROOF_SECONDS"] ?? "90") ?? 90
        let interval = Double(environment["PROOF_SHOT_EVERY"] ?? "5") ?? 5
        let outputPath = environment["PROOF_OUT"] ?? NSTemporaryDirectory()
        let output = URL(fileURLWithPath: outputPath, isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        safari.activate()
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 20), "Safari did not come to the foreground")

        let tapToHear = environment["PROOF_TAP_TO_HEAR"] == "1"
        let tapCenterAt = Double(environment["PROOF_TAP_CENTER_AT"] ?? "")
        var tappedCenter = false
        var log = ""
        var taps = 0
        var shots = 0
        let started = Date()
        var lastShot = Date.distantPast
        while Date().timeIntervalSince(started) < seconds {
            if safari.alerts.count > 0 {
                let alert = safari.alerts.firstMatch
                let title = alert.label
                if alert.buttons["Allow"].exists {
                    alert.buttons["Allow"].tap()
                    taps += 1
                    log += String(format: "%.0fs tapped Allow on: %@\n", Date().timeIntervalSince(started), title)
                } else {
                    log += String(format: "%.0fs alert without Allow: %@\n", Date().timeIntervalSince(started), title)
                }
            }
            if tapToHear {
                let notice = safari.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", "Click to hear the call")).firstMatch
                if notice.exists {
                    notice.tap()
                    log += String(format: "%.0fs tapped the paused-sound notice\n", Date().timeIntervalSince(started))
                }
            }
            if let at = tapCenterAt, !tappedCenter, Date().timeIntervalSince(started) >= at {
                tappedCenter = true
                safari.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)).tap()
                log += String(format: "%.0fs tapped the page centre\n", Date().timeIntervalSince(started))
            }
            if Date().timeIntervalSince(lastShot) >= interval {
                lastShot = Date()
                shots += 1
                let png = XCUIScreen.main.screenshot().pngRepresentation
                try png.write(to: output.appendingPathComponent(String(format: "shot-%03d.png", shots)))
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        log += "allow taps: \(taps), screenshots: \(shots)\n"
        try log.write(to: output.appendingPathComponent("ui-test.log"), atomically: true, encoding: .utf8)
    }
}
