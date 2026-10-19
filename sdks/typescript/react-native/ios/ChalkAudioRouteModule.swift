import AVFoundation
import Foundation
import React
import UIKit

/// Lists the call's audio outputs (earpiece, speaker, wired and Bluetooth headsets) and switches
/// between them on the shared play-and-record session that WebRTC owns.
@objc(ChalkAudioRouteModule)
final class ChalkAudioRouteModule: RCTEventEmitter {
  private let eventName = "ChalkAudioRouteChanged"
  private var observer: NSObjectProtocol?

  override class func requiresMainQueueSetup() -> Bool {
    false
  }

  override func constantsToExport() -> [AnyHashable: Any]! {
    ["eventName": eventName]
  }

  override func supportedEvents() -> [String]! {
    [eventName]
  }

  override func startObserving() {
    observer = NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self else { return }
      self.sendEvent(withName: self.eventName, body: self.snapshot())
    }
  }

  override func stopObserving() {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    observer = nil
  }

  @objc(getRoutes:rejecter:)
  func getRoutes(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(snapshot())
  }

  @objc(selectRoute:resolver:rejecter:)
  func selectRoute(_ id: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    let session = AVAudioSession.sharedInstance()
    do {
      if id == "speaker" {
        try session.overrideOutputAudioPort(.speaker)
      } else {
        try session.overrideOutputAudioPort(.none)
        let port = session.availableInputs?.first { input in
          id == "earpiece" ? input.portType == .builtInMic : input.uid == id
        }
        if let port { try session.setPreferredInput(port) }
      }
      resolve(snapshot())
    } catch {
      reject("audio_route_failed", "Couldn't switch the audio output to \(id).", error)
    }
  }

  private func snapshot() -> [String: Any] {
    let session = AVAudioSession.sharedInstance()
    let isPhone = UIDevice.current.userInterfaceIdiom == .phone
    var routes: [[String: String]] = []
    if isPhone { routes.append(["id": "earpiece", "kind": "earpiece", "name": ""]) }
    routes.append(["id": "speaker", "kind": "speaker", "name": ""])
    for input in session.availableInputs ?? [] {
      guard let kind = Self.headsetKind(input.portType) else { continue }
      routes.append(["id": input.uid, "kind": kind, "name": input.portName])
    }
    return ["routes": routes, "selected": selectedId(session, routes: routes)]
  }

  private func selectedId(_ session: AVAudioSession, routes: [[String: String]]) -> String {
    guard let output = session.currentRoute.outputs.first else { return "speaker" }
    switch output.portType {
    case .builtInSpeaker: return "speaker"
    case .builtInReceiver: return "earpiece"
    default:
      // Headsets report the same port as input and output, so the input's id names the route.
      let input = session.currentRoute.inputs.first { Self.headsetKind($0.portType) != nil }
      return input?.uid ?? routes.first { $0["name"] == output.portName }?["id"] ?? "speaker"
    }
  }

  private static func headsetKind(_ port: AVAudioSession.Port) -> String? {
    switch port {
    case .bluetoothHFP, .bluetoothLE, .bluetoothA2DP: return "bluetooth"
    case .headsetMic, .usbAudio: return "wired"
    default: return nil
    }
  }
}
