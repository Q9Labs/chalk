import Foundation
import React

@objc(ChalkCallKitModule)
final class ChalkCallKitModule: RCTEventEmitter {
  private let eventName = "ChalkCallKitEvent"
  private let manager = ChalkCallKitManager.shared

  override init() {
    super.init()
  }

  override class func requiresMainQueueSetup() -> Bool {
    true
  }

  override func constantsToExport() -> [AnyHashable: Any]! {
    [
      "eventName": eventName,
      "isSupported": manager.isSupported,
    ]
  }

  override func supportedEvents() -> [String]! {
    [eventName]
  }

  override func startObserving() {
    manager.setEventHandler { [weak self] payload in
      self?.sendEvent(withName: self?.eventName ?? "ChalkCallKitEvent", body: payload)
    }
  }

  override func stopObserving() {
    manager.setEventHandler(nil)
  }

  @objc(configure:resolver:rejecter:)
  func configure(_ options: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    runOnMain(resolve: resolve, reject: reject) {
      self.manager.configure(with: options as? [String: Any] ?? [:])
    }
  }

  @objc(startCall:resolver:rejecter:)
  func startCall(_ options: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      self.manager.startCall(with: options as? [String: Any] ?? [:]) { result in
        switch result {
        case .failure(let error):
          reject("callkit_start_failed", error.localizedDescription, error)
        case .success(let payload):
          resolve(payload)
        }
      }
    }
  }

  @objc(reportIncomingCall:resolver:rejecter:)
  func reportIncomingCall(_ options: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      self.manager.reportIncomingCall(with: options as? [String: Any] ?? [:]) { result in
        switch result {
        case .failure(let error):
          reject("callkit_incoming_failed", error.localizedDescription, error)
        case .success(let payload):
          resolve(payload)
        }
      }
    }
  }

  @objc(reportConnected:resolver:rejecter:)
  func reportConnected(_ options: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    runOnMain(resolve: resolve, reject: reject) {
      try self.manager.reportConnected(with: options as? [String: Any] ?? [:])
      return nil
    }
  }

  @objc(updateCall:resolver:rejecter:)
  func updateCall(_ options: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    runOnMain(resolve: resolve, reject: reject) {
      try self.manager.updateCall(with: options as? [String: Any] ?? [:])
      return nil
    }
  }

  @objc(endCall:resolver:rejecter:)
  func endCall(_ options: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      self.manager.endCall(with: options as? [String: Any] ?? [:]) { result in
        switch result {
        case .failure(let error):
          reject("callkit_end_failed", error.localizedDescription, error)
        case .success:
          resolve(nil)
        }
      }
    }
  }

  @objc(endAllCalls:rejecter:)
  func endAllCalls(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      self.manager.endAllCalls()
      resolve(nil)
    }
  }

  private func runOnMain(resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock, action: @escaping () throws -> Any?) {
    DispatchQueue.main.async {
      do {
        resolve(try action())
      } catch {
        reject("callkit_error", error.localizedDescription, error)
      }
    }
  }
}
