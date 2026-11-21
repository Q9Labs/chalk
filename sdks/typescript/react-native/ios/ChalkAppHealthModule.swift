import Foundation
import MetricKit
import React
import UIKit

/// The native half of the app's health evidence on iOS: the launch marker file (written synchronously
/// before React Native loads), MetricKit's MXCrashDiagnostic for the last run, the thermal state and the
/// willTerminate flag the last run left. The marker body never holds pt_, ep_ or ten_ ids.
@objc(ChalkAppHealth)
final class ChalkAppHealthModule: NSObject, MXMetricManagerSubscriber {
  private static let markerName = "chalk.run_marker.json"
  private var crashCount = 0

  override init() {
    super.init()
    if #available(iOS 15.0, *) {
      MXMetricManager.shared.add(self)
    }
    NotificationCenter.default.addObserver(self, selector: #selector(willTerminate), name: UIApplication.willTerminateNotification, object: nil)
  }

  @objc static func requiresMainQueueSetup() -> Bool {
    false
  }

  @objc func didReceive(_ payloads: [MXDiagnosticPayload]) {
    if #available(iOS 15.0, *) {
      crashCount = payloads.flatMap { $0.crashDiagnostics }.count
      write(["exit_reason": crashCount > 0 ? "MX_CRASH" : "no_record"])
    }
  }

  @objc private func willTerminate() {
    write(["will_terminate": true])
  }

  private static var markerUrl: URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(markerName)
  }

  private static func readBody() -> [String: Any] {
    guard let data = try? Data(contentsOf: markerUrl), let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return body
  }

  private func write(_ fields: [String: Any]) {
    ChalkAppHealthModule.write(fields)
  }

  private static func write(_ fields: [String: Any]) {
    var body = readBody()
    for (key, value) in fields { body[key] = value }
    body["last_elapsed_ms"] = Int(ProcessInfo.processInfo.systemUptime * 1000)
    guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }
    try? data.write(to: markerUrl, options: .atomic)
  }

  /// The launch marker, written by AppDelegate before React Native loads: phase launch, js_ready false.
  @objc static func markLaunch() {
    write([
      "phase": "launch",
      "js_ready": false,
      "pid": ProcessInfo.processInfo.processIdentifier,
      "launch_id": UUID().uuidString,
      "launched_at_ms": Int(Date().timeIntervalSince1970 * 1000),
      "will_terminate": false,
    ])
  }

  @objc func markReady(_ cs: String) {
    write(["js_ready": true, "phase": "boot", "cs": cs])
  }

  @objc func markFatal(_ errorName: String) {
    write(["js_ready": true, "fatal": errorName])
  }

  @objc func markCallEnded() {
    write(["clean_exit": "call_ended", "phase": "live"])
  }

  @objc func setAppState(_ state: String) {
    write(["app_state": state])
  }

  @objc func readMarker(_ resolve: @escaping RCTPromiseResolveBlock, rejecter _: @escaping RCTPromiseRejectBlock) {
    let body = ChalkAppHealthModule.readBody()
    resolve(body.isEmpty ? nil : body)
  }

  @objc func readExitInfo(_ pid: Double, resolve: @escaping RCTPromiseResolveBlock, rejecter _: @escaping RCTPromiseRejectBlock) {
    if #unavailable(iOS 15.0) {
      resolve(["reason": "unsupported"])
      return
    }
    let body = ChalkAppHealthModule.readBody()
    if let reason = body["exit_reason"] as? String {
      resolve(["reason": reason, "launched_at_ms": body["launched_at_ms"] as? Int ?? 0])
      return
    }
    resolve(["reason": crashCount > 0 ? "MX_CRASH" : "no_exit_reason"])
  }

  @objc func lowMemory(_ resolve: @escaping RCTPromiseResolveBlock, rejecter _: @escaping RCTPromiseRejectBlock) {
    // iOS exposes low memory only through AppState's memoryWarning, which probes.ts reports itself.
    resolve(false)
  }

  @objc func thermalState(_ resolve: @escaping RCTPromiseResolveBlock, rejecter _: @escaping RCTPromiseRejectBlock) {
    switch ProcessInfo.processInfo.thermalState {
    case .nominal: resolve("nominal")
    case .fair: resolve("fair")
    case .serious: resolve("serious")
    case .critical: resolve("critical")
    @unknown default: resolve("unsupported")
    }
  }
}
