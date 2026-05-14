import AVFoundation
import CallKit
import Foundation
import UIKit

final class ChalkCallKitManager: NSObject, CXProviderDelegate {
  static let shared = ChalkCallKitManager()

  private let callController = CXCallController()
  private var activeCallUUID: UUID?
  private var configuration = ChalkCallKitProviderConfiguration()
  private var eventHandler: (([String: Any]) -> Void)?
  private var locallyEndedCalls = Set<UUID>()
  private var provider: CXProvider?

  private override init() {
    super.init()
    provider = makeProvider()
  }

  var isSupported: Bool {
#if targetEnvironment(simulator)
    return false
#else
    return true
#endif
  }

  func setEventHandler(_ handler: (([String: Any]) -> Void)?) {
    eventHandler = handler
  }

  func configure(with rawOptions: [String: Any]) -> [String: Any] {
    configuration = ChalkCallKitProviderConfiguration(rawOptions)
    rebuildProvider()
    return ["isSupported": isSupported]
  }

  func startCall(with rawOptions: [String: Any], completion: @escaping (Result<[String: Any], Error>) -> Void) {
    guard isSupported else {
      completion(.success(["callUUID": ""]))
      return
    }

    let options = ChalkCallKitCallOptions(rawOptions, fallbackUUID: activeCallUUID)
    let uuid = options.callUUID
    activeCallUUID = uuid

    let action = CXStartCallAction(call: uuid, handle: options.handle)
    action.isVideo = options.hasVideo
    let transaction = CXTransaction(action: action)

    request(transaction) { [weak self] result in
      switch result {
      case .failure(let error):
        completion(.failure(error))
      case .success:
        self?.provider?.reportCall(with: uuid, updated: options.makeUpdate())
        self?.provider?.reportOutgoingCall(with: uuid, startedConnectingAt: Date())
        completion(.success(["callUUID": uuid.uuidString]))
      }
    }
  }

  func reportIncomingCall(with rawOptions: [String: Any], completion: @escaping (Result<[String: Any], Error>) -> Void) {
    guard isSupported else {
      completion(.success(["callUUID": ""]))
      return
    }

    let options = ChalkCallKitCallOptions(rawOptions, fallbackUUID: activeCallUUID)
    let uuid = options.callUUID
    activeCallUUID = uuid

    provider?.reportNewIncomingCall(with: uuid, update: options.makeUpdate()) { [weak self] error in
      if let error {
        completion(.failure(error))
        return
      }

      self?.activeCallUUID = uuid
      completion(.success(["callUUID": uuid.uuidString]))
    }
  }

  func reportConnected(with rawOptions: [String: Any]) throws {
    guard isSupported else {
      return
    }

    let options = ChalkCallKitCallOptions(rawOptions, fallbackUUID: activeCallUUID)
    provider?.reportOutgoingCall(with: options.callUUID, connectedAt: Date())
  }

  func updateCall(with rawOptions: [String: Any]) throws {
    guard isSupported else {
      return
    }

    let options = ChalkCallKitCallOptions(rawOptions, fallbackUUID: activeCallUUID)
    provider?.reportCall(with: options.callUUID, updated: options.makeUpdate())
  }

  func endCall(with rawOptions: [String: Any], completion: @escaping (Result<Void, Error>) -> Void) {
    guard isSupported else {
      completion(.success(()))
      return
    }

    do {
      let options = try ChalkCallKitEndCallOptions(rawOptions, fallbackUUID: activeCallUUID)
      locallyEndedCalls.insert(options.callUUID)

      let transaction = CXTransaction(action: CXEndCallAction(call: options.callUUID))
      request(transaction) { [weak self] result in
        if case .success = result {
          self?.clearActiveCallIfNeeded(options.callUUID)
        } else {
          self?.locallyEndedCalls.remove(options.callUUID)
        }

        switch result {
        case .failure(let error):
          completion(.failure(error))
        case .success:
          completion(.success(()))
        }
      }
    } catch {
      completion(.failure(error))
    }
  }

  func endAllCalls() {
    guard let activeCallUUID else {
      return
    }

    locallyEndedCalls.insert(activeCallUUID)
    let transaction = CXTransaction(action: CXEndCallAction(call: activeCallUUID))
    request(transaction) { [weak self] result in
      if case .failure = result {
        self?.locallyEndedCalls.remove(activeCallUUID)
        return
      }

      self?.clearActiveCallIfNeeded(activeCallUUID)
    }
  }

  func providerDidReset(_ provider: CXProvider) {
    activeCallUUID = nil
    locallyEndedCalls.removeAll()
    emit(["type": "providerReset"])
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    activeCallUUID = action.callUUID
    emit([
      "callUUID": action.callUUID.uuidString,
      "type": "answerCallAction",
    ])
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    let callUUID = action.callUUID
    let wasLocalEnd = locallyEndedCalls.remove(callUUID) != nil
    clearActiveCallIfNeeded(callUUID)
    action.fulfill()

    if !wasLocalEnd {
      emit([
        "callUUID": callUUID.uuidString,
        "type": "endCallAction",
      ])
    }
  }

