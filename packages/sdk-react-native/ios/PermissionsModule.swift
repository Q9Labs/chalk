import AVFoundation
import React

@objc(PermissionsModule)
class PermissionsModule: NSObject {

  @objc
  static func requiresMainQueueSetup() -> Bool {
    return true
  }

  @objc
  func checkCameraPermission(_ resolve: @escaping RCTPromiseResolveBlock,
                             reject: @escaping RCTPromiseRejectBlock) {
    let status = AVCaptureDevice.authorizationStatus(for: .video)
    resolve(statusToString(status))
  }

  @objc
  func checkMicrophonePermission(_ resolve: @escaping RCTPromiseResolveBlock,
                                  reject: @escaping RCTPromiseRejectBlock) {
    let status = AVCaptureDevice.authorizationStatus(for: .audio)
    resolve(statusToString(status))
  }

  @objc
  func checkPermissions(_ resolve: @escaping RCTPromiseResolveBlock,
                        reject: @escaping RCTPromiseRejectBlock) {
    let cameraStatus = AVCaptureDevice.authorizationStatus(for: .video)
    let microphoneStatus = AVCaptureDevice.authorizationStatus(for: .audio)

    resolve([
      "camera": statusToString(cameraStatus),
      "microphone": statusToString(microphoneStatus)
    ])
  }

  @objc
  func requestCameraPermission(_ resolve: @escaping RCTPromiseResolveBlock,
                               reject: @escaping RCTPromiseRejectBlock) {
    AVCaptureDevice.requestAccess(for: .video) { granted in
      let status = AVCaptureDevice.authorizationStatus(for: .video)
      resolve(self.statusToString(status))
    }
  }

  @objc
  func requestMicrophonePermission(_ resolve: @escaping RCTPromiseResolveBlock,
                                    reject: @escaping RCTPromiseRejectBlock) {
    AVCaptureDevice.requestAccess(for: .audio) { granted in
      let status = AVCaptureDevice.authorizationStatus(for: .audio)
      resolve(self.statusToString(status))
    }
  }

  private func statusToString(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .notDetermined:
      return "undetermined"
    case .restricted:
      return "unavailable"
    case .denied:
      return "denied"
    case .authorized:
      return "granted"
    @unknown default:
      return "unavailable"
    }
  }
}
