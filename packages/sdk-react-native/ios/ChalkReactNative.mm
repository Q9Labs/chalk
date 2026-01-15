#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(AudioSessionModule, NSObject)

RCT_EXTERN_METHOD(
  configureForCall:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  setOutputRoute:(NSString *)route
  resolve:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  getAvailableRoutes:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  getCurrentRoute:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  setSpeakerphone:(BOOL)enabled
  resolve:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

@end

@interface RCT_EXTERN_MODULE(CallKitModule, NSObject)

RCT_EXTERN_METHOD(
  reportIncomingCall:(NSString *)uuid
  handle:(NSString *)handle
  displayName:(NSString *)displayName
  hasVideo:(BOOL)hasVideo
  resolve:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  reportOutgoingCall:(NSString *)uuid
  handle:(NSString *)handle
  resolve:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  reportCallConnected:(NSString *)uuid
  resolve:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  reportCallEnded:(NSString *)uuid
  reason:(NSString *)reason
  resolve:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  setCallMuted:(NSString *)uuid
  muted:(BOOL)muted
  resolve:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  setCallHeld:(NSString *)uuid
  held:(BOOL)held
  resolve:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  endCall:(NSString *)uuid
  resolve:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  getActiveCalls:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

@end

@interface RCT_EXTERN_MODULE(PermissionsModule, NSObject)

RCT_EXTERN_METHOD(
  checkCameraPermission:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  checkMicrophonePermission:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  checkPermissions:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  requestCameraPermission:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  requestMicrophonePermission:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

@end
