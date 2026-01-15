import CallKit
import AVFoundation
import React

@objc(CallKitModule)
class CallKitModule: RCTEventEmitter {
  private var provider: CXProvider?
  private var callController: CXCallController?
  private var activeCalls: [UUID: String] = [:]
  private let callQueue = DispatchQueue(label: "com.chalk.callkit")

  // MARK: - RCTEventEmitter

  override func supportedEvents() -> [String] {
    return ["onIncomingCall", "onCallEnded", "onCallAnswered", "onCallDeclined", "onCallMuted", "onCallHeld", "onAudioSessionActivated", "onAudioSessionDeactivated"]
  }

  override static func requiresMainQueueSetup() -> Bool {
    return true
  }

  // MARK: - Initialization

  override init() {
    super.init()
    configureProvider()
  }

  private func configureProvider() {
    let config = CXProviderConfiguration()
    config.supportsVideo = true
    config.maximumCallsPerCallGroup = 1
    config.supportedHandleTypes = [.generic]
    // Note: nativeCallConferencingSupported was deprecated in iOS 14.5 and removed

    provider = CXProvider(configuration: config)
    provider?.setDelegate(self, queue: callQueue)
    callController = CXCallController(queue: callQueue)
  }

  // MARK: - Exported Methods

  @objc func reportIncomingCall(
    _ uuid: String,
    handle: String,
    displayName: String,
    hasVideo: Bool,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    callQueue.async { [weak self] in
      guard let self = self,
        let provider = self.provider,
        let callUUID = UUID(uuidString: uuid) else {
        DispatchQueue.main.async {
          reject("INVALID_UUID", "Invalid UUID format", nil)
        }
        return
      }

      let update = CXCallUpdate()
      update.remoteHandle = CXHandle(type: .generic, value: handle)
      update.localizedCallerName = displayName
      update.hasVideo = hasVideo
      update.supportsHolding = true
      update.supportsGrouping = false
      update.supportsUngrouping = false

      provider.reportNewIncomingCall(with: callUUID, update: update) { [weak self] error in
        DispatchQueue.main.async {
          if let error = error {
            reject("REPORT_CALL_ERROR", error.localizedDescription, error)
          } else {
            self?.activeCalls[callUUID] = ""
            resolve([
              "uuid": uuid,
              "success": true
            ])
          }
        }
      }
    }
  }

  @objc func reportOutgoingCall(
    _ uuid: String,
    handle: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    callQueue.async { [weak self] in
      guard let self = self,
        let callController = self.callController,
        let callUUID = UUID(uuidString: uuid) else {
        DispatchQueue.main.async {
          reject("INVALID_UUID", "Invalid UUID format", nil)
        }
        return
      }

      let handle = CXHandle(type: .generic, value: handle)
      let startCallAction = CXStartCallAction(call: callUUID, handle: handle)

      let transaction = CXTransaction(action: startCallAction)

      callController.request(transaction) { [weak self] error in
        DispatchQueue.main.async {
          if let error = error {
            reject("START_CALL_ERROR", error.localizedDescription, error)
          } else {
            self?.activeCalls[callUUID] = ""
            resolve([
              "uuid": uuid,
              "success": true
            ])
          }
        }
      }
    }
  }

  @objc func reportCallConnected(
    _ uuid: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    callQueue.async { [weak self] in
      guard let self = self,
        let provider = self.provider,
        let callUUID = UUID(uuidString: uuid) else {
        DispatchQueue.main.async {
          reject("INVALID_UUID", "Invalid UUID format", nil)
        }
        return
      }

      provider.reportOutgoingCall(with: callUUID, connectedAt: Date())

      DispatchQueue.main.async {
        resolve([
          "uuid": uuid,
          "success": true
        ])
      }
    }
  }

  @objc func reportCallEnded(
    _ uuid: String,
    reason: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    callQueue.async { [weak self] in
      guard let self = self,
        let provider = self.provider,
        let callUUID = UUID(uuidString: uuid) else {
        DispatchQueue.main.async {
          reject("INVALID_UUID", "Invalid UUID format", nil)
        }
        return
      }

      let endReason: CXCallEndedReason
      switch reason.lowercased() {
      case "failed":
        endReason = .failed
      case "remoteended":
        endReason = .remoteEnded
      case "unanswered":
        endReason = .unanswered
      case "declinedelse":
        endReason = .declinedElsewhere
      default:
        endReason = .failed
      }

      provider.reportCall(with: callUUID, endedAt: Date(), reason: endReason)
      self.activeCalls.removeValue(forKey: callUUID)

      DispatchQueue.main.async {
        resolve([
          "uuid": uuid,
          "success": true
        ])
      }
    }
  }

  @objc func setCallMuted(
    _ uuid: String,
    muted: Bool,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    callQueue.async { [weak self] in
      guard let self = self,
        let callController = self.callController,
        let callUUID = UUID(uuidString: uuid) else {
        DispatchQueue.main.async {
          reject("INVALID_UUID", "Invalid UUID format", nil)
        }
        return
      }

      let muteAction = CXSetMutedCallAction(call: callUUID, muted: muted)
      let transaction = CXTransaction(action: muteAction)

      callController.request(transaction) { [weak self] error in
        DispatchQueue.main.async {
          if let error = error {
            reject("MUTE_CALL_ERROR", error.localizedDescription, error)
          } else {
            resolve([
              "uuid": uuid,
              "muted": muted,
              "success": true
            ])
          }
        }
      }
    }
  }

