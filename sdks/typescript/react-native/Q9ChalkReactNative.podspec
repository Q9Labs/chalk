require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |spec|
  spec.name = "Q9ChalkReactNative"
  spec.version = package["version"]
  spec.summary = "Native iOS support for Chalk React Native CallKit and PiP."
  spec.homepage = "https://github.com/Q9Labs/chalk"
  spec.license = package["license"] || "UNLICENSED"
  spec.authors = { "Q9Labs" => "opensource@q9labs.ai" }
  spec.platforms = { :ios => "15.1" }
  spec.source = { :git => "https://github.com/Q9Labs/chalk.git", :tag => spec.version.to_s }
  spec.source_files = "ios/**/*.{h,m,mm,swift}"
  spec.requires_arc = true
  spec.swift_version = "5.0"
  spec.frameworks = ["AVFoundation", "AVKit", "CallKit"]
  spec.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
    "SWIFT_COMPILATION_MODE" => "wholemodule"
  }

  spec.dependency "React-Core"
  spec.dependency "RTKWebRTC"
end
