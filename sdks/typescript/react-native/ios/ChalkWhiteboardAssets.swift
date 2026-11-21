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
    resolveRenderer(bundleName: "ChalkWhiteboard", folder: "chalk-whiteboard", resolve: resolve, reject: reject)
  }

  @objc(annotationRendererURL:rejecter:)
  func annotationRendererURL(
    _ resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    resolveRenderer(bundleName: "ChalkAnnotation", folder: "chalk-annotation", resolve: resolve, reject: reject)
  }

  private func resolveRenderer(
    bundleName: String,
    folder: String,
    resolve: RCTPromiseResolveBlock,
    reject: RCTPromiseRejectBlock
  ) {
    let ownerBundle = Bundle(for: ChalkWhiteboardAssets.self)
    let candidates = [
      ownerBundle.url(forResource: bundleName, withExtension: "bundle"),
      ownerBundle.resourceURL?.appendingPathComponent("\(bundleName).bundle"),
      Bundle.main.url(forResource: bundleName, withExtension: "bundle"),
    ]

    for candidate in candidates.compactMap({ $0 }) {
      guard let resources = Bundle(url: candidate) else { continue }
      if let renderer = resources.url(
        forResource: "index",
        withExtension: "html",
        subdirectory: folder
      ) {
        resolve(renderer.absoluteString)
        return
      }
    }

    reject(
      "renderer_asset_unavailable",
      "\(bundleName).bundle does not contain \(folder)/index.html",
      nil
    )
  }
}
