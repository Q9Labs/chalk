#!/usr/bin/env ruby
# Recreates the Chalk iOS ReplayKit Broadcast Upload Extension target if Xcode/Expo prebuild
# ever strips it out. Safe to re-run; the script is intentionally idempotent.
# Checklist:
# 1. Ensure `apps/mobile/ios/ChalkScreenShare/*` files exist first.
# 2. Run this script before `pod install` if the target is missing.
# 3. Re-run `pod install` after target changes so CocoaPods attaches the extension pods/phases.

require "xcodeproj"

ROOT = File.expand_path("..", __dir__)
PROJECT_PATH = File.join(ROOT, "apps/mobile/ios/Chalk.xcodeproj")
APP_TARGET_NAME = "Chalk"
EXTENSION_TARGET_NAME = "ChalkScreenShare"
EXTENSION_GROUP_NAME = "ChalkScreenShare"
EXTENSION_BUNDLE_ID = "ai.q9labs.chalk.mobile.screenshare"
DEVELOPMENT_TEAM = "5K9635LZ6F"
IOS_DEPLOYMENT_TARGET = "15.1"
MARKETING_VERSION = "1.0"
CURRENT_PROJECT_VERSION = "17"

project = Xcodeproj::Project.open(PROJECT_PATH)
app_target = project.targets.find { |target| target.name == APP_TARGET_NAME }
abort("Could not find #{APP_TARGET_NAME} target in #{PROJECT_PATH}") unless app_target

target_attributes = project.root_object.attributes["TargetAttributes"] ||= {}
app_target_attributes = target_attributes[app_target.uuid] ||= {}
app_target_attributes["DevelopmentTeam"] = DEVELOPMENT_TEAM
app_target_attributes["ProvisioningStyle"] = "Automatic"
app_target_attributes["SystemCapabilities"] ||= {}
app_target_attributes["SystemCapabilities"]["com.apple.ApplicationGroups.iOS"] = { "enabled" => 1 }

extension_group = project.main_group.find_subpath(EXTENSION_GROUP_NAME, true)
extension_group.set_source_tree("<group>")

def ensure_file_reference(group, relative_path)
  group.files.find { |file| file.path == relative_path } || group.new_file(relative_path)
end

sample_handler_ref = ensure_file_reference(extension_group, "#{EXTENSION_GROUP_NAME}/SampleHandler.swift")
ensure_file_reference(extension_group, "#{EXTENSION_GROUP_NAME}/Info.plist")
ensure_file_reference(extension_group, "#{EXTENSION_GROUP_NAME}/ChalkScreenShare.entitlements")

extension_target = project.targets.find { |target| target.name == EXTENSION_TARGET_NAME }
unless extension_target
  extension_target = project.new_target(:app_extension, EXTENSION_TARGET_NAME, :ios, IOS_DEPLOYMENT_TARGET)
end

extension_target_attributes = target_attributes[extension_target.uuid] ||= {}
extension_target_attributes["DevelopmentTeam"] = DEVELOPMENT_TEAM
extension_target_attributes["ProvisioningStyle"] = "Automatic"
extension_target_attributes["SystemCapabilities"] ||= {}
extension_target_attributes["SystemCapabilities"]["com.apple.ApplicationGroups.iOS"] = { "enabled" => 1 }

extension_target.build_configurations.each do |config|
  settings = config.build_settings
  settings["APPLICATION_EXTENSION_API_ONLY"] = "YES"
  settings["CODE_SIGN_ENTITLEMENTS"] = "#{EXTENSION_GROUP_NAME}/ChalkScreenShare.entitlements"
  settings["CODE_SIGN_STYLE"] = "Automatic"
  settings["CURRENT_PROJECT_VERSION"] = CURRENT_PROJECT_VERSION
  settings["DEVELOPMENT_TEAM"] = DEVELOPMENT_TEAM
  settings["GENERATE_INFOPLIST_FILE"] = "NO"
  settings["INFOPLIST_FILE"] = "#{EXTENSION_GROUP_NAME}/Info.plist"
  settings["IPHONEOS_DEPLOYMENT_TARGET"] = IOS_DEPLOYMENT_TARGET
  settings["LD_RUNPATH_SEARCH_PATHS"] = ["$(inherited)", "@executable_path/Frameworks", "@executable_path/../../Frameworks"]
  settings["MARKETING_VERSION"] = MARKETING_VERSION
  settings["PRODUCT_BUNDLE_IDENTIFIER"] = EXTENSION_BUNDLE_ID
  settings["PRODUCT_NAME"] = EXTENSION_TARGET_NAME
  settings["SKIP_INSTALL"] = "YES"
  settings["SWIFT_VERSION"] = "5.0"
  settings["TARGETED_DEVICE_FAMILY"] = "1,2"
end

unless extension_target.source_build_phase.files_references.include?(sample_handler_ref)
  extension_target.source_build_phase.add_file_reference(sample_handler_ref, true)
end

embed_phase = app_target.copy_files_build_phases.find { |phase| phase.name == "Embed App Extensions" } || app_target.new_copy_files_build_phase("Embed App Extensions")
embed_phase.dst_subfolder_spec = "13"
unless embed_phase.files_references.include?(extension_target.product_reference)
  embed_phase.add_file_reference(extension_target.product_reference, true)
end

unless app_target.dependencies.any? { |dependency| dependency.target == extension_target }
  app_target.add_dependency(extension_target)
end

project.save
