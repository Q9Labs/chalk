import AppKit
import ScreenCaptureKit

@MainActor
func marker() -> NSPanel {
    let panel = NSPanel(
        contentRect: NSRect(x: 160, y: 190, width: 320, height: 200),
        styleMask: [.borderless, .nonactivatingPanel],
        backing: .buffered,
        defer: false
    )
    panel.backgroundColor = NSColor(srgbRed: 1, green: 0, blue: 1, alpha: 1)
    panel.level = .floating
    panel.sharingType = CommandLine.arguments.contains("--unprotected") ? .readOnly : .none
    panel.ignoresMouseEvents = true
    panel.orderFrontRegardless()
    return panel
}

@main struct CaptureProbe {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let panel = marker()
        print("marker window: \(panel.windowNumber); Screen Recording consent: \(CGPreflightScreenCaptureAccess())")
        if CommandLine.arguments.contains("--filtered") {
            Task {
                do {
                    guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
                        throw ProbeError.consentRequired
                    }
                    try await compareFilteredDisplay(panel)
                    exit(EXIT_SUCCESS)
                } catch {
                    fputs("Filtered probe: \(error)\n", stderr)
                    exit(EXIT_FAILURE)
                }
            }
        }
        app.run()
    }

    @MainActor static func compareFilteredDisplay(_ panel: NSPanel) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }),
              let ownApp = content.applications.first(where: { $0.processID == getpid() }),
              panel.isVisible else { throw ProbeError.sourceUnavailable }

        // Only read the known marker region. Never write a desktop image to disk.
        let config = SCStreamConfiguration()
        config.sourceRect = CGRect(x: panel.frame.minX + 30, y: CGFloat(display.height) - panel.frame.maxY + 30, width: 240, height: 140)
        config.width = 240
        config.height = 140
        config.showsCursor = false
        let included = SCContentFilter(display: display, excludingWindows: [])
        let excluded = SCContentFilter(display: display, excludingApplications: [ownApp], exceptingWindows: [])
        let baseline = try await SCScreenshotManager.captureImage(contentFilter: included, configuration: config)
        let clean = try await SCScreenshotManager.captureImage(contentFilter: excluded, configuration: config)
        let before = magentaCount(baseline)
        let after = magentaCount(clean)
        print("ScreenCaptureKit \(baseline.width)x\(baseline.height) marker samples: included=\(before), excluded=\(after)")
        guard before > 100, after == 0 else { throw ProbeError.markerComparisonFailed }
    }

    static func magentaCount(_ image: CGImage) -> Int {
        let pixels = NSBitmapImageRep(cgImage: image)
        var count = 0
        for y in stride(from: 0, to: image.height, by: 4) {
            for x in stride(from: 0, to: image.width, by: 4) {
                guard let color = pixels.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                if color.redComponent > 0.80 && color.blueComponent > 0.80 && color.greenComponent < 0.24 {
                    count += 1
                }
            }
        }
        return count
    }

    enum ProbeError: Error {
        case consentRequired, sourceUnavailable, markerComparisonFailed
    }
}
