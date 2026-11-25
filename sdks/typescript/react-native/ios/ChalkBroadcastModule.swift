import Foundation
import React
import ReplayKit
import UIKit

/// Starts the app's ReplayKit broadcast upload extension for a screen share. iOS lets only the
/// system broadcast picker start a broadcast, so `start` opens that picker with the app's
/// extension preselected and resolves when the extension posts `<extension id>.started`.
/// The picker gives no cancel callback: when the app comes back to the front without a started
/// broadcast, or nothing starts within a minute, the request fails as `NotAllowedError`, the
/// same code a declined Android or browser picker produces.
@objc(ChalkBroadcastModule)
final class ChalkBroadcastModule: NSObject {
  private static let startTimeout: TimeInterval = 60
  /// The picker's countdown runs for three seconds after Start Broadcast, and the person may
  /// close the sheet during it.
  private static let returnGrace: TimeInterval = 4

  private struct Pending {
    let resolve: RCTPromiseResolveBlock
    let reject: RCTPromiseRejectBlock
    let timeout: DispatchWorkItem
  }

  private let extensionId = Bundle.main.object(forInfoDictionaryKey: "RTCScreenSharingExtension") as? String
  private let appGroup = Bundle.main.object(forInfoDictionaryKey: "RTCAppGroupIdentifier") as? String
  private var pending: Pending?
  private var resignedWhilePending = false
  private var observers: [NSObjectProtocol] = []

  override init() {
    super.init()
    guard let extensionId else { return }
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      Unmanaged.passUnretained(self).toOpaque(),
      { _, observer, _, _, _ in
        guard let observer else { return }
        let module = Unmanaged<ChalkBroadcastModule>.fromOpaque(observer).takeUnretainedValue()
        DispatchQueue.main.async { module.broadcastStarted() }
      },
      "\(extensionId).started" as CFString,
      nil,
      .deliverImmediately
    )
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
      if self?.pending != nil { self?.resignedWhilePending = true }
    })
    observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.returnedToApp()
    })
  }

  deinit {
    CFNotificationCenterRemoveEveryObserver(CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque())
    observers.forEach(NotificationCenter.default.removeObserver)
  }

  @objc static func requiresMainQueueSetup() -> Bool {
    true
  }

  @objc func constantsToExport() -> [AnyHashable: Any]! {
    ["available": available]
  }

  private var available: Bool {
    #if targetEnvironment(simulator)
      return false
    #else
      return extensionId != nil && appGroup != nil
    #endif
  }

  @objc(start:rejecter:)
  func start(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async { [self] in
      guard available, let extensionId else {
        reject("NotSupportedError", "This build can't share the screen. It needs a physical device and Chalk's broadcast extension.", nil)
        return
      }
      if pending != nil {
        reject("InvalidStateError", "A screen share is already being started.", nil)
        return
      }
      let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
      picker.preferredExtension = extensionId
      picker.showsMicrophoneButton = false
      guard let button = picker.subviews.compactMap({ $0 as? UIButton }).first else {
        reject("NotSupportedError", "The iOS broadcast picker is unavailable.", nil)
        return
      }
      let timeout = DispatchWorkItem { [weak self] in self?.fail() }
      pending = Pending(resolve: resolve, reject: reject, timeout: timeout)
      resignedWhilePending = false
      DispatchQueue.main.asyncAfter(deadline: .now() + Self.startTimeout, execute: timeout)
      button.sendActions(for: .touchUpInside)
    }
  }

  private func broadcastStarted() {
    guard let pending = take() else { return }
    pending.resolve(nil)
  }

  private func returnedToApp() {
    guard pending != nil, resignedWhilePending else { return }
    let request = pending?.timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.returnGrace) { [weak self] in
      guard let self, self.pending?.timeout === request else { return }
      self.fail()
    }
  }

  private func fail() {
    guard let pending = take() else { return }
    pending.reject("NotAllowedError", "Screen sharing was cancelled.", nil)
  }

  private func take() -> Pending? {
    guard let current = pending else { return nil }
    current.timeout.cancel()
    pending = nil
    resignedWhilePending = false
    return current
  }
}
