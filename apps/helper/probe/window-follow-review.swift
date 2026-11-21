import AppKit
import CoreGraphics

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let target = NSWindow(contentRect: NSRect(x: 140, y: 140, width: 480, height: 320),
    styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
target.title = "Chalk Helper target fixture"
target.animationBehavior = .none
target.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
let cover = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 20, height: 20),
    styleMask: [.borderless], backing: .buffered, defer: false)
cover.backgroundColor = .red
cover.level = .floating
let initial = target.frame
let signals = [
    (SIGUSR1, { target.setFrameOrigin(NSPoint(x: initial.origin.x + 63, y: initial.origin.y + 39)) }),
    (SIGUSR2, { target.setContentSize(NSSize(width: 560, height: 360)) }),
    (SIGALRM, { target.miniaturize(nil) }),
    (SIGHUP, { target.deminiaturize(nil); target.orderFrontRegardless() }),
    (SIGCONT, { let r = target.frame; cover.setFrameOrigin(NSPoint(x: r.maxX - 7, y: r.midY)); cover.orderFrontRegardless() }),
    (SIGWINCH, { cover.orderOut(nil) }),
    (SIGINFO, {
        target.collectionBehavior = [.moveToActiveSpace]
        let launch = Process()
        launch.executableURL = URL(fileURLWithPath: "/System/Applications/Mission Control.app/Contents/MacOS/Mission Control")
        try? launch.run()
    }),
]
let sources = signals.map { signalNumber, action -> DispatchSourceSignal in
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
    source.setEventHandler(handler: action)
    source.resume()
    return source
}
print(target.windowNumber)
fflush(stdout)
app.run()
