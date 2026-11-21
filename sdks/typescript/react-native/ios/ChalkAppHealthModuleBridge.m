#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ChalkAppHealth, NSObject)

RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(markReady:(NSString *)cs)
RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(markFatal:(NSString *)errorName)
RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(markCallEnded)
RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(setAppState:(NSString *)state)
RCT_EXTERN_METHOD(readMarker:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(readExitInfo:(double)pid resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(lowMemory:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(thermalState:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

@end
