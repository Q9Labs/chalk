import Foundation
import React

@objc(ChalkWhiteboardAssets)
final class ChalkWhiteboardAssets: NSObject {
  @objc
  static func requiresMainQueueSetup() -> Bool {
    false
  }

  @objc(rendererURL:rejecter:)
  func rendererURL(
    _ resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    let ownerBundle = Bundle(for: ChalkWhiteboardAssets.self)
    let candidates = [
      ownerBundle.url(forResource: "ChalkWhiteboard", withExtension: "bundle"),
      ownerBundle.resourceURL?.appendingPathComponent("ChalkWhiteboard.bundle"),
      Bundle.main.url(forResource: "ChalkWhiteboard", withExtension: "bundle"),
    ]

    for candidate in candidates.compactMap({ $0 }) {
      guard let resources = Bundle(url: candidate) else { continue }
      if let renderer = resources.url(
        forResource: "index",
        withExtension: "html",
        subdirectory: "chalk-whiteboard"
      ) {
        resolve(renderer.absoluteString)
        return
      }
    }

    reject(
      "renderer_asset_unavailable",
      "ChalkWhiteboard.bundle does not contain chalk-whiteboard/index.html",
      nil
    )
  }
}
