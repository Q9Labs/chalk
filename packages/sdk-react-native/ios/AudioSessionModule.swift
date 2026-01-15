import AVFoundation
import React

@objc(AudioSessionModule)
class AudioSessionModule: RCTEventEmitter {
  private let audioSession = AVAudioSession.sharedInstance()
  private var routeChangeObserver: NSObjectProtocol?
  private var interruptionObserver: NSObjectProtocol?

  // MARK: - Lifecycle

  override func supportedEvents() -> [String] {
    return ["onRouteChange", "onInterruption"]
  }

  override static func requiresMainQueueSetup() -> Bool {
    return true
  }

  deinit {
    cleanup()
  }

  // MARK: - Exported Methods

  @objc func configureForCall(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      do {
        let options: AVAudioSession.CategoryOptions = [
          .allowBluetooth,
          .allowBluetoothA2DP,
          .defaultToSpeaker
        ]

        try self.audioSession.setCategory(
          .playAndRecord,
          mode: .voiceChat,
          options: options
        )

        try self.audioSession.setActive(true, options: .notifyOthersOnDeactivation)

        self.setupObservers()
        resolve([
          "configured": true,
          "category": "playAndRecord",
          "mode": "voiceChat"
        ])
      } catch {
        reject(
          "AUDIO_SESSION_ERROR",
          "Failed to configure audio session: \(error.localizedDescription)",
          error
        )
      }
    }
  }

  @objc func setOutputRoute(
    _ route: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      do {
        switch route.lowercased() {
        case "speaker":
          try self.audioSession.overrideOutputAudioPort(.speaker)
        case "earpiece":
          try self.audioSession.overrideOutputAudioPort(.none)
        case "bluetooth":
          let portOverride = self.getBluetoothRoute()
          if portOverride == .none {
            reject(
              "NO_BLUETOOTH",
              "No Bluetooth device available",
              nil
            )
            return
          }
          try self.audioSession.overrideOutputAudioPort(portOverride)
        default:
          reject(
            "INVALID_ROUTE",
            "Invalid output route: \(route)",
            nil
          )
          return
        }

        resolve([
          "route": route,
          "success": true
        ])
      } catch {
        reject(
          "ROUTE_ERROR",
          "Failed to set output route: \(error.localizedDescription)",
          error
        )
      }
    }
  }

  @objc func getAvailableRoutes(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      var routes: [String] = []

      routes.append("earpiece")
      routes.append("speaker")

      if self.isBluetoothAvailable() {
        routes.append("bluetooth")
      }

      resolve([
        "available": routes,
        "hasHeadphones": self.isHeadphonesConnected(),
        "hasBluetoothDevices": self.isBluetoothAvailable()
      ])
    }
  }

  @objc func getCurrentRoute(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let currentRoute = self.audioSession.currentRoute
      var activeRoute = "earpiece"

      if let outputs = currentRoute.outputs.first {
        switch outputs.portType {
        case .builtInSpeaker:
          activeRoute = "speaker"
        case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE:
          activeRoute = "bluetooth"
        case .headphones, .headsetMic:
          activeRoute = "headphones"
        default:
          activeRoute = "earpiece"
        }
      }

      resolve([
        "current": activeRoute,
        "outputs": currentRoute.outputs.map { output in
          [
            "port": output.portType.rawValue,
            "name": output.portName
          ]
        }
      ])
    }
  }

  @objc func setSpeakerphone(
    _ enabled: Bool,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      do {
        let portOverride: AVAudioSession.PortOverride = enabled ? .speaker : .none
        try self.audioSession.overrideOutputAudioPort(portOverride)

        resolve([
          "speakerEnabled": enabled,
          "success": true
        ])
      } catch {
        reject(
          "SPEAKER_ERROR",
          "Failed to set speakerphone: \(error.localizedDescription)",
          error
        )
      }
    }
  }

  // MARK: - Observers

  private func setupObservers() {
    routeChangeObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: audioSession,
      queue: .main
    ) { [weak self] notification in
      self?.handleRouteChange(notification)
    }

    interruptionObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: audioSession,
      queue: .main
    ) { [weak self] notification in
      self?.handleInterruption(notification)
    }
  }

  private func handleRouteChange(_ notification: Notification) {
    guard let userInfo = notification.userInfo,
      let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
      let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
      return
    }

    let currentRoute = audioSession.currentRoute
    var activeRoute = "earpiece"

    if let outputs = currentRoute.outputs.first {
      switch outputs.portType {
      case .builtInSpeaker:
        activeRoute = "speaker"
      case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE:
        activeRoute = "bluetooth"
      case .headphones, .headsetMic:
        activeRoute = "headphones"
      default:
        activeRoute = "earpiece"
      }
    }

    sendEvent(withName: "onRouteChange", body: [
      "route": activeRoute,
      "reason": reason.rawValue
    ])
  }

  private func handleInterruption(_ notification: Notification) {
    guard let userInfo = notification.userInfo,
      let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
      return
    }

    var interruptionType = "unknown"
    switch type {
    case .began:
      interruptionType = "began"
    case .ended:
      interruptionType = "ended"
    @unknown default:
      interruptionType = "unknown"
    }

    var optionsValue: UInt = 0
    if let optionsVal = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt {
      optionsValue = optionsVal
    }

    sendEvent(withName: "onInterruption", body: [
      "type": interruptionType,
      "shouldResume": optionsValue == AVAudioSession.InterruptionOptions.shouldResume.rawValue
    ])
  }

  private func cleanup() {
    if let observer = routeChangeObserver {
      NotificationCenter.default.removeObserver(observer)
    }
    if let observer = interruptionObserver {
      NotificationCenter.default.removeObserver(observer)
    }
  }

  // MARK: - Helpers

  private func isBluetoothAvailable() -> Bool {
    let availableInputs = audioSession.availableInputs ?? []
    return availableInputs.contains { input in
      input.portType == .bluetoothHFP || input.portType == .bluetoothA2DP || input.portType == .bluetoothLE
    }
  }

  private func isHeadphonesConnected() -> Bool {
    let currentRoute = audioSession.currentRoute
    return currentRoute.outputs.contains { output in
      output.portType == .headphones || output.portType == .headsetMic
    }
  }

  private func getBluetoothRoute() -> AVAudioSession.PortOverride {
    let availableInputs = audioSession.availableInputs ?? []
    let hasBluetoothHFP = availableInputs.contains { $0.portType == .bluetoothHFP }

    if hasBluetoothHFP {
      return .none
    }

    return .none
  }
}
