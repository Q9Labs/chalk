Pod::Spec.new do |s|
  s.name         = "ChalkReactNative"
  s.version      = "0.0.17"
  s.summary      = "Chalk video conferencing SDK for React Native"
  s.homepage     = "https://github.com/q9labs/chalk"
  s.license      = { :type => "MIT", :file => "LICENSE" }
  s.author       = { "Q9 Labs" => "engineering@q9labs.com" }
  s.platform     = :ios, "13.0"
  s.source       = { :git => "https://github.com/q9labs/chalk.git", :tag => "v#{s.version}" }

  s.source_files = "*.{h,m,mm,swift}"
  s.swift_version = "5.0"

  s.dependency "React-Core"

  s.pod_target_xcconfig = {
    "CLANG_CXX_LANGUAGE_DIALECT" => "c++17",
    "GCC_ENABLE_OBJC_WEAK" => "YES"
  }
end