  @objc func setCallHeld(
    _ uuid: String,
    held: Bool,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    callQueue.async { [weak self] in
      guard let self = self,
        let callController = self.callController,
        let callUUID = UUID(uuidString: uuid) else {
        DispatchQueue.main.async {
          reject("INVALID_UUID", "Invalid UUID format", nil)
        }
        return
      }

      let heldAction = CXSetHeldCallAction(call: callUUID, onHold: held)
      let transaction = CXTransaction(action: heldAction)

      callController.request(transaction) { [weak self] error in
        DispatchQueue.main.async {
          if let error = error {
            reject("HELD_CALL_ERROR", error.localizedDescription, error)
          } else {
            resolve([
              "uuid": uuid,
              "held": held,
              "success": true
            ])
          }
        }
      }
    }
  }

  @objc func endCall(
    _ uuid: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    callQueue.async { [weak self] in
      guard let self = self,
        let callController = self.callController,
        let callUUID = UUID(uuidString: uuid) else {
        DispatchQueue.main.async {
          reject("INVALID_UUID", "Invalid UUID format", nil)
        }
        return
      }

      let endAction = CXEndCallAction(call: callUUID)
      let transaction = CXTransaction(action: endAction)

      callController.request(transaction) { [weak self] error in
        DispatchQueue.main.async {
          if let error = error {
            reject("END_CALL_ERROR", error.localizedDescription, error)
          } else {
            self?.activeCalls.removeValue(forKey: callUUID)
            resolve([
              "uuid": uuid,
              "success": true
            ])
          }
        }
      }
    }
  }

  @objc func getActiveCalls(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    callQueue.async { [weak self] in
      guard let self = self else {
        DispatchQueue.main.async {
          reject("INTERNAL_ERROR", "Module deallocated", nil)
        }
        return
      }

      let uuids = Array(self.activeCalls.keys).map { $0.uuidString }
      DispatchQueue.main.async {
        resolve([
          "activeCalls": uuids,
          "count": uuids.count
        ])
      }
    }
  }
}

// MARK: - CXProviderDelegate

extension CallKitModule: CXProviderDelegate {
  func providerDidReset(_ provider: CXProvider) {
    callQueue.async { [weak self] in
      self?.activeCalls.removeAll()
      DispatchQueue.main.async {
        self?.sendEvent(withName: "onProviderReset", body: [:])
      }
    }
  }

  func provider(
    _ provider: CXProvider,
    perform action: CXStartCallAction
  ) {
    callQueue.async { [weak self] in
      guard let self = self else { return }

      do {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(
          .playAndRecord,
          mode: .voiceChat,
          options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]
        )
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

        DispatchQueue.main.async {
          self.sendEvent(withName: "onStartCall", body: [
            "uuid": action.callUUID.uuidString,
            "handle": action.handle.value
          ])
        }
        action.fulfill()
      } catch {
        action.fail()
        DispatchQueue.main.async {
          self.sendEvent(withName: "onCallError", body: [
            "uuid": action.callUUID.uuidString,
            "error": error.localizedDescription
          ])
        }
      }
    }
  }

  func provider(
    _ provider: CXProvider,
    perform action: CXAnswerCallAction
  ) {
    callQueue.async { [weak self] in
      guard let self = self else { return }

      do {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(
          .playAndRecord,
          mode: .voiceChat,
          options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]
        )
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

        DispatchQueue.main.async {
          self.sendEvent(withName: "onCallAnswered", body: [
            "uuid": action.callUUID.uuidString
          ])
        }
        action.fulfill()
      } catch {
        action.fail()
        DispatchQueue.main.async {
          self.sendEvent(withName: "onCallError", body: [
            "uuid": action.callUUID.uuidString,
            "error": error.localizedDescription
          ])
        }
      }
    }
  }

  func provider(
    _ provider: CXProvider,
    perform action: CXEndCallAction
  ) {
    callQueue.async { [weak self] in
      guard let self = self else { return }

      self.activeCalls.removeValue(forKey: action.callUUID)

      DispatchQueue.main.async {
        self.sendEvent(withName: "onCallEnded", body: [
          "uuid": action.callUUID.uuidString
        ])
      }

      do {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setActive(false, options: .notifyOthersOnDeactivation)
      } catch {
        DispatchQueue.main.async {
          self.sendEvent(withName: "onCallError", body: [
            "uuid": action.callUUID.uuidString,
            "error": error.localizedDescription
          ])
        }
      }

      action.fulfill()
    }
  }

  func provider(
    _ provider: CXProvider,
    perform action: CXSetMutedCallAction
  ) {
    callQueue.async { [weak self] in
      guard let self = self else { return }

      DispatchQueue.main.async {
        self.sendEvent(withName: "onCallMuted", body: [
          "uuid": action.callUUID.uuidString,
          "muted": action.isMuted
        ])
      }

      action.fulfill()
    }
  }

  func provider(
    _ provider: CXProvider,
    perform action: CXSetHeldCallAction
  ) {
    callQueue.async { [weak self] in
      guard let self = self else { return }

      DispatchQueue.main.async {
        self.sendEvent(withName: "onCallHeld", body: [
          "uuid": action.callUUID.uuidString,
          "held": action.isOnHold
        ])
      }

      action.fulfill()
    }
  }

  func provider(
    _ provider: CXProvider,
    didActivate audioSession: AVAudioSession
  ) {
    callQueue.async { [weak self] in
      DispatchQueue.main.async {
        self?.sendEvent(withName: "onAudioSessionActivated", body: [:])
      }
    }
  }

  func provider(
    _ provider: CXProvider,
    didDeactivate audioSession: AVAudioSession
  ) {
    callQueue.async { [weak self] in
      DispatchQueue.main.async {
        self?.sendEvent(withName: "onAudioSessionDeactivated", body: [:])
      }
    }
  }
}
