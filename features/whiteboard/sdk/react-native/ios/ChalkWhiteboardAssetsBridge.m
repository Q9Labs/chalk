#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ChalkWhiteboardAssets, NSObject)

RCT_EXTERN_METHOD(
  rendererURL:(RCTPromiseResolveBlock)resolve
  rejecter:(RCTPromiseRejectBlock)reject
)

@end
