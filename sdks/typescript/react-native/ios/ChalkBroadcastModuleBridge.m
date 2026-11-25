#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ChalkBroadcastModule, NSObject)

RCT_EXTERN_METHOD(start:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

@end
