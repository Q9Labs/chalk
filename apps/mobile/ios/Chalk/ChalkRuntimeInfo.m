#import <TargetConditionals.h>

#import <React/RCTBridgeModule.h>

@interface ChalkRuntimeInfo : NSObject <RCTBridgeModule>
@end

@implementation ChalkRuntimeInfo

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (NSDictionary *)constantsToExport
{
  return @{
    @"isSimulator": @(TARGET_OS_SIMULATOR),
  };
}

@end
