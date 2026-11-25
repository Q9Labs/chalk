import CoreImage
import Darwin
import Foundation
import ImageIO
import ReplayKit

private let appGroupIdentifier = "group.ai.q9labs.chalk.mobile"
private let screenShareSocketName = "rtc_SSFD"

final class SampleHandler: RPBroadcastSampleHandler {
  private let sender = ScreenShareSocketSender()
  private let encoder = ScreenFrameEncoder()

  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
    guard
      let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroupIdentifier
      )
    else {
      finishBroadcastWithError(screenShareError("The Chalk app group is unavailable."))
      return
    }
    sender.connect(to: container.appendingPathComponent(screenShareSocketName).path) { [weak self] error in
      self?.finishBroadcastWithError(error)
    }
    // Chalk's picker waits for this before it opens the capture socket.
    if let bundleId = Bundle.main.bundleIdentifier {
      CFNotificationCenterPostNotification(
        CFNotificationCenterGetDarwinNotifyCenter(),
        CFNotificationName("\(bundleId).started" as CFString),
        nil,
        nil,
        true
      )
    }
  }

  override func broadcastFinished() {
    sender.close()
  }

  override func processSampleBuffer(
    _ sampleBuffer: CMSampleBuffer,
    with sampleBufferType: RPSampleBufferType
  ) {
    guard sampleBufferType == .video else { return }
    encoder.encode(sampleBuffer) { [weak sender = sender] frame in
      sender?.send(frame)
    }
  }
}

private final class ScreenFrameEncoder: @unchecked Sendable {
  private let context = CIContext(options: nil)
  private let queue = DispatchQueue(label: "ai.q9labs.chalk.screen-share.encoder")
  private var encoding = false

  func encode(_ sampleBuffer: CMSampleBuffer, completion: @escaping @Sendable (Data) -> Void) {
    queue.async { [weak self] in
      guard let self, !encoding else { return }
      encoding = true
      defer { encoding = false }
      guard
        let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer),
        let frame = encodedFrame(pixelBuffer, sampleBuffer: sampleBuffer)
      else { return }
      completion(frame)
    }
  }

  private func encodedFrame(_ pixelBuffer: CVPixelBuffer, sampleBuffer: CMSampleBuffer) -> Data? {
    let scale = CGAffineTransform(scaleX: 0.5, y: 0.5)
    let image = CIImage(cvPixelBuffer: pixelBuffer).transformed(by: scale)
    let colorSpace = image.colorSpace ?? CGColorSpaceCreateDeviceRGB()
    guard
      let jpeg = context.jpegRepresentation(
        of: image,
        colorSpace: colorSpace,
        options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.82]
      )
    else { return nil }

    let width = CVPixelBufferGetWidth(pixelBuffer) / 2
    let height = CVPixelBufferGetHeight(pixelBuffer) / 2
    let orientation = (
      CMGetAttachment(
        sampleBuffer,
        key: RPVideoSampleOrientationKey as CFString,
        attachmentModeOut: nil
      ) as? NSNumber
    )?.uintValue ?? 0
    // WebRTC's reader waits for the blank line that ends the headers, so every line ends in CRLF.
    let header = [
      "HTTP/1.1 200 OK",
      "Content-Length: \(jpeg.count)",
      "Buffer-Width: \(width)",
      "Buffer-Height: \(height)",
      "Buffer-Orientation: \(orientation)",
      "",
      "",
    ].joined(separator: "\r\n")
    guard var message = header.data(using: String.Encoding.utf8) else { return nil }
    message.append(jpeg)
    return message
  }
}

private final class ScreenShareSocketSender: @unchecked Sendable {
  /// A broadcast started from Control Center, or after Chalk gave up waiting, has no capture
  /// socket to join. End it rather than leave the screen recording with nobody watching.
  private static let connectionDeadline: TimeInterval = 10
  private let queue = DispatchQueue(label: "ai.q9labs.chalk.screen-share.socket")
  private var deadline = Date.distantFuture
  private var descriptor: Int32 = -1
  private var stopped = false
  private var failure: (@Sendable (Error) -> Void)?

  func connect(to path: String, onFailure: @escaping @Sendable (Error) -> Void) {
    queue.async { [weak self] in
      guard let self else { return }
      stopped = false
      failure = onFailure
      deadline = Date().addingTimeInterval(Self.connectionDeadline)
      attemptConnection(path: path)
    }
  }

  func send(_ data: Data) {
    queue.async { [weak self] in
      guard let self, descriptor >= 0, !stopped else { return }
      let result = data.withUnsafeBytes { bytes -> Bool in
        guard let baseAddress = bytes.baseAddress else { return false }
        var written = 0
        while written < data.count {
          let count = Darwin.send(
            self.descriptor,
            baseAddress.advanced(by: written),
            data.count - written,
            0
          )
          if count <= 0 { return false }
          written += count
        }
        return true
      }
      if !result {
        closeDescriptor()
        failure?(screenShareError("Chalk stopped sharing your screen."))
      }
    }
  }

  func close() {
    queue.async { [weak self] in
      self?.stopped = true
      self?.closeDescriptor()
    }
  }

  private func attemptConnection(path: String) {
    guard !stopped else { return }
    let socketDescriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard socketDescriptor >= 0 else {
      failure?(screenShareError("The Chalk screen-share socket could not be created."))
      return
    }
    // Chalk closing its end must fail the next send, not raise SIGPIPE and kill the extension.
    var noSignal: Int32 = 1
    setsockopt(socketDescriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let maximumPathLength = MemoryLayout.size(ofValue: address.sun_path)
    guard path.utf8.count < maximumPathLength else {
      Darwin.close(socketDescriptor)
      failure?(screenShareError("The Chalk screen-share socket path is invalid."))
      return
    }
    _ = withUnsafeMutablePointer(to: &address.sun_path.0) { destination in
      path.withCString { source in
        strncpy(destination, source, maximumPathLength - 1)
      }
    }
    let status = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(socketDescriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard status == 0 else {
      Darwin.close(socketDescriptor)
      guard Date() < deadline else {
        failure?(screenShareError("Start sharing your screen from a Chalk call."))
        return
      }
      queue.asyncAfter(deadline: .now() + .milliseconds(100)) { [weak self] in
        self?.attemptConnection(path: path)
      }
      return
    }
    descriptor = socketDescriptor
  }

  private func closeDescriptor() {
    guard descriptor >= 0 else { return }
    Darwin.shutdown(descriptor, Int32(SHUT_RDWR))
    Darwin.close(descriptor)
    descriptor = -1
  }
}

private func screenShareError(_ message: String) -> NSError {
  NSError(
    domain: "ai.q9labs.chalk.mobile.screen-share",
    code: 1,
    userInfo: [NSLocalizedDescriptionKey: message]
  )
}