  func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
    action.fail()
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    emit([
      "callUUID": action.callUUID.uuidString,
      "muted": action.isMuted,
      "type": "setMutedCallAction",
    ])
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    activeCallUUID = action.callUUID
    provider.reportCall(with: action.callUUID, updated: ChalkCallKitCallOptions([
      "callUUID": action.callUUID.uuidString,
      "handle": action.handle.value,
      "hasVideo": action.isVideo,
    ], fallbackUUID: action.callUUID).makeUpdate())
    action.fulfill()
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    emit(["type": "audioSessionActivated"])
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    emit(["type": "audioSessionDeactivated"])
  }

  private func clearActiveCallIfNeeded(_ uuid: UUID) {
    if activeCallUUID == uuid {
      activeCallUUID = nil
    }
  }

  private func emit(_ payload: [String: Any]) {
    eventHandler?(payload)
  }

  private func makeProvider() -> CXProvider {
    let provider = CXProvider(configuration: configuration.makeCXProviderConfiguration())
    provider.setDelegate(self, queue: nil)
    return provider
  }

  private func rebuildProvider() {
    provider?.invalidate()
    provider = makeProvider()
  }

  private func request(_ transaction: CXTransaction, completion: @escaping (Result<Void, Error>) -> Void) {
    callController.request(transaction) { error in
      if let error {
        completion(.failure(error))
        return
      }

      completion(.success(()))
    }
  }
}

private struct ChalkCallKitProviderConfiguration {
  var appName = "Chalk"
  var iconTemplateImageName: String?
  var includesCallsInRecents = false
  var maximumCallGroups = 1
  var maximumCallsPerCallGroup = 1
  var ringtoneSound: String?

  init() {}

  init(_ rawOptions: [String: Any]) {
    if let appName = rawOptions["appName"] as? String, !appName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      self.appName = appName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    if let iconTemplateImageName = rawOptions["iconTemplateImageName"] as? String, !iconTemplateImageName.isEmpty {
      self.iconTemplateImageName = iconTemplateImageName
    }

    if let includesCallsInRecents = rawOptions["includesCallsInRecents"] as? Bool {
      self.includesCallsInRecents = includesCallsInRecents
    }

    if let maximumCallGroups = rawOptions["maximumCallGroups"] as? NSNumber {
      self.maximumCallGroups = max(1, maximumCallGroups.intValue)
    }

    if let maximumCallsPerCallGroup = rawOptions["maximumCallsPerCallGroup"] as? NSNumber {
      self.maximumCallsPerCallGroup = max(1, maximumCallsPerCallGroup.intValue)
    }

    if let ringtoneSound = rawOptions["ringtoneSound"] as? String, !ringtoneSound.isEmpty {
      self.ringtoneSound = ringtoneSound
    }
  }

  func makeCXProviderConfiguration() -> CXProviderConfiguration {
    let providerConfiguration = CXProviderConfiguration(localizedName: appName)
    providerConfiguration.includesCallsInRecents = includesCallsInRecents
    providerConfiguration.maximumCallGroups = maximumCallGroups
    providerConfiguration.maximumCallsPerCallGroup = maximumCallsPerCallGroup
    providerConfiguration.supportedHandleTypes = [.emailAddress, .generic, .phoneNumber]

    if let ringtoneSound, !ringtoneSound.isEmpty {
      providerConfiguration.ringtoneSound = ringtoneSound
    }

    if let iconTemplateImageName,
       let image = UIImage(named: iconTemplateImageName),
       let iconData = image.pngData() {
      providerConfiguration.iconTemplateImageData = iconData
    }

    return providerConfiguration
  }
}

private struct ChalkCallKitCallOptions {
  let callUUID: UUID
  let displayName: String?
  let handle: CXHandle
  let hasVideo: Bool
  let supportsDTMF: Bool
  let supportsGrouping: Bool
  let supportsHolding: Bool
  let supportsUngrouping: Bool

  init(_ rawOptions: [String: Any], fallbackUUID: UUID?) {
    let displayName = (rawOptions["displayName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    let handleValue = (rawOptions["handle"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    let handleType = ChalkCallKitHandleType(rawValue: rawOptions["handleType"] as? String ?? "") ?? .generic

    if let callUUID = rawOptions["callUUID"] as? String,
       let parsedUUID = UUID(uuidString: callUUID) {
      self.callUUID = parsedUUID
    } else if let fallbackUUID {
      self.callUUID = fallbackUUID
    } else {
      self.callUUID = UUID()
    }

    self.displayName = displayName?.isEmpty == false ? displayName : nil
    self.handle = CXHandle(type: handleType.cxHandleType, value: handleValue?.isEmpty == false ? handleValue! : self.callUUID.uuidString)
    self.hasVideo = rawOptions["hasVideo"] as? Bool ?? true
    self.supportsDTMF = rawOptions["supportsDTMF"] as? Bool ?? false
    self.supportsGrouping = rawOptions["supportsGrouping"] as? Bool ?? false
    self.supportsHolding = rawOptions["supportsHolding"] as? Bool ?? false
    self.supportsUngrouping = rawOptions["supportsUngrouping"] as? Bool ?? false
  }

  func makeUpdate() -> CXCallUpdate {
    let update = CXCallUpdate()
    update.localizedCallerName = displayName
    update.remoteHandle = handle
    update.hasVideo = hasVideo
    update.supportsDTMF = supportsDTMF
    update.supportsGrouping = supportsGrouping
    update.supportsHolding = supportsHolding
    update.supportsUngrouping = supportsUngrouping
    return update
  }
}

private struct ChalkCallKitEndCallOptions {
  let callUUID: UUID

  init(_ rawOptions: [String: Any], fallbackUUID: UUID?) throws {
    if let callUUID = rawOptions["callUUID"] as? String,
       let parsedUUID = UUID(uuidString: callUUID) {
      self.callUUID = parsedUUID
      return
    }

    if let fallbackUUID {
      self.callUUID = fallbackUUID
      return
    }

    throw NSError(
      domain: "ChalkCallKitModule",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "No active CallKit call is available to end."],
    )
  }
}

private enum ChalkCallKitHandleType: String {
  case emailAddress
  case generic
  case phoneNumber

  var cxHandleType: CXHandle.HandleType {
    switch self {
    case .emailAddress:
      return .emailAddress
    case .phoneNumber:
      return .phoneNumber
    case .generic:
      return .generic
    }
  }
}
