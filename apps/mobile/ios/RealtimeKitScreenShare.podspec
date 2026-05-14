Pod::Spec.new do |s|
  s.name = "RealtimeKitScreenShare"
  s.version = "0.3.1"
  s.summary = "ReplayKit extension-safe screenshare handler for Chalk iOS broadcast upload extension."
  s.description = "Extension-safe subset of @cloudflare/realtimekit-react-native iOS sources used by ChalkScreenShare."
  s.homepage = "https://realtime.cloudflare.com"
  s.license = { :type => "UNLICENSED", :text => "Bundled extension-safe subset of @cloudflare/realtimekit-react-native." }
  s.authors = "Cloudflare"
  s.swift_version = "5.0"
  s.platforms = { :ios => "15.1" }
  s.static_framework = true
  s.module_name = "RealtimeKitScreenShare"

  s.source = { :git => "https://github.com/cloudflare/realtimekit-react-native.git", :tag => s.version.to_s }
  s.source_files = "RealtimeKitScreenShare/Sources/**/*.{swift}"

  # Keep this pod extension-safe by default.
  s.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
    "APPLICATION_EXTENSION_API_ONLY" => "YES",
  }
end
